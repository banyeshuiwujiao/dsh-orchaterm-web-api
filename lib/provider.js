// dsh-orchaterm-web-api —— 把 OrcaTerm（腾讯云智能终端）的私有 API 反代接入 DSH 模型选择器。
//
// 与 dsh-minimax-web-api 同构，差异只在两处：
//   · 上游是谁：OrcaTerm 有两条私有通道（CGI action 表 + Assistant SSE），不是 OpenAI 兼容口；
//   · 后端在哪：minimax/deepseek 的后端是**外部仓库**（要解析目录、建 venv），这里的反代
//     随插件一起发布（backend/run.js，零第三方依赖），所以没有指针文件那一层。
//
// 能力边界（如实申报，见 README「已知限制」）：助手网关本身就是个 Agent，不接受调用方声明
// 外部工具、也不回 OpenAI 的 tool_calls。所以本路由适合当「对话 + 自带终端执行」的模型，
// 不适合当「由 DSH 调度工具」的编码主力。
//
// 分工：本文件只做编排；默认值与目录在 lib/config.js，纯函数在 lib/openai.js，
// 归因头在 lib/kernel.js，进程托管在 lib/server.js，路径在 lib/paths.js，契约在 lib/contract.js。

import { randomBytes } from 'node:crypto'
import { resolveAttributionHeaders } from './kernel.js'
import {
  describeErrorBody,
  estimateInputTokens,
  failureCodeForMessage,
  failureCodeForStatus,
  formatOpenAiMessages,
  formatOpenAiTools,
  retryAfterMs,
} from './openai.js'
import { estimateTokens } from './openai.js'
import { createContextTracker } from './context.js'
import { createBackendManager } from './server.js'
import { DEFAULTS, KNOWN_MODELS, PROVIDER_ID, PROVIDER_LABEL, managerKeyOf } from './config.js'

export const name = 'dsh-orchaterm-web-api-provider'
export const inject = ['llm']
export { PROVIDER_ID, PROVIDER_LABEL, KNOWN_MODELS, DEFAULTS }

/** 该模型是否是思考变体（仅用于选择器展示与日志）。 */
export function resolveThinkingEnabled(model) {
  const known = KNOWN_MODELS.find((m) => m.id === model)
  if (known) return known.thinking === true
  return /thinking|reasoner|t1|r1/i.test(String(model))
}

/** 思考档位的申报顺序与展示名：与 OrcaTerm 客户端一致（Off → Low → High → Max）。 */
const THINKING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LABELS = Object.freeze({
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
})

/**
 * 某个模型在 DSH 模型选择器里应展示的思考档位。
 *
 * OrcaTerm 客户端把「思考模式」拆成开关 + 档位：有开关的模型能整体关掉思考
 * （映射为选择器里的 Off，线上发 reasoning_effort:"none"），没有开关的模型只能选档位。
 * 目录里没有收录的模型不申报 —— 避免给出上游其实不认的档位。
 *
 * @param {string} model 精确模型 id
 * @returns {{ efforts: Array<{ id: string, name: string }>, defaultEffort?: string } | undefined}
 */
export function reasoningMetadataOf(model) {
  const known = KNOWN_MODELS.find((m) => m.id === model)
  if (!known || known.thinking !== true) return undefined
  const levels = new Set(Array.isArray(known.thinkingLevels) ? known.thinkingLevels : [])
  if (known.thinkingOff === true) levels.add('off')
  const ordered = THINKING_ORDER.filter((level) => levels.has(level))
  // 只有 Off 一档等于「没有可选的思考强度」，不申报。
  if (!ordered.some((level) => level !== 'off')) return undefined
  const efforts = ordered.map((id) => ({ id, name: THINKING_LABELS[id] || id }))
  const defaultEffort = efforts.some((effort) => effort.id === 'high')
    ? 'high'
    : efforts.find((effort) => effort.id !== 'off')?.id
  return { efforts, ...(defaultEffort ? { defaultEffort } : {}) }
}

/**
 * LlmAdapter 实现。配置按调用时读取，不是一次性快照 ——
 * 改 baseUrl/credentialsFile 这类项不必重启客户端。
 */
export class OrcaTermWebApiAdapter {
  /**
   * @param {object | (() => object)} source 配置对象，或返回配置的函数
   * @param {object | null} manager 预置的后端管理器（测试用）
   * @param {object | null} logger 宿主日志
   */
  constructor(source = {}, manager = null, logger = null) {
    this.source = source
    this.logger = logger || (source && source.logger) || null
    this._manager = manager
    this._managerKey = manager ? managerKeyOf(this._read()) : ''
    this.generation = 0
    // 会话映射：DSH 的 sessionId → OrcaTerm 的 conversationId。
    // 上游自己保多轮上下文，映射稳定才能让它在同一会话里续聊而不是每次重开。
    this._conversations = new Map()
    // 每条会话已轮换过几次（压缩/重试/轮数上限都会换新会话，id 要能区分开）。
    this._rotations = new Map()
    // 与 DSH 消息历史对账：判断能否沿用上游上下文，还是需要换新会话并补发历史。
    this._context = createContextTracker()
    this.opts = this._read()
  }

  _read() {
    const raw = typeof this.source === 'function' ? this.source() : this.source
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  }

  /** 取当代配置；管理器相关字段变了就回收旧管理器。 */
  current() {
    const opts = this._read()
    const key = managerKeyOf(opts)
    if (this._manager && key !== this._managerKey) {
      try {
        this._manager.dispose()
      } catch (error) {
        // 旧管理器已经坏了也不能挡住新配置生效
        this.warn(`回收旧后端管理器失败：${error?.message || error}`)
      }
      this._manager = null
      this.warn('配置里与后端进程相关的项已变更，重建后端管理器')
    }
    if (!this._manager) this._manager = createBackendManager(opts, this.logger)
    this._managerKey = key
    this.opts = opts
    return opts
  }

  ensureManager() {
    this.current()
    return this._manager
  }

  dispose() {
    try {
      this._manager?.dispose()
    } catch {
      // 已经坏掉的管理器不该让卸载失败
    }
    this._manager = null
    this._managerKey = ''
    this._conversations.clear()
    this._rotations.clear()
    this._context = createContextTracker()
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_LABEL }
  }

  /**
   * 只把「重试有意义」的码列进来：AUTH / INVALID_REQUEST / CONTEXT_WINDOW_EXCEEDED
   * 每次都会以同样方式失败，重试只是白等退避。
   * assistant 的 NEED_UIN_AND_SKEY 属于 AUTH —— 换登录态才有解，重试没用。
   */
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 1500,
      maxDelayMs: 5000,
      jitterRatio: 0.2,
    }
  }

  /**
   * 宿主契约面：适配器必须实现 LlmAdapter 的全部方法。
   *
   * 这里是**普通 JS 类**（插件不 import 宿主包，所以拿不到 LlmAdapter 基类），
   * 于是基类上的默认实现全部缺失。宿主 LlmRuntime 会**直接调用**注册对象上的
   * `imageRequestPricing()` / `imageRequestTarget()`：前者缺失会让
   * `ctx.llm.imageRequestPricing()` 抛 TypeError，而压缩与 spill 都在这条路上
   * 走（实报：模型切换时 `context compaction failed: ...imageRequestPricing is
   * not a function`，导致 MODEL_SWITCH_COMPACTION_FAILED）。
   *
   * 下面是基类默认实现的等价移植，语义与 `packages/llm/llm/src/index.ts` 一致。
   */

  /**
   * 请求侧图片计价：本路由不按视觉 token 收费（上游是 OrcaTerm 助手网关，
   * 价格由腾讯侧定，客户端拿不到每模型视觉 token 单价），所以声明「无计价器」。
   *
   * 返回 undefined 是基类的默认语义：token meter 会退回自己的中性估算，
   * spill-policy 遇到图片且拿不到计价器时会抛错并保持内联内容（见
   * packages/spill/spill-policy/src/index.ts）。
   *
   * @param {string} _provider 注册的 provider 路由
   * @param {string} _model 精确模型 id
   * @returns {undefined} 本路由不声明图片计价器
   */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /**
   * 请求图片的尺寸与字节目标。本路由不缩放图片，保留归一化后的原图 ——
   * 与基类默认实现一致（`{width: image.width, height: image.height, maxBytes: image.bytes}`）。
   *
   * @param {string} _provider 注册的 provider 路由
   * @param {string} _model 精确模型 id
   * @param {{width:number, height:number, bytes:number}} image 归一化后的图片引用
   * @returns {{width:number, height:number, maxBytes:number}}
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image?.width, height: image?.height, maxBytes: image?.bytes }
  }

  /**
   * 模型目录：优先用后端 /v1/models（含 CGI 里的 BYO 模型与本机默认模型），
   * 拿不到才回落静态清单 —— 选择器不能因为后端还没起来就整组消失。
   */
  async listModels(provider) {
    const opts = this.current()
    try {
      const manager = this.ensureManager()
      await manager.ensure()
      const res = await fetch(`${String(opts.baseUrl).replace(/\/+$/, '')}/v1/models`, {
        // 动态目录是「锦上添花」，不该拖住选择器：上限取探活超时与 10s 的较大值。
        signal: AbortSignal.timeout(Math.max(Number(opts.probeTimeoutMs || 3000), 10000)),
      })
      if (res.ok) {
        const payload = await res.json()
        const list = Array.isArray(payload?.data) ? payload.data : []
        if (list.length > 0) {
          // 过滤掉上游提示尚未加载的模型（如已下线的旧镜像）
          const filtered = list.filter((m) => m && !m.unloaded)
          const target = filtered.length > 0 ? filtered : list
          return target.map((m) => {
            const matched = KNOWN_MODELS.find((k) => k.id === m.id)
            return {
              provider,
              id: String(m.id),
              name: String(m.name || m.id),
              description: String(m.description || m.owned_by || ''),
              inputModalities: matched?.inputModalities || m.modalities || ['text'],
              ...(m.is_default === true ? { isDefault: true } : {}),
            }
          })
        }
      }
    } catch (error) {
      this.debug(`动态模型目录不可用，回落静态清单：${error?.message || error}`)
    }
    return KNOWN_MODELS.map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      description: m.description,
      inputModalities: m.inputModalities || ['text'],
    }))
  }

  /**
   * 解析一个精确模型的元信息。
   *
   * ⚠️ 宿主契约：第三参是 **AbortSignal**（`resolveModel(provider, model, signal)`），
   * 不是配置对象。之前这里把第三参当 `opts` 用，宿主直接调用时拿到的是 signal，
   * 于是 `opts.maxContextWindow` / `opts.defaultMaxTokens` 全是 undefined ——
   * 上下文窗口会退到 128000 兜底值（而不是目录里申报的 1M），压缩线也随之失准。
   * 配置一律从 `this.current()` 取；signal 只用来提前放弃。
   *
   * @param {string} provider provider 路由
   * @param {string} model 精确模型 id
   * @param {AbortSignal} [signal] 取消信号
   */
  async resolveModel(provider, model, signal) {
    if (signal?.aborted === true) throw new Error('orchaterm-web-api: request aborted')
    const opts = this.current()
    const contextWindow = Number(opts.maxContextWindow)
    const defaultMaxTokens = Number(opts.defaultMaxTokens)
    const normalizedId = model === 'deepseek-v3::deepseek-v4.1-flash' ? 'deepseek-v4.1-flash' : model
    const matched = KNOWN_MODELS.find((m) => m.id === normalizedId || m.id === model)
    const label = matched ? matched.name : (model === 'deepseek-v3::deepseek-v4.1-flash' ? 'DeepSeek-V4.1-Flash (默认)' : '')
    const effectiveContext = matched?.contextWindow || (Number.isInteger(contextWindow) && contextWindow > 0 ? contextWindow : 128000)
    // 思考档位：DSH 模型选择器只认 adapter 在 resolveModel 里申报的 reasoning.efforts。
    const reasoning = reasoningMetadataOf(normalizedId) || reasoningMetadataOf(model)
    return {
      provider,
      id: model,
      name: label || `${model} · OrcaTerm 反代`,
      description: matched ? matched.description : '通过 OrcaTerm 助手网关驱动的模型',
      inputModalities: matched?.inputModalities || ['text'],
      context: { contextWindow: effectiveContext },
      ...(reasoning ? { reasoning } : {}),
      ...(Number.isInteger(defaultMaxTokens) && defaultMaxTokens > 0 ? { defaultMaxTokens } : {}),
    }
  }

  /**
   * 客户端 dsh-llm 的适配器必需接口：prepareCall(provider, model, signal) → { model, stream }。
   * 每轮开始时读一次当代配置并记世代，把 stream 绑到这一代上，
   * 避免「准备时用新值、派发时混进旧一代」。
   */
  async prepareCall(provider, model, signal) {
    if (signal?.aborted === true) throw new Error('orchaterm-web-api: request aborted')
    const opts = this.current()
    const manager = this._manager
    this.generation += 1
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(model, options, opts, manager),
    }
  }

  warn(message) {
    const text = `orchaterm-web-api: ${message}`
    if (typeof this.logger?.warn === 'function') this.logger.warn(text)
    else console.warn(text)
  }

  debug(message) {
    const text = `orchaterm-web-api: ${message}`
    if (typeof this.logger?.debug === 'function') this.logger.debug(text)
  }

  /**
   * 会话映射键：优先用 DSH 的 sessionId（同一会话续聊），没有就退回模型可见历史的
   * 首条用户消息指纹 —— 一次性调用（如标题生成）不该污染主会话的上下文。
   */
  conversationKey(options) {
    // 辅助请求（标题生成等）带 purpose 且与主循环共用同一个 sessionId ——
    // 必须隔离到独立的上游会话，否则「生成标题」的指令会插进主对话的工具流程中间，
    // 打乱上游 Agent 的待办状态（session-fb62c7fd 实测：工具结果回来后模型答非所问）。
    if (options?.purpose) {
      const base = options.sessionId ? String(options.sessionId) : hashOf(messageText((options.messages || []).find((m) => m?.role === 'user'))).slice(0, 16)
      return `aux:${String(options.purpose)}:${base}`
    }
    if (options?.sessionId) return `s:${String(options.sessionId)}`
    const first = (Array.isArray(options?.messages) ? options.messages : [])
      .find((m) => m?.role === 'user')
    return `h:${hashOf(messageText(first)).slice(0, 16)}`
  }

  /**
   * 这一轮是不是「上下文压缩摘要」请求。
   *
   * 宿主把压缩摘要作为**辅助 LLM 调用**发出（compaction-basic/src/summarizer.ts:160
   * `purpose: 'compaction'`），消息体是「待压缩的那段对话 + 一条压缩指令」。
   *
   * @param {object} options GenerateOptions
   * @returns {boolean}
   */
  isCompactionRequest(options) {
    return options?.purpose === 'compaction'
  }

  /**
   * 取本轮该用的 conversationId 与「是否补发历史」。
   *
   * `decision` 来自 `lib/context.js` 的对账结果：
   * - `continue` → 沿用上游上下文，**不发历史**（历史会被上游回灌污染正文）；
   * - `fresh` / `resync` → 换一个新会话，并一次性把 DSH 的历史补发上去，
   *   让 DSH 侧的压缩/改写真正同步到上游，同时给上游上下文瘦身。
   *
   * `reuseConversation: false` 是「上游无状态」模式：每轮都换新会话 + 补发完整历史，
   * 上下文完全由 DSH 掌控（代价是每轮都重发历史）。
   *
   * @returns {{conversationId:string, sendHistory:boolean, action:string, reason:string, rounds:number}}
   */
  resolveConversation(opts, options, messages) {
    const key = this.conversationKey(options)

    // ── 压缩摘要：必须每次新会话 + 补发历史 ─────────────────────────────
    // 摘要是「把这段对话压成检查点」——**待压缩的对话本身就是输入**。
    // 若不补发历史，上游只收到最后那条压缩指令，产出的摘要与对话无关
    // （实测：191 字的「已按您指定的 Markdown 结构完成压缩检查点输出」元话，
    //  零事实；补发历史后是 999 字、逐字复述了 SHM 锁与 8793 端口）。
    // 宿主随后拿摘要与被压缩内容比大小：无关的元话不比内容短 → 报
    // 「summary is not smaller than the shadowed content」；空摘要则报
    // 「summarization produced no text summary content」。两者都让模型切换
    // 以 MODEL_SWITCH_COMPACTION_FAILED 收尾。
    //
    // 每次压缩都用**新会话**：上游若留着上一次压缩的上下文，历史会被叠加，
    // 摘要随之掺入旧内容（实测摘要里出现过「最近标记为 user 3」这种上一轮的痕迹）。
    // 会话 id 用真随机的一段（官方形态 cid-{uuid}-{assistant}）——
    // 常规会话那套「会话键的稳定哈希」在这里不够：上游服务端会留着旧会话。
    if (this.isCompactionRequest(options)) {
      const created = freshConversationId()
      this._conversations.set(key, created)
      return {
        conversationId: created,
        sendHistory: true,
        action: 'resync',
        reason: 'compaction-needs-history',
        rounds: 0,
      }
    }

    const maxRounds = Number(opts.conversationMaxRounds)
    const decision = this._context.decide(key, messages, { maxRounds })
    const stateless = opts.reuseConversation === false
    const known = this._conversations.get(key)
    // 会话 ID 形态对齐官方 generateConversationId（模块 72535）：`cid-{id}-{assistant}`，
    // orcaterm 的 assistant 名非 lighthouse → `cid-<id>-orcaterm`。
    const baseId = () => `cid-${hashOf(key).slice(0, 12)}-orcaterm`

    // 首轮：预生成一个稳定 id，让后续轮次能落在同一会话上（进程重启后也能复现同一个 id）。
    if (decision.action === 'fresh' && !known) {
      const created = baseId()
      this._conversations.set(key, created)
      return { conversationId: created, sendHistory: stateless, action: decision.action, reason: decision.reason, rounds: decision.rounds }
    }

    if (!stateless && decision.action !== 'resync') {
      const reuse = known ?? baseId()
      this._conversations.set(key, reuse)
      return { conversationId: reuse, sendHistory: false, action: decision.action, reason: decision.reason, rounds: decision.rounds }
    }

    // 换新会话：id 带上轮换序号，免得与上游仍留着的旧会话撞名。
    const rotations = (this._rotations.get(key) ?? 0) + 1
    this._rotations.set(key, rotations)
    const created = `${baseId()}-r${rotations}`
    this._conversations.set(key, created)
    return {
      conversationId: created,
      sendHistory: true,
      action: decision.action,
      reason: decision.reason,
      rounds: decision.rounds,
    }
  }

  /**
   * 流式生成：转发到反代的 POST /v1/chat/completions (SSE)，
   * 并把 OpenAI 增量映射成 DSH StreamChunk（reasoning-delta / text-delta / usage / finish）。
   */
  async * stream(model, options, boundOpts, boundManager) {
    const opts = boundOpts || this.current()
    const manager = boundManager || this.ensureManager()
    const signal = options?.signal
    if (signal?.aborted === true) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
      return
    }

    try {
      await manager.ensure()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = typeof error?.failureCode === 'string' && error.failureCode !== '' ? error.failureCode : 'TRANSPORT'
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
      return
    }

    const messages = formatOpenAiMessages({ system: options?.system, messages: options?.messages }, (m) => this.warn(m))
    const tools = formatOpenAiTools(options?.tools, opts.toolDescriptionMaxChars)
    if (tools) {
      // 工具声明透传给反代 → 上游 Agent 网关；上游能否真正执行取决于其协议支持。
      this.warn(`本轮透传 ${tools.length} 个工具声明给上游 Agent`)
    }
    const requestedMaxTokens = Number(options?.maxTokens)
    const fallbackMaxTokens = Number(opts.defaultMaxTokens)
    const maxTokens = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
      ? requestedMaxTokens
      : (Number.isFinite(fallbackMaxTokens) && fallbackMaxTokens > 0 ? fallbackMaxTokens : 0)
    // 思考档位：宿主把用户选的档位放在 options.reasoningEffort。
    // Off 在线上对应 reasoning_effort:"none"（反代据此发 enableThinking:false）。
    const reasoningEffort = typeof options?.reasoningEffort === 'string' && options.reasoningEffort !== ''
      ? options.reasoningEffort
      : ''

    const conversation = this.resolveConversation(opts, options, messages)
    const conversationId = conversation.conversationId
    this.debug(`上下文对账：action=${conversation.action} reason=${conversation.reason} rounds=${conversation.rounds} conversation=${conversationId || 'fresh'}`)
    if (conversation.sendHistory) {
      // 换新会话时必须补发历史：否则新会话对上游来说是空的（压缩/重试/轮数上限都会走到这里）。
      this.warn(`上下文对账：换新会话并补发历史（action=${conversation.action} reason=${conversation.reason}）`)
    }
    const body = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools ? { tools } : {}),
      ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
      ...(reasoningEffort !== '' ? { reasoning_effort: reasoningEffort === 'off' ? 'none' : reasoningEffort } : {}),
      ...(conversationId !== '' ? { user: conversationId } : {}),
      // 本轮是否把 DSH 历史发进 input.historyMessages；反代默认不发（上游会把历史回灌成 ai 帧）。
      ...(conversation.sendHistory ? { orca_send_history: true } : {}),
      // 本轮用途（宿主的 purpose）。压缩摘要轮需要它：后端据此走普通 start 路径，
      // 避免把压缩指令误当成「对未决工具调用的反馈」（review/feedback 形态不带历史）。
      ...(typeof options?.purpose === 'string' && options.purpose !== ''
        ? { orca_purpose: String(options.purpose) }
        : {}),
    }

    const attribution = await resolveAttributionHeaders(this.logger)
    const headers = { ...attribution, 'content-type': 'application/json' }

    let response
    try {
      response = await fetch(`${String(opts.baseUrl).replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      yield { type: 'finish', reason: this.transportFailure(error, signal) }
      return
    }

    if (!response.ok) {
      const rawBody = await response.text().catch(() => '')
      const { message, detail } = describeErrorBody(response.status, rawBody)
      const code = failureCodeForMessage(detail) || failureCodeForStatus(response.status, detail)
      const retryAfter = retryAfterMs(response.headers?.get?.('retry-after'))
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `orchaterm-web-api 错误: ${message}${HINTS[code] ? `（${HINTS[code]}）` : ''}`,
            code,
            status: response.status,
            ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
          },
        },
      }
      return
    }

    yield* this.consume(response.body, { model, messages, tools, signal, opts, conversationId })
  }

  /**
   * 消费 SSE，映射成 DSH StreamChunk。
   *
   * 反代已经把 OrcaTerm 的私有帧（`data:{content,reasoningContent}` + `[DONE]`/`[ERROR]:`/
   * `[ABORTED]`）翻成 OpenAI 方言，所以这里只处理标准 chunk；`[DONE]` 之外还要认流内 error 帧
   * （HTTP 仍是 200 的那种），否则失败会被当成「正常说完」。
   */
  async * consume(stream, ctx) {
    const { model, messages, tools, signal, opts, conversationId } = ctx
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let blockIndex = 0
    let currentBlockType = null
    let reasoningText = ''
    let contentText = ''
    let finishReason = 'stop'
    let sawUsage = false
    let promptTokens = 0
    let completionTokens = 0
    let aborted = false
    let done = false
    let sawErrorFrame = null
    const startedAt = Date.now()
    let firstDeltaAt = 0

    // 出错或提前 return 也要闭合已打开的 block，否则宿主会留一个永不收尾的气泡。
    const closeOpenBlock = () => {
      if (!currentBlockType) return null
      const type = currentBlockType
      const text = type === 'reasoning' ? reasoningText : contentText
      const chunk = { type: 'block-end', index: blockIndex, block: { type, text } }
      blockIndex += 1
      currentBlockType = null
      return chunk
    }

    const idleMs = Number(opts.streamIdleTimeoutMs)
    const readNext = () => {
      if (!Number.isFinite(idleMs) || idleMs <= 0) return reader.read()
      let timer = null
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(`orchaterm-web-api 流空闲超过 ${idleMs}ms 没有数据`), { failureCode: 'TIMEOUT' }))
        }, idleMs)
      })
      return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer))
    }

    try {
      while (!done) {
        const read = await readNext()
        if (read.done) break
        if (signal?.aborted === true) { aborted = true; break }

        buffer += decoder.decode(read.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (trimmed === 'data: [DONE]') { done = true; break }
          if (!trimmed.startsWith('data:')) continue
          let chunkData
          try {
            chunkData = JSON.parse(trimmed.slice(5).trim())
          } catch {
            continue
          }

          if (chunkData?.error) {
            const detail = typeof chunkData.error.message === 'string' ? chunkData.error.message : ''
            const status = Number(chunkData.error.status ?? chunkData.error.code ?? 0)
            const code = failureCodeForMessage(detail)
              || (Number.isInteger(status) && status >= 400 ? failureCodeForStatus(status, detail) : 'TRANSPORT')
            sawErrorFrame = { message: detail || 'Stream error', code, status: Number.isInteger(status) && status >= 400 ? status : undefined }
            done = true
            break
          }

          const choice = chunkData?.choices?.[0]
          const delta = choice?.delta

          // 1) 深度思考增量 → reasoning-delta（思考气泡）
          if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
            if (currentBlockType !== 'reasoning') {
              if (currentBlockType === 'text') {
                yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: contentText } }
                blockIndex += 1
              }
              yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
              currentBlockType = 'reasoning'
            }
            reasoningText += delta.reasoning_content
            if (firstDeltaAt === 0) firstDeltaAt = Date.now()
            yield { type: 'reasoning-delta', index: blockIndex, text: delta.reasoning_content }
          }

          // 2) 正文增量 → text-delta
          if (typeof delta?.content === 'string' && delta.content !== '') {
            if (currentBlockType === 'reasoning') {
              yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: reasoningText } }
              blockIndex += 1
              currentBlockType = null
            }
            if (currentBlockType !== 'text') {
              yield { type: 'block-start', index: blockIndex, blockType: 'text' }
              currentBlockType = 'text'
            }
            contentText += delta.content
            if (firstDeltaAt === 0) firstDeltaAt = Date.now()
            yield { type: 'text-delta', index: blockIndex, text: delta.content }
          }

          // 3) 工具调用：反代把 OrcaTerm Agent 的 MCP 工具信封转成了 OpenAI tool_calls。
          //    每个调用闭合当前文本块，转成 DSH tool-call 块，Web 端渲染工具卡片。
          if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
            for (const call of delta.tool_calls) {
              if (currentBlockType !== null) {
                const closing = closeOpenBlock()
                if (closing) yield closing
              }
              yield {
                type: 'block-end',
                index: blockIndex,
                block: {
                  type: 'tool-call',
                  id: String(call.id || `call_${blockIndex}`),
                  name: String(call.function?.name || 'unknown'),
                  arguments: String(call.function?.arguments || '{}'),
                },
              }
              blockIndex += 1
              if (finishReason === 'stop' || finishReason === null) finishReason = 'tool_calls'
            }
          }

          if (choice?.finish_reason) finishReason = choice.finish_reason

          // usage 只记录不立即下发：内核会把多个 usage 相加，重复发就是重复计费。
          if (chunkData?.usage && typeof chunkData.usage === 'object') {
            sawUsage = true
            promptTokens = Number(chunkData.usage.prompt_tokens) || 0
            completionTokens = Number(chunkData.usage.completion_tokens ?? chunkData.usage.total_tokens) || 0
          }
        }
      }

      const closing = closeOpenBlock()
      if (closing) yield closing

      const outputTokens = sawUsage && completionTokens > 0
        ? completionTokens
        : estimateTokens(contentText) + estimateTokens(reasoningText)
      const inputTokens = sawUsage && promptTokens > 0
        ? promptTokens
        : estimateInputTokens(messages, tools)
      yield { type: 'usage', usage: { inputTokens, outputTokens } }

      if (sawErrorFrame) {
        logTurn(this, ctx, 'error', startedAt, firstDeltaAt, reasoningText, contentText, conversationId, { code: sawErrorFrame.code })
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: `orchaterm-web-api 错误: ${sawErrorFrame.message}${HINTS[sawErrorFrame.code] ? `（${HINTS[sawErrorFrame.code]}）` : ''}`,
              code: sawErrorFrame.code,
              ...(sawErrorFrame.status === undefined ? {} : { status: sawErrorFrame.status }),
            },
          },
        }
        return
      }

      if (aborted || signal?.aborted === true) {
        logTurn(this, ctx, 'aborted', startedAt, firstDeltaAt, reasoningText, contentText, conversationId)
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return
      }

      // 兜底：整轮零产出不能静默 stop —— 那会让 DSH 把回合判成「已完成」。
      if (contentText.trim() === '' && reasoningText.trim() === '') {
        // 纯工具调用轮没有正文：这是合法产出，不判空。
        if (finishReason !== 'tool_calls') {
          logTurn(this, ctx, 'EMPTY_RESPONSE', startedAt, firstDeltaAt, reasoningText, contentText, conversationId)
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: 'orchaterm-web-api 这一轮没有产出任何内容（检查 OrcaTerm 是否仍登录、账号额度是否用尽）',
                code: 'EMPTY_RESPONSE',
              },
            },
          }
          return
        }
      }

      logTurn(this, ctx, 'stop', startedAt, firstDeltaAt, reasoningText, contentText, conversationId, { finish: finishReason })
      yield { type: 'finish', reason: { kind: finishReason === 'tool_calls' ? 'tool-calls' : 'stop' } }
    } catch (error) {
      const closing = closeOpenBlock()
      if (closing) yield closing
      const reason = this.transportFailure(error, signal)
      logTurn(this, ctx, reason.kind === 'aborted' ? 'aborted' : reason.failure.code, startedAt, firstDeltaAt, reasoningText, contentText, conversationId)
      yield { type: 'finish', reason }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // 流可能已经结束
      }
    }
  }

  /** 传输层失败归一：用户中止必须是 ABORTED（不可重试），不能被当成 TRANSPORT 再重试两轮。 */
  transportFailure(error, signal) {
    const message = error instanceof Error ? error.message : String(error)
    if (signal?.aborted === true || error?.name === 'AbortError') {
      return { kind: 'aborted', failure: { message: message || 'request aborted', code: 'ABORTED' } }
    }
    const byMessage = failureCodeForMessage(message)
    const code = byMessage
      || (typeof error?.failureCode === 'string' && error.failureCode !== '' ? error.failureCode : 'TRANSPORT')
    const status = Number.isInteger(error?.failureStatus) ? error.failureStatus : undefined
    const isIdle = /timeout|timed out|idle/i.test(message)
    const finalCode = code === 'TRANSPORT' && isIdle ? 'TIMEOUT' : code
    return {
      kind: 'error',
      failure: {
        message: `${message}${HINTS[finalCode] ? `（${HINTS[finalCode]}）` : ''}`,
        code: finalCode,
        ...(status === undefined ? {} : { status }),
      },
    }
  }
}

/** 取一条消息的全部文本（用于会话指纹）。 */
function messageText(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('')
  }
  return String(message.content ?? '')
}

/**
 * 一个保证新鲜的会话 id（官方形态 `cid-{uuid}-{assistant}`，模块 72535）。
 *
 * 官方那一段是 uuid；本插件的常规会话用「会话键的稳定哈希」代替（好处是进程重启后
 * 还能落回同一会话）。但**压缩摘要**不能用稳定 id —— 上游服务端会留着那个会话，
 * 于是摘要里会掺进上一次压缩的旧内容（实测：摘要提到「最近标记为 user 3」，
 * 而那一轮根本不是本次的对话）。所以这里用真随机的一段 12 位十六进制。
 *
 * @returns {string} 形如 `cid-a1b2c3d4e5f6-orcaterm`
 */
function freshConversationId() {
  const bytes = randomBytes(6)
  return `cid-${bytes.toString('hex')}-orcaterm`
}

/** 稳定短哈希（FNV-1a，16 进制）；只用来做会话指纹，不承担安全职责。 */
function hashOf(text) {
  let hash = 0x811c9dc5
  const value = String(text ?? '')
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 每轮一行统计：这类失败过去是静默的，有 ttft 与各通道长度才能事后复盘。 */
function logTurn(adapter, ctx, outcome, startedAt, firstDeltaAt, reasoningText, contentText, conversationId, extra = {}) {
  const fields = [
    `model=${ctx.model}`,
    `ms=${Date.now() - startedAt}`,
    `ttft=${firstDeltaAt === 0 ? 'none' : `${firstDeltaAt - startedAt}ms`}`,
    `reasonChars=${reasoningText.length}`,
    `contentChars=${contentText.length}`,
    `conversation=${conversationId || 'fresh'}`,
    `outcome=${outcome}`,
  ]
  for (const [key, value] of Object.entries(extra)) fields.push(`${key}=${value}`)
  const line = fields.join(' ')
  if (outcome === 'stop') adapter.debug(line)
  else adapter.warn(line)
}

/**
 * 错误码 → 一句「下一步做什么」。
 *
 * 上游的原始报错对用户没有可操作性：它会说 NEED_UIN_AND_SKEY，却不会说去哪儿弄 skey。
 */
const HINTS = Object.freeze({
  AUTH: 'OrcaTerm 登录态不可用于该通道：assistant 网关只认 QQ 系 uin+skey（微信 OAuth 号没有）。'
    + '① 用 QQ 号登录一次 OrcaTerm；或 ② 在 config.assistantCookies 里显式写 uin=…; skey=…；'
    + '或 ③ 在 OrcaTerm 里配置外部模型（CreateAILLMModel）改走 CGI 通道。',
  QUOTA: 'OrcaTerm 账号额度用尽：在 OrcaTerm 里看「用量」，或换号后重试。',
  RATE_LIMIT: 'OrcaTerm 正在限流：等一会儿再试。',
  CONTEXT_WINDOW_EXCEEDED: '上下文超长：减少历史消息或文件片段，或调低 maxContextWindow 让内核早点压缩。',
  INVALID_REQUEST: '上游说请求不合法（重试无用）：多半是模型 id 不在 OrcaTerm 目录里，换成 /v1/models 返回的 id。',
  EMPTY_RESPONSE: '上游这一轮没出字：确认 OrcaTerm 桌面端仍在登录态（token 到期会静默失败），或在 OrcaTerm 里发一条消息看是否被风控。',
  BACKEND_STALE: '127.0.0.1:8793 上跑的是旧构建的反代：在本插件目录跑 .\\install.ps1，或手动杀掉占用 8793 的 node 进程。',
})

/** 宿主插件入口：注册 provider 路由 + 可配置 provider 条目。 */
export function apply(ctx, config) {
  const logger = ctx?.logger || null
  const source = () => (config && typeof config === 'object' ? config : {})
  const adapter = new OrcaTermWebApiAdapter(source, null, logger)

  const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)

  ctx.llm.registerConfigurableProviders?.([
    {
      provider: PROVIDER_ID,
      displayName: PROVIDER_LABEL,
      settingsNs: 'orchaterm-web-api',
      settingsPath: ['providers', PROVIDER_ID],
    },
  ])

  ctx.on?.('dispose', () => {
    try {
      if (typeof registration === 'function') registration()
    } catch {
      // 注册表已回收
    }
    adapter.dispose()
  })

  return adapter
}




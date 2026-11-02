/**
 * OrcaTerm 反代服务（零依赖，Node >= 20）。
 *
 * 对外提供 OpenAI 兼容面，供 DSH 的 provider 适配器直连：
 *   GET  /health              自述版本/能力/凭据状态（不回显任何值）
 *   GET  /v1/models           CGI DescribeAIModelList + 内建目录 + 用户默认模型
 *   POST /v1/chat/completions assistant /chat 的 SSE → OpenAI chunk
 *   POST /orca/cgi            CGI action 透传（工作空间、额度、AI 设置等）
 *
 * 只绑 127.0.0.1：本机凭据是从 OrcaTerm 登录态读出来的，暴露到网卡等于把账号交出去。
 *
 * @module backend/server.js
 */

import { createServer } from 'node:http'

import {
  ASSISTANT_PATHS,
  assistantAbort,
  assistantBody,
  assistantHeaders,
  assistantQuery,
  assistantStreamStatus,
  cgiCall,
  classifyDataLine,
  DESKTOP_IDENTITY,
  identityOf,
  newSeqId,
  streamControlUrl,
} from './upstream.js'
import {
  createDeliveredHistory,
  createGreetingStripper,
  createRepeatStripper,
  createThinkingTagRouter,
  classifyUiToolCategory,
  describeExecutionHost,
  redactSecrets,
  REPORT_RETRY_TIMEOUT_MS,
  reportRetryBackoffMs,
  resolveDshToolCall,
  resolvePosixShell,
  askEnvelopeToQuestionTool,
  askResultToAnswerText,
  ASK_TOOL_NAME,
  wrapToolResultInput,
  recoverToolEnvelope,
  createEnvelopeFenceGuard,
} from './agent-protocol.js'
import {
  applyAccessToken,
  cookieHeaderFor,
  decodeJwtExp,
  redact,
  resolveCredentials,
  tokenCachePath,
} from './credentials.js'
import {
  DEFAULT_REFRESH_CHECK_MS,
  DEFAULT_REFRESH_LEAD_MS,
  createTokenRefresher,
  tokenRemainingMs,
} from './token-refresh.js'

export const VERSION = '0.7.0'

/** 能力自述：插件的 contract.js 按这份清单决定是否复用已起的后端。 */
export const CAPABILITIES = Object.freeze([
  'openai-chat-completions',
  'orca-cgi-passthrough',
  'health-self-description',
  'assistant-sse',
  // AccessToken 自续期（OAuthRefreshToken）：旧构建缺这项，凭据过期就再也救不回来。
  'token-self-refresh',
])

/**
 * 内建模型目录（精简为 5 个核心模型）：
 * - DeepSeek-V4.1-Flash: Max/High/Low, 1M 长上下文, 思考模式
 * - Hy4-preview: High, 1M 长上下文, 思考模式
 * - Hy3: High/Low, 128K, 思考模式
 * - Kimi-K3: Max/High/Low, 1M 长上下文, 思考模式
 * - GLM-5.3-Flash: Max/High/Low, 300K, 思考模式
 *
 * ⚠️ modalities 一律含 'image'（v0.7.0）：反代对外说 OpenAI 方言，但上游助手网关的
 * 协议是**纯文本**，图片字节发不过去；图片在宿主侧被转述成文字再交给上游。
 * 这里标 image 是为了告诉宿主「这条路由接得住图片附件」，
 * 否则带图会话会在 admission 阶段被拒（MODEL_DOES_NOT_SUPPORT_IMAGES）。
 */
export const BUILTIN_MODELS = Object.freeze([
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', reasoning: true, contextWindow: 1048576, modalities: ['text', 'image'], description: 'OrcaTerm 默认推荐（思考模式 Max/High/Low，图片经本地识图转述，1M 长上下文）' },
  { id: 'hy4-preview', name: 'Hy4-preview', reasoning: true, contextWindow: 1048576, modalities: ['text', 'image'], description: '腾讯混元新一代预览（思考模式 High，图片经本地识图转述，1M 长上下文）' },
  { id: 'hy3', name: 'Hy3', reasoning: true, contextWindow: 128000, modalities: ['text', 'image'], description: '腾讯混元 3 主力模型（思考模式 High/Low，图片经本地识图转述，128K）' },
  { id: 'kimi-k3', name: 'Kimi-K3', reasoning: true, contextWindow: 1048576, modalities: ['text', 'image'], description: '月之暗面 K3（思考模式 Max/High/Low，图片经本地识图转述，1M 长上下文）' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', reasoning: true, contextWindow: 300000, modalities: ['text', 'image'], description: '智谱 GLM 5.3 Flash（思考模式 Max/High/Low，图片经本地识图转述，300K 长上下文）' },
])

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  // 头已发出（SSE 中途出错）时不能再写状态行，直接终结连接
  if (res.headersSent) {
    try { res.end(body) } catch { /* 已终结 */ }
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * OpenAI tools 数组 → 上游 Agent 网关的工具声明。
 * 上游吃 OpenAI function 形态 `{type:'function', function:{name, description, parameters}}`；
 * 其它类型（内置 tool 类型等）丢弃。数组为空时传 []，不伪造。
 * @param {unknown} tools
 * @returns {Array}
 */
function toUpstreamTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((t) => t && t.type === 'function' && t.function && typeof t.function.name === 'string')
    .map((t) => ({
      type: 'function',
      function: {
        name: String(t.function.name),
        ...(typeof t.function.description === 'string' ? { description: t.function.description } : {}),
        ...(t.function.parameters && typeof t.function.parameters === 'object' ? { parameters: t.function.parameters } : {}),
      },
    }))
}

/**
 * OpenAI messages → assistant 的单轮输入。
 *
 * 核心设计：
 * 1. 正常用户提问轮：提取最后一条 user 消息及其系统提示词，转为 type: 'start' 输入；
 * 2. 工具结果返回轮：当最新消息为 role: 'tool' 时，识别出 DSH 刚刚执行完的工具输出，
 *    自动封装为 OrcaTerm Agent 协议专用的 `{TOOL_RESULT}(toolName): output` 格式，
 *    并将 input.type 置为 'ask'，无缝推进上游 Agent 的多轮工具调用状态机。
 */
/**
 * DSH 的 pwsh 工具输出超过 ~50K 字符时会**砍头留尾**，并在结尾留转存文件指针：
 * `Full formatted result stored at <path>. Use read with offset/limit...`。
 * 上游 Agent 不认识 DSH 的 read 工具，看到无头截断串会判为「数据不可用」并转而问用户
 * （session-fb62c7fd 第二次中断的实测链条）。检测到该指针时附上恢复指引，
 * 教它用自己认识的 execute_command 分段读转存文件，而不是放弃。
 */
function appendSpillHint(rawText) {
  const match = /Full (?:formatted )?(?:result|output) stored at (\S+?)(?:\.\s|\.$|\s)/.exec(rawText)
  if (!match) return rawText
  const spillPath = match[1]
  return `${rawText}\n[系统提示] 上面的输出被截断了（只保留了末尾），完整输出已保存在本机文件 ${spillPath}。`
    + '不要认为数据缺失或要求用户重新提供；应调用 execute_command 分段读取该文件，例如：'
    + `Get-Content -LiteralPath '${spillPath}' -TotalCount 100（看开头）、`
    + `-Tail 100（看结尾）、或 Select-Object -Skip N -First M（看中段），也可以直接在文件上统计（Measure-Object / Select-String）。`
}

/**
 * OpenAI messages → assistant 单轮输入（导出供单测；行为见内注）。
 *
 * @param {Array} messages OpenAI 形态消息数组
 * @param {{resultEnvelope?:'review'|'ask', askCallIds?:Set<string>, purpose?:string}} [options]
 *   `resultEnvelope` 选工具结果的回传信封：`'review'`（默认，官方子 Agent 循环形态）
 *   或 `'ask'`（官方主循环 `reportToolResult` 形态）；两者都以真实流量验证过，见 README。
 *   `askCallIds` 是「这些 callId 是上游提问信封」的集合 —— 它们的回传走 respondToAsk。
 *   `purpose` 是本轮的用途（宿主给辅助调用打的标，如 `'compaction'`）。
 */
export function toAssistantInput(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  const resultEnvelope = options.resultEnvelope === 'ask' ? 'ask' : 'review'
  const askCallIds = options.askCallIds instanceof Set ? options.askCallIds : null
  // 压缩摘要轮：待压缩的对话 + 一条压缩指令，**不是**工具结果轮、也不是对未决
  // 工具调用的反馈。它必须走普通 start 路径 —— review/feedback 两种形态都不带
  // historyMessages（见 assistantBody），上游就看不到待压缩的对话，摘要必然与
  // 对话无关。宿主把压缩摘要作为 purpose='compaction' 的辅助调用发出。
  const isCompaction = options.purpose === 'compaction'

  // 找到最后一个 assistant 消息的索引
  let lastAssistantIdx = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }

  const history = []
  let systemText = ''

  // 1) 历史消息处理：最后一个 assistant 及其前面的所有消息，构成历史轮次
  for (let i = 0; i <= lastAssistantIdx; i += 1) {
    const m = list[i]
    const text = typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.filter((p) => p?.type === 'text').map((p) => p.text || '').join('')
        : String(m?.content ?? '')
    if (m.role === 'system' || m.role === 'developer') {
      if (text) systemText = text
    } else if (m.role === 'user') {
      if (text) history.push({ type: 'human', content: text })
    } else if (m.role === 'assistant') {
      if (text) {
        history.push({ type: 'ai', content: text })
      } else if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const tcSummary = m.tool_calls.map((c) => `[调用工具: ${c?.function?.name || 'tool'}]`).join('\n')
        history.push({ type: 'ai', content: tcSummary })
      }
    } else if (m.role === 'tool') {
      if (text) history.push({ type: 'human', content: `[工具返回结果]: ${text}` })
    }
  }

  // 2) 当前回合消息处理：最后一个 assistant 之后的消息
  const currentParts = []
  const toolResults = []
  const reviewTools = []
  const reviewTexts = []
  // 每个工具结果的一条记录：回传信封按整批决定，所以要先把事实收齐再选形态。
  const results = []
  let isToolTurn = false

  for (let i = lastAssistantIdx + 1; i < list.length; i += 1) {
    const m = list[i]
    if (m.role === 'tool') {
      isToolTurn = true
      const rawText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      // 提取被调用的工具名（从前序 assistant 的 tool_calls 里找匹配 tool_call_id）
      let toolName = 'execute_command'
      const lastAssMsg = lastAssistantIdx >= 0 ? list[lastAssistantIdx] : null
      if (Array.isArray(lastAssMsg?.tool_calls)) {
        const matchedCall = lastAssMsg.tool_calls.find((tc) => tc.id === m.tool_call_id)
        if (matchedCall?.function?.name) {
          toolName = matchedCall.function.name
        }
      }
      // 映射回 OrcaTerm 内部工具标签名（仅作日志/兜底用；官方协议回传原样 tool 对象）
      let orcaTag = toolName
      if (toolName === 'pwsh' || toolName === 'bash') orcaTag = 'execute_command'
      else if (toolName === 'read') orcaTag = 'remote_read'
      else if (toolName === 'write') orcaTag = 'remote_write'
      else if (toolName === 'glob') orcaTag = 'remote_glob'
      else if (toolName === 'grep') orcaTag = 'remote_grep'
      toolResults.push(`{TOOL_RESULT}(${orcaTag}): ${appendSpillHint(redactSecrets(rawText))}`)
      // 官方协议的原样 tool 对象：优先取下发时记住的信封原件，丢档时按映射反推。
      const lastAssMsg2 = lastAssistantIdx >= 0 ? list[lastAssistantIdx] : null
      const matched = Array.isArray(lastAssMsg2?.tool_calls)
        ? lastAssMsg2.tool_calls.find((tc) => tc.id === m.tool_call_id)
        : null
      const origTool = ORIG_TOOL_BY_CALL.get(m.tool_call_id)
        ?? reconstructOrcaTool(matched?.function?.name || toolName, matched?.function?.arguments || '{}')
      reviewTools.push(origTool)
      // 官方客户端回传前先用 Sn.fp 脱敏（模块 35482 → redactSecrets），转存指引在其后追加。
      reviewTexts.push(appendSpillHint(redactSecrets(rawText)))
      results.push({
        rawText,
        orcaTag,
        origTool,
        isAsk: askCallIds !== null && askCallIds.has(String(m.tool_call_id ?? '')),
      })
    } else {
      const text = typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.filter((p) => p?.type === 'text').map((p) => p.text || '').join('')
          : String(m?.content ?? '')
      if (!text) continue
      if (m.role === 'system' || m.role === 'developer') {
        systemText = text
      } else {
        currentParts.push(text)
      }
    }
  }

  if (isToolTurn && !isCompaction) {
    // 上游的**提问**不是工具执行结果，回程要用官方 respondToAsk（模块 2481 `at`）：
    // `{type:'ask', input:<用户答复原文>}`。整批都是提问时才走这条；混批按工具结果处理。
    if (results.length > 0 && results.every((r) => r.isAsk)) {
      const answer = results.map((r) => askResultToAnswerText(r.rawText)).join('\n\n')
      return { content: answer, type: 'ask', history }
    }

    // 工具结果的回传信封有两种官方形态，由 resultEnvelope 选：
    //   'review'（默认）—— 桌面客户端子 Agent 循环（orcaterm_start/app.js）：
    //     {type:'review', reviewAction:'reportToolResult', toolResult, tool}
    //     实测对照：该协议下模型精确消费结果内容。
    //   'ask' —— 主循环模块 2481 导出的 reportToolResult（`st`）：
    //     {type:'ask', input:'{TOOL_RESULT}(<tool.name>): <result>'}
    //     工具名标签常量 ASSISTANT_TOOL_RESULT_MSG_TAG='TOOL_RESULT'（模块 68280）。
    if (resultEnvelope === 'ask') {
      const merged = results
        .map((r) => wrapToolResultInput(r.origTool?.name || r.orcaTag, appendSpillHint(redactSecrets(r.rawText))))
        .join('\n\n')
      return { content: merged, type: 'ask', toolResultText: merged, history }
    }

    // 多个结果合并为一份 toolResult（官方客户端逐个回传且等待响应；DSH 一次性给全部，只能合并）。
    const merged = reviewTexts.length === 1
      ? reviewTexts[0]
      : reviewTexts.map((t, i) => `[结果 ${i + 1}/${reviewTexts.length} · ${reviewTools[i]?.name ?? 'tool'}]\n${t}`).join('\n\n')
    return {
      content: '',
      toolResultText: toolResults.join('\n\n'),
      type: 'review',
      reviewInput: {
        type: 'review',
        reviewAction: 'reportToolResult',
        toolResult: merged,
        tool: reviewTools[0] ?? reconstructOrcaTool('pwsh', '{}'),
      },
      history,
    }
  }

  // 官方 resolveSendInput（模块 2481 `ut`）：上一回合仍是未决 review（assistant 发了 tool_calls
  // 但 DSH 没回任何 tool 结果，用户直接打字/改口）时，官方客户端**不新开 start**，而是
  // {type:'review', reviewAction:'feedback', input:<文本>, tool:<未决工具原件>} —— 把用户的话
  // 作为对该工具调用的反馈续进同一个 review 循环。我们此前会误发 start，上游挂着的 review
  // 得不到回应，与新指令互相打架。
  const pendingCalls = lastAssistantIdx >= 0 && Array.isArray(list[lastAssistantIdx]?.tool_calls)
    ? list[lastAssistantIdx].tool_calls
    : []
  const feedbackText = currentParts.join('\n\n')
  if (pendingCalls.length > 0 && feedbackText && !isCompaction) {
    const firstCall = pendingCalls[0]
    const origTool = ORIG_TOOL_BY_CALL.get(firstCall?.id)
      ?? reconstructOrcaTool(firstCall?.function?.name || 'pwsh', firstCall?.function?.arguments || '{}')
    return {
      content: feedbackText,
      type: 'review',
      reviewInput: {
        type: 'review',
        reviewAction: 'feedback',
        input: feedbackText,
        tool: origTool,
      },
      history,
    }
  }

  let content = currentParts.join('\n\n')
  if (systemText && lastAssistantIdx === -1) {
    content = `[系统要求] ${systemText}\n\n${content}`
  }

  return { content, history, type: 'start' }
}

/** 把 one assistant data item 翻成 OpenAI delta（可能同时有 reasoning 与 content）。 */
function toDeltas(item) {
  const deltas = []
  const reasoning = typeof item?.reasoningContent === 'string' ? item.reasoningContent : ''
  let content = typeof item?.content === 'string' ? item.content : ''
  // 上游 completion 动作可能在 taskCompletion 或 text 中返回正文
  if (content === '' && typeof item?.taskCompletion === 'string') {
    content = item.taskCompletion
  } else if (content === '' && typeof item?.text === 'string') {
    content = item.text
  }
  if (reasoning !== '') deltas.push({ reasoning_content: reasoning })
  if (content !== '') deltas.push({ content })
  return deltas
}

class AssistantUnavailableError extends Error {
  constructor() {
    super('NEED_UIN_AND_SKEY')
    this.statusCode = 401
    this.code = 'assistant_unavailable'
  }
}

/**
 * 建配置对象：CLI/env 覆盖 + 凭据 + cookie 按域拼装。
 *
 * `clientIdentity` 决定以哪个客户端的身份访问上游（origin / referer / X-Referer）：
 * - `desktop`（默认）：`http://tauri.localhost`，即桌面端 webview 的真实页面；
 * - `web`：`https://orcaterm.com`，即 v0.3.1 及之前的口径。
 * UA 两种口径都用桌面端实测值（见 upstream.DESKTOP_IDENTITY 的注释）。
 *
 * 已实测：`/cgi/api` 与 `/assistant/chat` 都**不校验** origin / referer / UA
 * （不带、乱填都返回 200 且 ai 帧数一致），所以这里是「对齐真实客户端」而非修故障。
 *
 * @param {object} options
 */
export function buildConfig(options = {}) {
  // 自续期开关：'auto'（默认）| 'off'。关掉就退回 v0.5.x 的「只重读桌面端登录态」行为。
  const refreshEnabled = String(
    options.tokenRefresh ?? process.env.ORCA_TOKEN_REFRESH ?? 'auto',
  ).toLowerCase() !== 'off'
  const cachePath = tokenCachePath(options.tokenCache || process.env.DSH_ORCA_TOKEN_CACHE || '')
  const numberOpt = (value, fallback) => {
    const num = Number(value)
    return Number.isFinite(num) ? Math.max(0, num) : fallback
  }
  const refreshLeadMs = numberOpt(
    options.tokenRefreshLeadMs ?? process.env.ORCA_TOKEN_REFRESH_LEAD_MS,
    DEFAULT_REFRESH_LEAD_MS,
  )
  const refreshCheckMs = numberOpt(
    options.tokenRefreshCheckMs ?? process.env.ORCA_TOKEN_REFRESH_CHECK_MS,
    DEFAULT_REFRESH_CHECK_MS,
  )
  const credentialOpts = {
    credentialsFile: options.credentialsFile || process.env.DSH_ORCA_CREDENTIALS || '',
    token: options.token || '',
    cookies: options.cookies || process.env.ORCA_COOKIES || '',
    uin: options.uin || '',
    skey: options.skey || '',
    tokenCache: cachePath,
    // 测试注入：允许把「桌面端登录态」指到临时文件，避免读到真机凭据。
    ...(options.storePath ? { storePath: options.storePath } : {}),
    ...(options.cookiesPath ? { cookiesPath: options.cookiesPath } : {}),
  }
  const credential = options.credential || resolveCredentials(credentialOpts)
  // 显式 cookie 串（assistantCookies）优先于 jar：assistant 只吃 uin/skey 那对。
  const assistantCookies = options.assistantCookies || process.env.ORCA_ASSISTANT_COOKIES || ''
  const identityArg = String(options.clientIdentity || process.env.ORCA_CLIENT_IDENTITY || 'desktop').toLowerCase()
  const clientIdentity = identityArg === 'web' ? 'web' : 'desktop'
  const identity = identityOf(clientIdentity)
  const config = {
    // CGI 控制面默认用**桌面端**的 API host。证据（2026-10-24）：
    // 桌面端前端 bundle 里硬编码的唯一 API 常量就是 `https://api.orcaterm.cloud.tencent.com`；
    // 而 `https://api.orcaterm.com` 是**网页版**按 `location.protocol + "//api." + location.host`
    // 推导出来的（网页端跑在 orcaterm.com 上时即得到该值），在桌面端产物里一次都没出现。
    // 换回网页版口径：把 cgiBase 设为 https://orcaterm.com，或设 ORCA_CGI_BASE。
    cgiBase: options.cgiBase || process.env.ORCA_CGI_BASE || 'https://api.orcaterm.cloud.tencent.com',
    assistantBase: options.assistantBase || process.env.ORCA_ASSISTANT_BASE
      || 'https://lightai.cloud.tencent.com/assistant',
    assistant: options.assistant || 'orcaterm',
    mode: Number(options.mode ?? 0),
    model: options.model || '',
    language: options.language || 'zh',
    enableThinking: options.enableThinking === true,
    // 客户端身份：origin 与 referer 由 clientIdentity 决定，显式传入的单项仍可覆盖。
    // 网页版的 X-Referer 是 `parent.location.href`（父页 URL），桌面端主页面就是 tauri.localhost/。
    clientIdentity,
    origin: options.origin || process.env.ORCA_ORIGIN || identity.origin,
    referer: options.referer || process.env.ORCA_REFERER || identity.referer,
    userAgent: options.userAgent || process.env.ORCA_USER_AGENT || DESKTOP_IDENTITY.userAgent,
    credential,
    // cookieFor 读**当时的** credential（不捕获启动时的快照），刷新换新后即可生效。
    cookieFor: (host) => {
      if (assistantCookies !== '' && /lightai/.test(host)) return assistantCookies
      if (config.credential.cookieHeader !== '') return config.credential.cookieHeader
      return cookieHeaderFor(config.credential.jar, host)
    },
    assistantCookies,
    // 默认不把 DSH 的多轮历史发给上游：上游会把它原样回灌成 ai 帧污染正文，见 upstream.assistantBody。
    sendHistoryMessages: options.sendHistoryMessages === true || process.env.ORCA_SEND_HISTORY === '1',
    // 工具结果回传信封：'review'（默认，官方子 Agent 循环形态）| 'ask'（官方主循环形态）。
    // 两种都是真实逆向结论，默认值由 live A/B 定；见 README「工具结果回传的两种官方形态」。
    resultEnvelope: String(options.resultEnvelope || process.env.ORCA_RESULT_ENVELOPE || 'review').toLowerCase() === 'ask'
      ? 'ask'
      : 'review',
    // 回传工具结果时「上游是否受理」的阶段上限（官方 15e3；0 = 不设上限）。
    // ⚠️ 它只覆盖到拿到响应头，**不**约束随后的流式答案 —— 见 serveChat 里的长注释。
    reportRetryTimeoutMs: Number.isFinite(Number(options.reportRetryTimeoutMs ?? process.env.ORCA_REPORT_RETRY_TIMEOUT_MS))
      ? Math.max(0, Number(options.reportRetryTimeoutMs ?? process.env.ORCA_REPORT_RETRY_TIMEOUT_MS))
      : REPORT_RETRY_TIMEOUT_MS,
  }

  // 凭据是**快照**：token 只有 ~2h 寿命。v0.6.0 起不再依赖桌面端替我们续期 ——
  // 后端自己用官方 CGI 动作 `OAuthRefreshToken` 换新（见 token-refresh.js）：
  //   · 到期前 10 分钟主动续；后台每 5 分钟巡检一次（对齐桌面端 TokenManager）；
  //   · 认证类报错时强制续一次再重试；
  //   · 成功的 token 落盘到 ~/.dsh/orca-token-cache.json，进程重启也不丢。
  config.tokenRefreshEnabled = refreshEnabled
  config.tokenCachePath = cachePath
  config.tokenRefreshLeadMs = refreshLeadMs
  config.tokenRefreshCheckMs = refreshCheckMs
  const refresher = refreshEnabled
    ? createTokenRefresher(config, {
      cachePath,
      leadMs: refreshLeadMs,
      cooldownMs: numberOpt(options.tokenRefreshCooldownMs ?? process.env.ORCA_TOKEN_REFRESH_COOLDOWN_MS, 30000),
      timeoutMs: numberOpt(options.tokenRefreshTimeoutMs ?? process.env.ORCA_TOKEN_REFRESH_TIMEOUT_MS, 15000),
    })
    : null
  config.tokenRefresher = refresher
  // cgiCall 在响应头里看到 X-OT-Token-Refreshed 时回调这里（服务端滑动续期）。
  config.absorbServerToken = refresher ? (jwt) => refresher.absorb(jwt) : () => false

  // 本地重读桌面端登录态（两次文件读，零网络）。桌面端在跑时通常已经替我们续过了。
  config.refreshCredential = () => {
    let next
    try {
      next = resolveCredentials(credentialOpts)
    } catch {
      return config.credential
    }
    // 不允许把手里更鲜活的 token 换回更旧的：并发续期 + 缓存写失败时，
    // 「本地重读」可能只看到桌面端的旧值，直接覆盖等于把刚续好的 token 丢掉。
    const current = config.credential
    const currentToken = current?.token || ''
    const currentExp = decodeJwtExp(currentToken)
    if (currentToken === '' || decodeJwtExp(next.token) >= currentExp) {
      config.credential = next
    } else {
      const merged = { ...next, assistantBearer: current.assistantBearer || currentToken }
      config.credential = applyAccessToken(merged, currentToken, { keepAssistantBearer: true })
    }
    return config.credential
  }
  // 认证失败路径：先重读本地，再无脑强制续一次（不看冷却、不看剩余时间）。
  config.forceRefreshCredential = async () => {
    try {
      config.refreshCredential()
    } catch {
      // 本地文件读失败不该挡住网络续期
    }
    if (config.tokenRefresher) {
      try {
        await config.tokenRefresher.ensureFresh({ force: true, reason: 'auth-error' })
      } catch {
        // 续期失败保持旧凭据，由调用方照常报认证错误
      }
    }
    return config.credential
  }
  return config
}

/** 后端 stderr 一行诊断（插件 detach 时由 logFile 收走，否则随父进程 stderr）。
 * 只在异常路径调用，正常回合保持 stderr 干净。 */
function warnLine(message) {
  try {
    process.stderr.write(`orchaterm2api: ${message}\n`)
  } catch {
    // stderr 断了也不能影响正在进行的响应
  }
}

/** 认证类上游错误的判据（用于触发「刷新凭据 + 重试一次」）。 */
const AUTH_ERROR_RE = /Invalid or expired AccessToken|NEED_UIN_AND_SKEY|VERIFY_USER_FAILED|assistant_unavailable/i

/**
 * 调用级「原始工具信封」记忆：callId → 上游下发的 tool 对象（type/name/mcpServer/args 原样）。
 *
 * 官方协议回传工具结果必须带**原样的 tool 对象**（`reportToolResult` 的 `tool` 字段）；
 * DSH 侧只有映射后的工具名/参数，这里在下发时把原件存起来，回传时按 tool_call_id 取回。
 * LRU 有界；进程重启丢失后由 `reconstructOrcaTool` 兜底重建。
 */
const ORIG_TOOL_BY_CALL = new Map()
const ORIG_TOOL_MAX = 512
function rememberOriginalTool(callId, tool) {
  if (!callId || !tool) return
  ORIG_TOOL_BY_CALL.delete(callId)
  ORIG_TOOL_BY_CALL.set(callId, tool)
  while (ORIG_TOOL_BY_CALL.size > ORIG_TOOL_MAX) ORIG_TOOL_BY_CALL.delete(ORIG_TOOL_BY_CALL.keys().next().value)
}

/**
 * 调用级「这是提问」标记：callId → 上游 ask 信封。
 *
 * 提问信封里没有 tool 对象，回传时走的也不是 reportToolResult —— 官方对「答复提问」
 * 用的是 respondToAsk（模块 2481 `at`）：`{type:'ask', input:<用户答复原文>}`。
 * 光靠 ORIG_TOOL_BY_CALL 分不出这两种回传，所以另记一张表。
 * 与 ORIG_TOOL_BY_CALL 同寿命、同容量策略。
 */
const ORCA_ASK_BY_CALL = new Map()
function rememberAskEnvelope(callId, envelope) {
  if (!callId || !envelope) return
  ORCA_ASK_BY_CALL.delete(callId)
  ORCA_ASK_BY_CALL.set(callId, envelope)
  while (ORCA_ASK_BY_CALL.size > ORIG_TOOL_MAX) ORCA_ASK_BY_CALL.delete(ORCA_ASK_BY_CALL.keys().next().value)
}

/**
 * 本轮消息里哪些 tool_call_id 是「上游提问」。
 * 只看最后一个 assistant 声明的调用 —— 只有它的结果会出现在本轮工具结果里。
 * @param {Array} messages OpenAI 形态消息数组
 * @returns {Set<string>} 可能是空集
 */
function askCallIdsOf(messages) {
  const out = new Set()
  if (ORCA_ASK_BY_CALL.size === 0) return out
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'assistant') {
      for (const call of Array.isArray(list[i]?.tool_calls) ? list[i].tool_calls : []) {
        const id = String(call?.id ?? '')
        if (id !== '' && ORCA_ASK_BY_CALL.has(id)) out.add(id)
      }
      break
    }
  }
  return out
}

/**
 * 从 DSH 工具调用反向重建 orca tool 对象（重启丢档时的兜底）。
 * 与 resolveDshToolCall 的正向映射互逆；包不认识的字段原样带回。
 */
function reconstructOrcaTool(dshName, argsText) {
  let args = {}
  try { args = JSON.parse(argsText) } catch { /* 保持空对象 */ }
  const map = {
    pwsh: () => ({ name: 'execute_command', args: { command: args.command ?? '', ...(args.description ? { description: args.description } : {}) } }),
    bash: () => ({ name: 'execute_command', args: { command: args.command ?? '' } }),
    read: () => ({ name: 'remote_read', args: { path: args.file_path ?? '' } }),
    write: () => ({ name: 'remote_write', args: { path: args.file_path ?? '', content: args.content ?? '' } }),
    glob: () => ({ name: 'remote_glob', args: { pattern: args.pattern ?? '*' } }),
    grep: () => ({ name: 'remote_grep', args: { pattern: args.pattern ?? '' } }),
  }
  const build = map[dshName]
  const { name, args: orcaArgs } = build ? build() : { name: dshName, args }
  return { type: 'mcp', mcpServer: 'mcp-server-orcaterm-oauth', name, args: orcaArgs }
}

/**
 * 凭据临期/过期时把它弄新：先本地重读，再向官方 `OAuthRefreshToken` 换新。
 *
 * 判据：剩余寿命未知（exp 解析不出），或距过期不足 `tokenRefreshLeadMs`（默认 10 分钟）。
 * 健康时零 IO、零网络；续期失败只记一行诊断，仍用现有凭据（调用方照常拿到真实报错）。
 *
 * @param {object} config buildConfig 的产物
 * @returns {Promise<object>} 当前应使用的 credential（可能是刚续期/刚重读的）
 */
export async function ensureFreshCredential(config) {
  if (!config || typeof config !== 'object') return config?.credential
  const lead = Number.isFinite(Number(config.tokenRefreshLeadMs))
    ? Number(config.tokenRefreshLeadMs)
    : DEFAULT_REFRESH_LEAD_MS
  if (tokenRemainingMs(config.credential) > lead) return config.credential

  // 1) 本地重读：桌面端如果正在跑，往往已经替我们续过了（零网络）。
  if (typeof config.refreshCredential === 'function') {
    try {
      config.refreshCredential()
    } catch {
      // 登录态文件不可读：继续走网络续期
    }
  }
  if (tokenRemainingMs(config.credential) > lead) return config.credential

  // 2) 官方续期动作（OAuthRefreshToken）。关掉就退回 v0.5.x 的纯重读行为。
  if (config.tokenRefreshEnabled === false || typeof config.tokenRefresher?.ensureFresh !== 'function') {
    return config.credential
  }
  const outcome = await config.tokenRefresher.ensureFresh({})
  if (outcome && outcome.ok === false && outcome.skipped !== 'cooldown') {
    // 同一类失败只吵一次（比如从没登录过 OrcaTerm 时，巡检每 5 分钟都会 NO_TOKEN）。
    if (config._lastRefreshWarnCode !== outcome.code) {
      config._lastRefreshWarnCode = outcome.code
      warnLine(`AccessToken 续期失败（${outcome.code}）：${outcome.message}；本轮先用现有凭据`)
    }
  } else if (outcome?.ok === true) {
    config._lastRefreshWarnCode = ''
  }
  return config.credential
}

/** 会话级「已交付正文」记忆：喂给重复剥离器，防同一段正文在下一轮再露一次脸。 */
const DELIVERED = createDeliveredHistory()

/** 零输出救援的会话映射：宿主映射的旧 cid → 救援时启用的新 cid。
 * 只在「上游对旧 cid 持续零输出」时记录（见 serveChat 的零输出救援）；
 * 进程重启丢失后由零输出检测重新发现，无需持久化。 */
const RESCUED_CID = new Map()
const RESCUED_CID_MAX = 64

/** 本机 POSIX shell（Git Bash / WSL 等）：用来承接上游按 Linux 主机写出来的命令。 */
const POSIX_SHELL = resolvePosixShell()

/** 执行环境自述：写进上游提示词，减少模型把命令写成另一个 shell 的语法。 */
const ENV_PROMPT = describeExecutionHost({ posixShell: POSIX_SHELL })

async function handleModels(config, res) {
  // token 临期/过期时先续期（本地重读 → OAuthRefreshToken），再发 CGI。
  await ensureFreshCredential(config)
  // 两次 CGI 并发：串行时冷启动要 5s+，会把上层「拿不到就回落静态清单」的超时吃掉。
  const [byo, setting] = await Promise.all([
    cgiCall(config, 'DescribeAIModelList', {}),
    cgiCall(config, 'DescribeUserAiSetting', {}),
  ])
  const data = { object: 'list', data: [] }
  if (byo.ok && Array.isArray(byo.data)) {
    for (const m of byo.data) {
      if (!m || typeof m.id !== 'string') continue
      data.data.push({
        id: m.id,
        object: 'model',
        owned_by: 'orcaterm-byo',
        name: m.name || m.id,
        // BYO 模型同样标 image：宿主据此放行带图会话，图片在宿主侧转述成文字。
        modalities: ['text', 'image'],
        ...(typeof m.provider === 'string' ? { provider: m.provider } : {}),
      })
    }
  }
  const configuredDefaultId = setting.ok && typeof setting.data?.modelId === 'string' ? setting.data.modelId : ''
  const defaultId = configuredDefaultId === 'deepseek-v3::deepseek-v4.1-flash'
    ? 'deepseek-v4.1-flash'
    : configuredDefaultId
  for (const m of BUILTIN_MODELS) {
    data.data.push({
      id: m.id,
      object: 'model',
      owned_by: 'orcaterm-builtin',
      name: m.name,
      description: m.description,
      context_window: m.contextWindow,
      modalities: m.modalities,
      ...(m.id === defaultId ? { is_default: true } : {}),
    })
  }
  json(res, 200, data)
}

async function handleChat(config, req, res) {
  const payload = await readJson(req)
  if (payload === null) return json(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } })

  // token 临期/过期时先续期：历史上「Invalid or expired AccessToken」的根源就是
  // 代理启动后一直揣着过期快照。续期失败也只会走到下面的 assistantReady 检查。
  await ensureFreshCredential(config)

  if (!config.credential.assistantReady) {
    // 上游会原话回 NEED_UIN_AND_SKEY；提前判定避免一次无效外发。
    // 这里只报事实，「下一步做什么」归插件的 HINTS —— 两处都写就成了重复文案。
    return json(res, 401, {
      error: {
        message: new AssistantUnavailableError().message,
        type: 'authentication_error',
        code: 'assistant_unavailable',
      },
    })
  }

  // 工具结果回传信封的逐轮覆盖（live A/B 与回归测试用）：`orca_result_envelope: 'ask'|'review'`。
  // 默认取配置；显式传了就以请求为准，省得为了换一次形态重启后端。
  const resultEnvelope = payload.orca_result_envelope === 'ask' || payload.orca_result_envelope === 'review'
    ? payload.orca_result_envelope
    : config.resultEnvelope
  const { content, history, type, toolResultText, reviewInput } = toAssistantInput(payload.messages, {
    resultEnvelope,
    askCallIds: askCallIdsOf(payload.messages),
    // 压缩摘要轮：provider 逐轮标注本轮用途（宿主给辅助调用打的 purpose）。
    // 后端据此走普通 start 路径并带上 historyMessages —— 待压缩的对话必须到上游，
    // 否则摘要与对话无关（见 toAssistantInput 的 isCompaction 说明）。
    purpose: typeof payload.orca_purpose === 'string' ? payload.orca_purpose : '',
  })
  // 本轮是否发历史：默认不发（上游会回灌污染正文）；但调用方做「上下文对账」后判定需要
  // 补发时（换新会话同步 DSH 的压缩结果）可以逐轮覆盖 —— provider 传 orca_send_history。
  const sendHistory = config.sendHistoryMessages === true || payload.orca_send_history === true
  // 官方 generateConversationId（模块 72535）：`cid-{id}` + `-{assistant}`（assistant≠lighthouse）
  // + `-{mode}`（mode≠0）。orcaterm 的 assistant 名不是 lighthouse、mode 0 = RE_ACT，
  // 所以官方会话 ID 形如 `cid-<uuid>-orcaterm` —— 这里对齐同一形态。
  // 零输出救援的记忆：宿主映射的 cid 一旦被上游卡死（持续零输出），后续轮次直接换用
  // 救援会话，不再先撞一次注定零输出的旧 cid —— 见 serveChat 的零输出救援。
  const hostCid = String(req.headers['x-orca-conversation-id'] || payload.user || '')
  const conversationId = RESCUED_CID.get(hostCid) || hostCid || `cid-${newSeqId()}-orcaterm`
  const wantStream = payload.stream === true

  return serveChat(config, req, res, payload, {
    content,
    history,
    type,
    toolResultText,
    reviewInput,
    sendHistory,
    conversationId: String(conversationId),
    cidFromHost: hostCid !== '',
    wantStream,
  })
}

/**
 * 执行一次上游对话回合并按流式/非流式应答。
 * @param {object} config
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} payload 已解析的 OpenAI 请求体
 * @param {{content:string, history:Array, conversationId:string, wantStream:boolean, type?:string, toolResultText?:string, sendHistory?:boolean, authRetried?:boolean}} round
 */
async function serveChat(config, req, res, payload, round) {
  const { wantStream } = round
  const content = round.content
  const seqId = newSeqId()
  const body = assistantBody(config, {
    conversationId: round.conversationId,
    content,
    type: round.type,
    toolResultText: round.toolResultText,
    reviewInput: round.reviewInput,
    // 官方对齐：input.id 与 x-seqid 是同一个值（模块 2481 的 Fe）。
    inputId: seqId,
    model: payload.model || config.model,
    history: round.history,
    tools: toUpstreamTools(payload.tools),
    enableThinking: payload.reasoning_effort !== 'none' && payload.reasoning !== false,
    thinkingLevel: payload.reasoning_effort === 'low' ? 'low' : (payload.reasoning_effort === 'max' ? 'max' : 'high'),
    envPrompt: ENV_PROMPT,
    sendHistoryMessages: round.sendHistory === true,
  })
  const url = assistantQuery(config)

  // 传输层重试。官方对 reportToolResult 的回传语义（模块 32804 `SE` + 桌面 bundle 调用点）：
  //   attempts=3, timeoutMs=15e3, operationName='回传工具结果', baseDelayMs=300, maxDelayMs=1500
  //
  // ⚠️ 官方那个 15s 是 `withTimeout` 包住一个 **Promise**：超时只「停止等待」并重试，
  //    实现里只有 setTimeout + reject，**没有任何 AbortSignal**（错误文案也是
  //    「回传工具结果 在 15000ms 内没有返回。」/「超时，已停止自动等待。」）。
  //    早先本文件把它实现成 `AbortSignal.timeout(15s)` 挂在 fetch 上，等于给**整个 SSE body**
  //    加了 15s 硬墙 —— 工具结果轮里模型正常作答（实测 reasoning 正在流）也会在第 15 秒被掐断，
  //    DSH 侧表现为「本轮运行失败 orchaterm-web-api 错误: The operation was aborted due to timeout」，
  //    内核再重试 2 次、每次都同样失败（实报：session-21bd31eb / session-8b10359d）。
  //    正确口径：15s 只约束「上游是否受理这次回传」（拿到响应头）；头一到就撤表，
  //    随后的流式答案交给 streamIdleTimeoutMs（180s 空闲判定）—— 那才是「流卡住」的判据。
  const isToolReport = round.reviewInput != null
  const reportTimeoutMs = Math.max(0, Number(config.reportRetryTimeoutMs ?? REPORT_RETRY_TIMEOUT_MS) || 0)
  let upstream
  let lastFetchErr = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // 受理阶段计时器：只覆盖到「拿到响应头」。0 = 不设这一阶段的上限。
    const acceptCtrl = isToolReport && reportTimeoutMs > 0 ? new AbortController() : null
    let acceptTimer = null
    if (acceptCtrl) {
      acceptTimer = setTimeout(() => {
        acceptCtrl.abort(new Error(`回传工具结果 在 ${reportTimeoutMs}ms 内没有返回。`))
      }, reportTimeoutMs)
    }
    const clearAcceptTimer = () => {
      if (acceptTimer === null) return
      clearTimeout(acceptTimer)
      acceptTimer = null
    }
    // 客户端掐断信号（DSH 用户点停止）必须始终生效 —— 与受理计时器**合并**而不是互相覆盖
    // （原先两个 `signal` 键写在同一对象里，后者会静默吃掉前者）。
    const signals = [acceptCtrl?.signal, payload._signal].filter(Boolean)
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: assistantHeaders(config, seqId),
        body: JSON.stringify(body),
        ...(signals.length === 0 ? {} : { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) }),
      })
      // 头到了 = 上游已受理这次回传：撤掉受理计时器，别让它掐断后面的正文流。
      clearAcceptTimer()
      // 服务端滑动续期：任何已认证响应都可能回一枚新 token（官方 onServerTokenRefreshed）。
      config.absorbServerToken?.(upstream.headers.get('x-ot-token-refreshed'))
      if (upstream.ok || upstream.status < 500) break
      // 5xx 也要按官方退避再试，不能立刻重发（原先这条分支直接落到下一轮、跳过了退避）。
      if (attempt < 3) await new Promise((r) => setTimeout(r, reportRetryBackoffMs(attempt - 1)))
    } catch (error) {
      clearAcceptTimer()
      lastFetchErr = error
      if (attempt < 3) {
        const delay = isToolReport ? reportRetryBackoffMs(attempt - 1) : 600
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
    }
  }

  if (!upstream) {
    return json(res, 502, { error: { message: `assistant 请求失败: ${lastFetchErr?.message || lastFetchErr}`, type: 'api_error' } })
  }

  const contentType = upstream.headers.get('content-type') || ''
  if (!upstream.ok || !contentType.includes('event-stream')) {
    const raw = await upstream.text().catch(() => '')
    let message = raw.slice(0, 400)
    try {
      const parsed = JSON.parse(raw)
      message = parsed?.message || parsed?.error?.message || message
    } catch { /* 原样透出 */ }
    // 认证类错误（如 token 刚过期、上游刚换了新值）：强制续期后重试一次。
    // 此处响应头还没写过（上面所有分支都走 json()），重入是安全的。
    if (AUTH_ERROR_RE.test(message) && round.authRetried !== true) {
      await config.forceRefreshCredential?.()
      return serveChat(config, req, res, payload, { ...round, authRetried: true })
    }
    const code = /NEED_UIN_AND_SKEY/i.test(message) ? 'assistant_unavailable' : 'upstream_error'
    return json(res, code === 'assistant_unavailable' ? 401 : 502, {
      error: { message, type: code === 'assistant_unavailable' ? 'authentication_error' : 'api_error', code },
    })
  }

  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-orca-${seqId.slice(0, 8)}`
  const model = payload.model || config.model || 'orcaterm'
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const head = (delta, finish = null) => send({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  })

  // 流式响应头惰性初始化：纯问候语回合要在读完全量后重试，
  // 提前 writeHead 会让 HTTP 语义不允许第二次 200。
  let streamStarted = false
  const beginStream = () => {
    if (streamStarted || !wantStream) return
    streamStarted = true
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-orca-seqid': seqId,
      'x-orca-conversation-id': round.conversationId,
    })
    head({ role: 'assistant' })
  }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let reasoning = ''
  let toolCalls = 0
  let terminal = null
  // 官方 offset 语义（模块 2481：streamChunkOffset.count = 已消费的 data item 数），
  // 断流续传时作为 /stream/resume 的 offset 上报。
  let frameCount = 0

  // 官方 stop 语义（模块 2481 jt）：客户端停止 = 本地断流 + 通知服务端中止该会话的流。
  // DSH 用户点停止时 provider 会掐断到反代的连接 —— 这里感知「流没走完客户端就走了」，
  // fire-and-forget 地给上游补一刀 /stream/abort，避免上游继续为已无人听的会话烧 token。
  let clientGone = false
  res.on('close', () => { clientGone = true })

  const pushDelta = (delta) => { if (wantStream) { beginStream(); head(delta) } }

  // 上游返回的 content 是分片拼接的 Agent 协议 JSON：
  // 1) 正常回答：{"action":"completion","thinking":"思维链…","taskCompletion":"实际回复内容..."}
  // 2) 提问工具：{"action":"ask","question":"向用户询问的内容...","options":[...]}
  // 多字段状态机逐字符解包（thinking→推理流，taskCompletion/question→正文），毫秒级打字机流式，避免 raw JSON 外露。
  let unwrapState = 'SEEK_KEY'
  let unwrapBuf = ''
  let inEscape = false
  let plainTextFallback = ''
  let hasEmittedTarget = false
  let currentField = null

  // ── 问候语剥离 ─────────────────────────────────────────────
  // LightAI 网关会在每个回合正文前注入产品欢迎语（首轮整条、后续轮作为前缀拼接），
  // 且随正式内容一起提交（不是 remove- 草稿），只能在输出侧做流式前缀剥离。
  const greeting = createGreetingStripper()

  // ── <thinking> 标签改道 ───────────────────────────────────
  // 模型偶尔把思维链同时写进信封 thinking 字段和 taskCompletion 正文里的字面
  // <thinking> 标签（session-fb62c7fd turn 3 实测）——后者会原样漏进用户可见正文。
  // 这里把标签块吃掉、内容转成 reasoning 流。
  const thinkingTag = createThinkingTagRouter({
    onReasoning: (text) => {
      reasoning += text
      pushDelta({ reasoning_content: text })
    },
  })

  // ── 重复正文剥离 ───────────────────────────────────────────
  // 上游会把上一轮的正文（尤其是我们发上去的 historyMessages）原样再吐一遍，
  // 且下一轮的历史又包含这一段，重复逐轮叠加。这里按会话记住「已经交付过的正文」，
  // 在新一轮输出开头整段吃掉它 —— 需要重开历史时也不必改上游。
  const repeat = createRepeatStripper([
    ...DELIVERED.textsFor(round.conversationId),
    ...(round.sendHistory === true ? (round.history || []).map((h) => h?.content || '') : []),
  ])

  // ── 工具信封拦截与 DSH 契约双向适配 ──────────────────────
  // OrcaTerm Agent 的 MCP 工具调用协议：{"action":"review|execute|...","tool":{type,name,args}}
  // 拦截后智能映射为 DSH 本机工具契约（如 execute_command -> pwsh/bash，remote_read -> read 等），
  // 并以标准 OpenAI tool_calls delta 下发，驱动 DSH 本地执行并回传工具结果。
  // 信封识别统一走 recoverToolEnvelope（严格 JSON 失败时按容错路径恢复），不再直接用
  // 严格版 parseToolEnvelope —— 模型偶发的非法 JSON 会让严格版整包失败（见 agent-protocol.js §10）。

  let toolCallSeq = 0
  const lastToolCalls = []
  function emitToolCall(obj) {
    toolCallSeq += 1
    const rawTool = obj.tool || {}
    const resolved = resolveDshToolCall(rawTool, payload.tools, { posixShell: POSIX_SHELL })
    const callObj = {
      index: toolCallSeq - 1,
      id: `call_orca_${seqId.slice(0, 8)}_${toolCallSeq}`,
      type: 'function',
      function: {
        name: resolved.name,
        arguments: typeof resolved.arguments === 'string' ? resolved.arguments : JSON.stringify(resolved.arguments),
      },
    }
    // 记住信封原件：官方协议回传结果要求带原样 tool 对象，按 callId 在回传轮取回。
    rememberOriginalTool(callObj.id, rawTool)
    lastToolCalls.push(callObj)
    toolCalls += 1
    pushDelta({
      tool_calls: [callObj],
    })
  }

  // 调用方是否声明了 ask_user_question —— 上游提问信封只有在宿主真能开弹窗时才转成工具调用，
  // 否则退回「正文 + 选项清单」，避免下发一个宿主执行不了的工具名。
  const askToolDeclared = (Array.isArray(payload.tools) ? payload.tools : [])
    .some((item) => (item?.function?.name || item?.name) === ASK_TOOL_NAME)

  /**
   * 上游提问信封 → DSH ask_user_question 工具调用。
   *
   * 官方客户端拿到 `{action:'ask',question,options}` 时开的是带选项的提问对话框
   * （信封里带 options 正是为此），DSH 侧对应的就是 ask_user_question。
   * 转成工具调用后，答案按官方 respondToAsk 形态（`{type:'ask',input:<答复>}`）回传。
   *
   * @param {object} obj 上游 ask 信封
   * @returns {boolean} 是否真的下发了工具调用
   */
  function emitAskToolCall(obj) {
    if (!askToolDeclared) return false
    const args = askEnvelopeToQuestionTool(obj, { idPrefix: `orca-q-${seqId.slice(0, 8)}` })
    if (!args) return false
    toolCallSeq += 1
    const callObj = {
      index: toolCallSeq - 1,
      id: `call_orca_ask_${seqId.slice(0, 8)}_${toolCallSeq}`,
      type: 'function',
      function: { name: ASK_TOOL_NAME, arguments: JSON.stringify(args) },
    }
    // 提问不是工具执行结果：标记 callId，回传轮据此走 respondToAsk 而不是 reportToolResult。
    rememberAskEnvelope(callObj.id, obj)
    lastToolCalls.push(callObj)
    toolCalls += 1
    pushDelta({ tool_calls: [callObj] })
    return true
  }

  // 所有正文统一出口（两级）：
  //   pipeContent —— fenced 工具信封拦截 + 下发（已过全部滤镜的正文才进这里）
  //   emitContent —— 问候语剥离 → 重复正文剥离 → pipeContent
  // emittedText：真正下发给客户端的正文（非流式响应用它作 content）。
  let emittedText = ''

  // 跨帧围栏守卫：信封被切成多帧时，逐帧正则永远等不到同时含首尾围栏的那一帧，
  // 原始 JSON 就会漏给用户（实测 session-dba58595 turn 8）。守卫把疑似块挂起到闭环再判定。
  const fenceGuard = createEnvelopeFenceGuard()

  /**
   * 把被打断的思考链尾段改道进 reasoning。
   *
   * 畸形信封里 thinking 常被未转义引号截断，状态机只吐出了前半段；兜底恢复能取到完整值，
   * 差额补进 reasoning —— 否则这段思考会随原始 JSON 一起漏进正文。
   */
  function appendReasoningTail(full) {
    if (!full || full === '') return
    if (!full.startsWith(reasoning)) return
    const tail = full.slice(reasoning.length)
    if (tail === '') return
    reasoning += tail
    pushDelta({ reasoning_content: tail })
  }

  /**
   * 判定一个 fenced 块：是工具信封就转工具调用，不是就**原样**放行（含围栏，不丢字）。
   * @param {string} block 块原文（含 ``` 围栏）
   * @returns {boolean} 是否识别成了工具信封
   */
  function handleCandidate(block) {
    const recovered = recoverToolEnvelope(block)
    if (recovered) {
      appendReasoningTail(recovered.thinking)
      // 畸形信封是模型侧的输出缺陷，但要留痕：否则「这一轮为什么有工具调用」事后无从查起。
      if (recovered.recovered) {
        warnLine(`本回合的信封不是合法 JSON，已按兜底恢复：tool=${recovered.envelope?.tool?.name || '?'}`
          + ` action=${recovered.envelope?.action || '?'} argsRecovered=${recovered.argsRecovered}`)
      }
      emitToolCall(recovered.envelope)
      return true
    }
    pushDelta({ content: block })
    emittedText += block
    return false
  }

  function pipeContent(delta) {
    if (!delta) return
    const step = fenceGuard.feed(delta)
    if (step.emit) {
      pushDelta({ content: step.emit })
      emittedText += step.emit
    }
    if (step.candidate) handleCandidate(step.candidate)
  }

  function emitContent(delta) {
    delta = greeting.feed(delta)
    if (!delta) return
    delta = repeat.feed(delta)
    if (!delta) return
    delta = thinkingTag.feed(delta)
    if (!delta) return
    pipeContent(delta)
  }

  /** 流收尾：先把各级滤镜的滞留缓冲放出来，顺序不能颠倒。 */
  function flushContent() {
    const greetTail = greeting.flush()
    if (greetTail) emitContent(greetTail)
    // thinkingTag 兜底放行：等不到闭标签的 <thinking> 片段按正文吐出（宁可漏改道不能吞正文）
    const tagTail = thinkingTag.flush()
    if (tagTail) pipeContent(tagTail)
    pipeContent(repeat.flush())
    // 围栏守卫放最后：挂起期间它吞下了后续所有正文（含上面这些 tail），
    // 所以在最后交还才能保持原序；放行前仍按信封判定一次，不浪费这次拦截机会。
    const heldStep = fenceGuard.flush()
    if (heldStep.emit) {
      pushDelta({ content: heldStep.emit })
      emittedText += heldStep.emit
    }
    if (heldStep.candidate) handleCandidate(heldStep.candidate)
  }

  function feedUnwrap(chunk) {
    if (!chunk) return
    unwrapBuf += chunk
    plainTextFallback += chunk

    // 多字段循环解包：同一信封里三个字符串字段都要（2026-10-25 实测，deepseek 槽位把思维链
    // 放在信封的 "thinking" 字段里，而不是 SSE 的 reasoningContent 帧 —— 只认 taskCompletion
    // 会把整段思维链静默丢掉，dsh web 端就表现为「全程看不到推理」）。
    // 字段在 JSON 字符串内的引号必为 \"，所以裸 "key" 只可能是真键，扫描安全。
    for (;;) {
      if (unwrapState === 'SEEK_KEY') {
        const targets = [
          ['"thinking"', 10, 'reasoning'],
          ['"taskCompletion"', 16, 'content'],
          ['"question"', 10, 'content'],
        ]
        let bestIdx = -1
        let best = null
        for (const [needle, len, kind] of targets) {
          const idx = unwrapBuf.indexOf(needle)
          if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
            bestIdx = idx
            best = { len, kind }
          }
        }
        if (!best) break
        unwrapBuf = unwrapBuf.slice(bestIdx + best.len)
        currentField = best.kind
        unwrapState = 'SEEK_VAL'
      }

      if (unwrapState === 'SEEK_VAL') {
        const colonIdx = unwrapBuf.indexOf(':')
        if (colonIdx === -1) break
        const afterColon = unwrapBuf.slice(colonIdx + 1)
        const quoteIdx = afterColon.indexOf('"')
        if (quoteIdx === -1) break
        unwrapBuf = afterColon.slice(quoteIdx + 1)
        unwrapState = 'IN_STRING'
        if (currentField === 'content') hasEmittedTarget = true
      }

      if (unwrapState === 'IN_STRING') {
        let delta = ''
        let i = 0
        const field = currentField
        for (; i < unwrapBuf.length; i += 1) {
          const ch = unwrapBuf[i]
          if (inEscape) {
            if (ch === 'n') delta += '\n'
            else if (ch === '"') delta += '"'
            else if (ch === '\\') delta += '\\'
            else if (ch === 't') delta += '\t'
            else if (ch === 'r') delta += '\r'
            else delta += ch
            inEscape = false
          } else if (ch === '\\') {
            inEscape = true
          } else if (ch === '"') {
            unwrapState = 'SEEK_KEY' // 继续找下一个字段，而不是结束
            currentField = null
            i += 1
            break
          } else {
            delta += ch
          }
        }
        unwrapBuf = unwrapBuf.slice(i)
        if (delta && field) {
          if (field === 'reasoning') {
            // 思维链：直接以 reasoning_content 下发（不走正文滤镜——问候语/重复剥离只该管正文），
            // 非流式时并入 message.reasoning_content。
            reasoning += delta
            pushDelta({ reasoning_content: delta })
          } else {
            emitContent(delta)
          }
        }
        if (unwrapState !== 'SEEK_KEY') break // 字符串没读完（缓冲耗尽），等下一帧
      }
    }
  }

  function finishUnwrap() {
    // 围栏守卫还挂着东西时，这一整包的归属权归它（它已把围栏前的正文与围栏后的尾巴放行，
    // 挂起块会在 flushContent 里连同判定一起处理）——这里再走一遍就会重复下发。
    if (!hasEmittedTarget && !fenceGuard.holding() && plainTextFallback.trim()) {
      // 整包到达时的兜底：优先识别工具信封 —— 这里必须用**容错**恢复。
      // 模型偶发把信封写成非法 JSON（实测：thinking 值里带未转义的 "），严格 JSON.parse 必死；
      // 若就此退化成「原文当正文」，用户会看到一整块 ```json 且工具调用丢失（session-dba58595 turn 8）。
      const recovered = recoverToolEnvelope(plainTextFallback)
      if (recovered) {
        appendReasoningTail(recovered.thinking)
        if (recovered.recovered) {
          warnLine(`本回合的信封不是合法 JSON，已按兜底恢复：tool=${recovered.envelope?.tool?.name || '?'}`
            + ` action=${recovered.envelope?.action || '?'} argsRecovered=${recovered.argsRecovered}`)
        }
        emitToolCall(recovered.envelope)
        return
      }
      let fallbackText = plainTextFallback
      let fallbackThinking = ''
      // 提问信封先存着、晚点再下发：正文要在工具调用之前，顺序不能倒。
      let askObj = null
      try {
        const clean = plainTextFallback.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
        const obj = JSON.parse(clean)
        fallbackText = obj.taskCompletion || obj.question || obj.content || obj.text || plainTextFallback
        if (typeof obj.thinking === 'string' && obj.thinking !== '') fallbackThinking = obj.thinking
        if (obj.action === 'ask' && typeof obj.question === 'string') askObj = obj
        // 能转成 ask_user_question 时选项会进弹窗，正文里不再重复列一遍。
        if (askObj === null && Array.isArray(obj.options) && obj.options.length > 0) {
          fallbackText += `\n\n**选项：**\n${obj.options.map((o) => `- ${o}`).join('\n')}`
        }
      } catch { /* 非 JSON，原文兜底 */ }
      if (fallbackThinking) {
        reasoning += fallbackThinking
        pushDelta({ reasoning_content: fallbackThinking })
      }
      emitContent(fallbackText)
      if (askObj !== null) emitAskToolCall(askObj)
    } else if (hasEmittedTarget) {
      // 如果触发了 ask 提问工具且带 options 选项，将选项追加到末尾
      try {
        const clean = plainTextFallback.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
        const obj = JSON.parse(clean)
        // 提问信封：转成 ask_user_question 工具调用（DSH 侧开提问弹窗）。
        // 正文已经流式吐出去了（问题原文照常可见），这里只补工具调用；
        // 转成功就不再追加「**选项：**」清单 —— 选项在弹窗里，重复列一遍反而像两套 UI。
        const askToolEmitted = obj.action === 'ask' && typeof obj.question === 'string'
          ? emitAskToolCall(obj)
          : false
        if (!askToolEmitted && Array.isArray(obj.options) && obj.options.length > 0) {
          const optsText = `\n\n**选项：**\n${obj.options.map((o) => `- ${o}`).join('\n')}`
          pushDelta({ content: optsText })
          emittedText += optsText
        }
      } catch { /* 非 JSON，无 options 追加 */ }
    }
  }

  /** 单帧处理（主流与续流共用）。 */
  function processLine(line) {
    const frame = classifyDataLine(line)
    if (frame.kind === 'done') { terminal = 'done'; return }
    if (frame.kind === 'aborted') { terminal = 'aborted'; return }
    if (frame.kind === 'error') {
      terminal = 'error'
      // 流内认证错误（头已发出，本轮没法重试了）：强制续期，让下一轮拿到新 token。
      // 这里不能 await（在流式解析循环里），续期是幂等的单飞请求。
      if (AUTH_ERROR_RE.test(frame.message)) void config.forceRefreshCredential?.()
      if (wantStream) send({ error: { message: frame.message, status: 500 } })
      return
    }
    if (frame.kind !== 'data') return
    // 官方 streamChunkOffset 按全部 data item 计数（onMessage 先 u+=1 再过滤），续流 offset 才能对齐。
    frameCount += 1
    const item = frame.item || {}

    // 1) 坚决过滤非 AI 消息（如上游反射的 human 历史消息）
    if (item.type && item.type !== 'ai') return

    // 2) 遇到上游 Agent 撤销/清空草稿帧，重置未提交的缓冲，防止废弃问候语残留在正文里
    if (item.id && item.id.startsWith('remove-')) {
      if (!hasEmittedTarget) {
        unwrapBuf = ''
        plainTextFallback = ''
      }
      return
    }

    // 上游代执行工具帧（item.tool）与后端工具结果帧（id 形如 run-*-tool-*，
    // 官方判据 zV：/^run-.+-tool-.+/，Jt.onMessage 把它的 fullContent 作为 toolResult 回调）。
    // 都转成可读正文行透出，让「上游在干什么」对用户可见，而不是静默吞掉；
    // 并跳过解包器 —— 结果原文不是 Agent JSON，喂进去只会污染 finishUnwrap 的兜底缓冲。
    const isBackendToolResult = typeof item.id === 'string' && /^run-.+-tool-.+/.test(item.id)
    if (item.tool || isBackendToolResult) {
      toolCalls += 1
      const toolName = item.tool?.name || item.tool?.type || 'tool'
      const toolDesc = typeof item.tool?.description === 'string' ? item.tool.description.slice(0, 120) : ''
      const category = item.tool ? classifyUiToolCategory(item.tool) : ''
      const resultSnippet = isBackendToolResult && typeof item.content === 'string' && item.content.trim()
        ? ` · 结果 ${redactSecrets(item.content).slice(0, 200)}${item.content.length > 200 ? '…' : ''}`
        : ''
      const line2 = `\n\n> ⚙️ [上游工具${category ? `/${category}` : ''}] ${toolName}${toolDesc ? ` — ${toolDesc}` : ''}${resultSnippet}\n`
      pushDelta({ content: line2 })
      emittedText += line2
      return
    }

    // 3) 深度思考
    if (typeof item.reasoningContent === 'string' && item.reasoningContent !== '') {
      reasoning += item.reasoningContent
      pushDelta({ reasoning_content: item.reasoningContent })
    }

    // 4) 正文增量收集并解包
    const itemContent = typeof item.content === 'string' ? item.content : (typeof item.text === 'string' ? item.text : '')
    if (itemContent) {
      feedUnwrap(itemContent)
    }
  }

  /**
   * 泵一个 SSE body 到终止符或流结束（主流与续流共用）。
   *
   * @param {ReadableStreamDefaultReader} bodyReader
   * @param {{idle?:boolean}} [options] `idle: true` 时对「两次 read 之间」加空闲上限
   *   （config.streamIdleTimeoutMs）。续流要用它而不是给整个请求加墙钟上限 ——
   *   同一个误移植模式（见上面回传重试的长注释）：一次正常的续流可能跑几分钟。
   */
  async function pumpStream(bodyReader, options = {}) {
    const idleMs = options.idle === true ? Math.max(0, Number(config.streamIdleTimeoutMs) || 0) : 0
    for (;;) {
      let read
      if (idleMs > 0) {
        let timer = null
        const idle = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(Object.assign(new Error(`续流空闲超过 ${idleMs}ms 没有数据`), { failureCode: 'TIMEOUT' }))
          }, idleMs)
        })
        read = await Promise.race([bodyReader.read(), idle]).finally(() => clearTimeout(timer))
      } else {
        read = await bodyReader.read()
      }
      const { done, value } = read
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        processLine(line)
        if (terminal) break
      }
      if (terminal) break
    }
  }

  try {
    await pumpStream(reader)

    // 官方断流续传（模块 2481 It/Rt）：流异常中断（无 [DONE]/[ERROR]/[ABORTED]、客户端也没走）
    // 时先查 /stream/status —— 仍 running 就 GET /stream/resume/{cid}?offset=<已收帧数> 续流，
    // 解包状态机与滤镜全部原样延续，DSH 侧表现为同一条流。官方 Rt 有单次重入护栏，这里同样只续一次。
    if (terminal === null && !clientGone) {
      try {
        const status = await assistantStreamStatus(config, round.conversationId)
        if (status?.status === 'running') {
          const resumeUrl = streamControlUrl(config, ASSISTANT_PATHS.streamResume, round.conversationId, { offset: String(frameCount) })
          // 续流不设**墙钟**上限：它本来就是为「长跑的 Agent 流」准备的，60s 硬墙会掐掉正常续流
          // （与回传 15s 是同一个误移植模式）。卡住与否交给读循环的空闲判定。
          const resumed = await fetch(resumeUrl, {
            method: 'GET',
            headers: assistantHeaders(config, seqId),
          })
          const resumeType = resumed.headers.get('content-type') || ''
          if (resumed.ok && resumeType.includes('event-stream') && resumed.body) {
            const resumeReader = resumed.body.getReader()
            try {
              await pumpStream(resumeReader, { idle: true })
            } finally {
              try { await resumeReader.cancel() } catch { /* 已关闭 */ }
            }
          }
        }
      } catch { /* 续流失败按原样收尾，不向 DSH 抛新错 */ }
    }

    finishUnwrap()
    // 两级滤镜可能还攥着「尚不能判定」的开头，流结束必须放出来，否则正文会缺头。
    flushContent()
  } catch (error) {
    if (wantStream) send({ error: { message: String(error?.message || error), status: 500 } })
    terminal = 'error'
    flushContent()
  } finally {
    try { await reader.cancel() } catch { /* 流已关闭 */ }
  }

  // 客户端中途掐断连接（DSH 用户点停止）且流没走完：按官方 stop 语义通知上游中止。
  // fire-and-forget：不能因这次外呼拖住响应收尾；assistantAbort 内部自吞错误。
  if (clientGone && terminal === null) {
    void assistantAbort(config, round.conversationId)
  }

  // 纯问候语回合：剥离后零正文、零工具调用且未向客户端写过任何字节 ——
  // 寒暄就回寒暄，把剥离的问候语原样吐回（不改请求、不重试，仅一次）。
  if (!streamStarted && emittedText.trim() === '' && reasoning.trim() === '' && toolCalls === 0
    && (terminal === 'done' || terminal === null)) {
    const greetingOnly = greeting.clearStripped()
    if (greetingOnly) {
      pushDelta({ content: greetingOnly })
      emittedText = greetingOnly
    }
  }

  // ── 零输出救援：映射会话被上游卡死时的自动恢复 ─────────────────────
  // 实测（session-628db98d，2026-10-27）：上游对同一 conversationId 的会话上下文涨到
  // ~32k 后开始 200 + 零输出（此后该 cid 每一轮、换模型都零输出，DSH 侧
  // EMPTY_RESPONSE 重试 2 次后整轮失败）；同一时间窗内新会话（哪怕 127KB 大输入）
  // 完全正常 —— 卡死的是上游按 cid 保存的会话状态，不是账号、不是模型。
  // 宿主每轮都带同一个 cid（provider 的会话映射），本代理按 cid 去重只发增量，
  // 所以旧 cid 一旦卡死就永远救不回来。处理：abort 掉旧 cid 可能残留的僵尸流，
  // 换全新会话 + 补发全量历史（与压缩摘要轮同款模式）重入一次；工具结果信封
  // （review/ask/feedback）引用旧会话的调用 id，新会话认不得，降级为普通 start，
  // 工具结果文本并入 input —— 历史里已带上下文，语义不丢。
  // 判定与 provider 的 EMPTY_RESPONSE 同口径：零正文、零推理、零工具调用，且上游
  // 正常收尾（[DONE] 或无终止符）—— [ERROR]/[ABORTED] 是真实上游错误，已照实透出。
  if (round.cidFromHost === true && round.rescueRetried !== true && !clientGone
    && emittedText.trim() === '' && reasoning.trim() === '' && toolCalls === 0
    && (terminal === 'done' || terminal === null)) {
    void assistantAbort(config, round.conversationId)
    const rescuedCid = `cid-${newSeqId()}-orcaterm`
    if (RESCUED_CID.size >= RESCUED_CID_MAX) RESCUED_CID.delete(RESCUED_CID.keys().next().value)
    RESCUED_CID.set(round.conversationId, rescuedCid)
    warnLine(`会话 ${round.conversationId} 本轮零输出（上游疑似卡死该会话），已换新会话 ${rescuedCid} 补发历史重试`)
    // 换新会话后上游不再按 cid 保留首轮上下文，系统提示必须随本轮补上
    // （对齐首轮的 [系统要求] 前缀形态；已在 content 里就不再重复）。
    let rescueSystemText = ''
    for (const m of Array.isArray(payload.messages) ? payload.messages : []) {
      if (m?.role === 'system' || m?.role === 'developer') {
        const t = typeof m?.content === 'string' ? m.content : ''
        if (t) rescueSystemText = t
      }
    }
    const baseContent = round.content || round.toolResultText || '请继续'
    const sysPrefix = rescueSystemText && !baseContent.includes(rescueSystemText)
      ? `[系统要求] ${rescueSystemText}\n\n`
      : ''
    return serveChat(config, req, res, payload, {
      ...round,
      conversationId: rescuedCid,
      sendHistory: true,
      content: sysPrefix + baseContent,
      reviewInput: undefined,
      toolResultText: undefined,
      type: undefined,
      rescueRetried: true,
    })
  }

  // 记进会话级「已交付正文」：下一轮开头若原样重放这段，重复剥离器负责吃掉。
  DELIVERED.remember(round.conversationId, emittedText)

  if (wantStream) {
    beginStream()
    const finalReason = terminal === 'aborted' ? 'abort' : (toolCallSeq > 0 ? 'tool_calls' : 'stop')
    head({}, finalReason)
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  json(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: emittedText,
        ...(lastToolCalls.length > 0 ? { tool_calls: lastToolCalls } : {}),
        ...(reasoning !== '' ? { reasoning_content: reasoning } : {})
      },
      finish_reason: toolCallSeq > 0 ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    orca: { seqId, conversationId: round.conversationId, toolFrames: toolCalls, terminal },
  })
}

async function handleCgi(config, req, res) {
  const payload = await readJson(req)
  if (payload === null || typeof payload.action !== 'string' || payload.action === '') {
    return json(res, 400, { ok: false, error: { message: '需要 {action, data?}' } })
  }
  const result = await cgiCall(config, payload.action, payload.data ?? {})
  if (!result.ok) {
    const status = result.code === 'AUTH' ? 401 : result.code === 'INVALID_REQUEST' ? 400 : 502
    return json(res, status, { ok: false, ...result })
  }
  json(res, 200, { ok: true, action: payload.action, data: result.data })
}

/**
 * 注册后台续期巡检（对齐 OrcaTerm 桌面端 TokenManager：启动先查一次 + 每 5 分钟一次）。
 * 只做「到期就续」，不主动刷新健康时段的 token；定时器 unref，不阻止进程退出。
 * @returns {() => void} 停止函数
 */
function startTokenRefreshLoop(config) {
  if (config.tokenRefreshEnabled === false || !config.tokenRefresher) return () => {}
  let timer = null
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      await ensureFreshCredential(config)
    } catch (error) {
      warnLine(`AccessToken 续期巡检异常：${error?.message || error}`)
    }
  }
  // 启动即检查：过期凭据在第一个请求到来前就该续好，而不是让用户等一次失败重试。
  void tick()
  const intervalMs = Number(config.tokenRefreshCheckMs || 0)
  if (intervalMs > 0) {
    timer = setInterval(() => { void tick() }, intervalMs)
    timer.unref?.()
  }
  return () => {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }
}

/**
 * 起反代服务。
 * @param {{port?:number, host?:string} & object} options
 * @returns {Promise<{server:import('node:http').Server, port:number, close:()=>Promise<void>}>}
 */
export async function startServer(options = {}) {
  const config = buildConfig(options)
  const host = options.host || '127.0.0.1'
  const port = Number(options.port || 8793)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          status: 'ok',
          version: VERSION,
          capabilities: CAPABILITIES,
          cgiBase: config.cgiBase,
          assistantBase: config.assistantBase,
          // 当前以哪个客户端身份访问上游（desktop / web），便于确认改动已生效。
          clientIdentity: config.clientIdentity,
          credential: redact(config.credential),
          // 自续期状态（只报时间/状态码，不含任何 token 值）。
          tokenRefresh: config.tokenRefreshEnabled === false
            ? { enabled: false }
            : {
              ...(config.tokenRefresher?.state?.() || { enabled: true }),
              checkSec: Math.round(Number(config.tokenRefreshCheckMs || 0) / 1000),
            },
          time: new Date().toISOString(),
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return await handleModels(config, res)
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        return await handleChat(config, req, res)
      }
      if (req.method === 'POST' && url.pathname === '/orca/cgi') {
        return await handleCgi(config, req, res)
      }
      // 流控制通道（官方 /stream/* 的直通口，会话 ID 在路径段；见 upstream.streamControlUrl）。
      // conversationId 优先取请求体/查询串，缺省回退到 x-orca-conversation-id 头。
      if (req.method === 'POST' && url.pathname === '/orca/stream-abort') {
        const body = await readJson(req)
        const cid = String(body?.conversationId || url.searchParams.get('conversationId') || req.headers['x-orca-conversation-id'] || '')
        if (!cid) return json(res, 400, { ok: false, error: { message: '需要 conversationId' } })
        const ok = await assistantAbort(config, cid)
        return json(res, ok ? 200 : 502, { ok, action: 'stream-abort', conversationId: cid })
      }
      if (req.method === 'GET' && url.pathname === '/orca/stream-status') {
        const cid = String(url.searchParams.get('conversationId') || req.headers['x-orca-conversation-id'] || '')
        if (!cid) return json(res, 400, { ok: false, error: { message: '需要 conversationId 查询参数' } })
        const status = await assistantStreamStatus(config, cid)
        return json(res, 200, { ok: status !== null, conversationId: cid, status })
      }
      // 续流直通（官方 Rt）：GET 上游 /stream/resume/{cid}?offset=N，SSE/JSON 原样 pipe 回来。
      // 主要供排障对照；serveChat 内部的断流续传不经过这里。
      if (req.method === 'GET' && url.pathname === '/orca/stream-resume') {
        const cid = String(url.searchParams.get('conversationId') || req.headers['x-orca-conversation-id'] || '')
        const offset = String(url.searchParams.get('offset') || '0')
        if (!cid) return json(res, 400, { ok: false, error: { message: '需要 conversationId 查询参数' } })
        const upstream = await fetch(streamControlUrl(config, ASSISTANT_PATHS.streamResume, cid, { offset }), {
          method: 'GET',
          headers: assistantHeaders(config),
        })
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
        const reader = upstream.body?.getReader()
        if (!reader) { res.end(); return }
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(value)
          }
        } finally {
          try { await reader.cancel() } catch { /* 已关闭 */ }
          res.end()
        }
        return
      }
      // 仅供观察：把将会发出的流控制 URL 暴露出来（不含凭据），便于对照官方抓包。
      if (req.method === 'GET' && url.pathname === '/orca/stream-url') {
        const cid = String(url.searchParams.get('conversationId') || '')
        const kind = String(url.searchParams.get('kind') || 'abort')
        const path = kind === 'status' ? ASSISTANT_PATHS.streamStatus : kind === 'resume' ? ASSISTANT_PATHS.streamResume : ASSISTANT_PATHS.streamAbort
        if (!cid) return json(res, 400, { ok: false, error: { message: '需要 conversationId 查询参数' } })
        return json(res, 200, { ok: true, url: streamControlUrl(config, path, cid) })
      }
      if (req.method === 'GET' && url.pathname === '/orca/quota') {
        const result = await cgiCall(config, 'DescribeUserBillingStatus', {})
        return json(res, result.ok ? 200 : 502, result)
      }
      return json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}`, type: 'invalid_request_error' } })
    } catch (error) {
      // 流式响应可能已 writeHead，此时只能终结 SSE 而不能再写 JSON 状态行
      if (res.headersSent) {
        try { res.end() } catch { /* 已终结 */ }
        return
      }
      return json(res, 500, { error: { message: String(error?.message || error), type: 'api_error' } })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actual = server.address()
  // 后台续期巡检（启动即查一次 + 定时）。unref 定时器，不会吊住进程。
  const stopRefreshLoop = startTokenRefreshLoop(config)
  return {
    server,
    port: actual.port,
    tokenRefreshState: () => config.tokenRefresher?.state?.() ?? { enabled: false },
    close: () => new Promise((resolve) => {
      stopRefreshLoop()
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

export { ASSISTANT_PATHS }

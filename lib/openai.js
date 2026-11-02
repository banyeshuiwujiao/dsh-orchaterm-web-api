/**
 * DSH 消息 ↔ OpenAI 兼容体 的纯函数转换，以及错误码归一。
 *
 * 反代对外说 OpenAI 方言，所以这里只做**方言转换**，不碰 OrcaTerm 的私有协议
 * （私有协议在 backend/ 里翻译完）。纯函数、无 IO，便于单测。
 *
 * @module lib/openai.js
 */

/** 取 block 的文本；非文本 block 返回空串（调用方决定是否告警）。 */
export function textOf(block) {
  if (typeof block === 'string') return block
  if (block && typeof block.text === 'string') return block.text
  return ''
}

/** 图片 media type → 建议的本地落盘扩展名（与宿主 packages/llm/llm/src/content.ts 一致）。 */
const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
})

/**
 * 一张图在「上游只收文本」时给模型看的句柄。
 *
 * 形态对齐宿主 `packages/llm/llm/src/content.ts` 的 `requestImageHandleText()`：
 * 名字 + 内容摘要 + 预览尺寸 + 归一化副本的本地路径（工具执行世界里的只读路径）。
 * 只多一句实话：本路由**不把图片字节发给上游**，免得模型以为自己看到了像素。
 *
 * @param {{attachmentId?:string, name?:string, width?:number, height?:number, mediaType?:string}} ref
 * @param {{readonlyPath?:string}|undefined} access 归一化副本的执行世界路径
 * @returns {string}
 */
export function imageHandleText(ref, access) {
  const attachmentId = String(ref?.attachmentId ?? '')
  const identity = ref?.name === undefined
    ? attachmentId
    : `${JSON.stringify(ref.name)} (${attachmentId})`
  const preview = `Image ${identity}; request preview ${ref?.width}x${ref?.height}px.`
  if (!access?.readonlyPath) {
    return `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
      + ' This route sends no image bytes to the upstream model.'
  }
  return preview
    + ` Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(access.readonlyPath)}`
    + ` (${ref?.width}x${ref?.height}px, ${ref?.mediaType}).`
    + ' Source dimensions, format, and byte size may differ.'
    + ` Copy to a writable path ending in ${IMAGE_EXTENSIONS[ref?.mediaType] ?? '.png'} before editing.`
    + ' This route sends no image bytes to the upstream model.'
}

/**
 * 拆一条 message.content：文本、工具调用、以及真正无法表示的 block 类型。
 *
 * DSH 的 assistant 消息把工具调用放在 `{type:'tool-call', id, name, arguments}` 块里，
 * 必须转成 OpenAI 的 `tool_calls`；否则下游既看不到「调用过什么」，也无法把随后的
 * `role:'tool'` 结果与调用配对。`reasoning` 块是有意不回灌的（只在当轮流式呈现）。
 *
 * `image` 块：上游助手网关只收文本，图片字节发不过去。给了 `options.imageHandle`
 * 就用它产出的句柄文字（识图描述 + 本地副本路径）；没给就按老规矩丢弃。
 *
 * @param {unknown} content
 * @param {{imageHandle?:(ref:object)=>string|undefined}} [options]
 * @returns {{text:string, toolCalls:Array, dropped:string[]}}
 */
export function flattenContent(content, options) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }]
  const texts = []
  const toolCalls = []
  const dropped = []
  for (const block of parts) {
    if (block === null || block === undefined) continue
    if (typeof block === 'string') {
      if (block !== '') texts.push(block)
      continue
    }
    const type = block.type
    if (type === undefined || type === 'text') {
      const value = textOf(block)
      if (value !== '') texts.push(value)
      continue
    }
    if (type === 'tool-call') {
      if (typeof block.id === 'string' && block.id !== '' && typeof block.name === 'string' && block.name !== '') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
          },
        })
      } else {
        dropped.push(type)
      }
      continue
    }
    if (type === 'reasoning') continue // 推理内容不回灌历史
    if (type === 'image') {
      // 上游只收文本：图片以句柄文字的形式随行（见 imageHandleText）。
      const handle = typeof options?.imageHandle === 'function'
        ? options.imageHandle(block.attachment)
        : undefined
      if (typeof handle === 'string' && handle !== '') {
        texts.push(handle)
        continue
      }
      dropped.push(type)
      continue
    }
    dropped.push(type)
  }
  return { text: texts.join('\n'), toolCalls, dropped }
}

/** 工具描述裁剪：0/非正数 = 原样下发。 */
export function clampDescription(text, maxChars) {
  const limit = Number(maxChars)
  const value = String(text ?? '')
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * 把 DSH 的 system + messages 拍成 OpenAI messages。
 *
 * 角色与块的映射（对齐 DSH 的 adapter 契约，`llm/src/message.ts`）：
 * - `system` / `developer` → `system`；
 * - `assistant` → `content` + （若有）`tool_calls`；
 * - `tool` → `{role:'tool', tool_call_id, content}` —— **必须原样透传**：
 *   它是与本插件对上游 Agent 的 `{TOOL_RESULT}` 回传配套的一环，
 *   丢掉它上游就永远收不到工具结果，模型会用同样的参数反复重发同一个工具调用。
 *
 * @param {{system?: string, messages?: Array}} input
 * @param {(msg: string) => void} [warn]
 * @param {{imageHandle?:(ref:object)=>string|undefined}} [options] image 块的句柄产出器
 */
export function formatOpenAiMessages(input, warn, options) {
  const out = []
  const system = typeof input?.system === 'string' ? input.system : ''
  if (system !== '') out.push({ role: 'system', content: system })
  for (const message of Array.isArray(input?.messages) ? input.messages : []) {
    const role = message?.role
    if (role === 'tool') {
      const flat = flattenContent(message.content, options)
      if (flat.text === '') {
        warn?.(`丢弃空内容的工具结果（tool_call_id=${message.toolCallId ?? 'unknown'}）`)
        continue
      }
      out.push({
        role: 'tool',
        tool_call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
        content: flat.text,
      })
      continue
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
      warn?.(`忽略未知角色 ${JSON.stringify(role)}`)
      continue
    }
    const flat = flattenContent(message.content, options)
    for (const type of flat.dropped) warn?.(`丢弃非文本 block（type=${type}）`)
    if (flat.text === '' && flat.toolCalls.length === 0) continue
    out.push({
      role: role === 'developer' ? 'system' : role,
      content: flat.text,
      ...(flat.toolCalls.length > 0 ? { tool_calls: flat.toolCalls } : {}),
    })
  }
  return out
}

/** 工具声明转换：缺 schema 的工具跳过并告警。 */
export function formatOpenAiTools(tools, maxChars) {
  const list = Array.isArray(tools) ? tools : []
  if (list.length === 0) return null
  const mapped = []
  for (const tool of list) {
    if (!tool || typeof tool.name !== 'string' || tool.name === '') continue
    mapped.push({
      type: 'function',
      function: {
        name: tool.name,
        description: clampDescription(tool.description, maxChars),
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    })
  }
  return mapped.length > 0 ? mapped : null
}

/** 反代返回的错误体 → 人可读 message（保留上游原话，便于取证）。 */
export function describeErrorBody(status, rawBody) {
  let detail = String(rawBody ?? '').slice(0, 600)
  let message = detail
  try {
    const parsed = JSON.parse(rawBody)
    const err = parsed?.error ?? parsed
    if (typeof err?.message === 'string' && err.message !== '') {
      message = err.message
      detail = err.message
    }
  } catch {
    // 上游给的是纯文本，原样透出
  }
  return { message: `${message}${message.endsWith('。') ? '' : ''}`, detail, status }
}

/** HTTP 状态 → DSH 失败码。 */
export function failureCodeForStatus(status, detail = '') {
  const code = Number(status)
  if (code === 401 || code === 403) return 'AUTH'
  if (code === 402) return 'QUOTA'
  if (code === 429) return 'RATE_LIMIT'
  if (code === 400 || code === 404 || code === 413 || code === 422) return 'INVALID_REQUEST'
  if (code >= 500) return 'SERVER'
  return `HTTP_${code}`
}

/** 上游文案里的稳定信号 → 失败码（优先于状态码，因为反代可能 200 回错误）。 */
export function failureCodeForMessage(message) {
  const text = String(message ?? '')
  if (/NEED_UIN_AND_SKEY|VERIFY_USER_FAILED|assistant_unavailable/i.test(text)) return 'AUTH'
  if (/quota|余额|额度|insufficient/i.test(text)) return 'QUOTA'
  if (/rate.?limit|限流|too many/i.test(text)) return 'RATE_LIMIT'
  if (/context.*(length|window)|上下文/i.test(text)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (/invalid|参数|not.?match|action/i.test(text) && !/token/i.test(text)) return 'INVALID_REQUEST'
  return ''
}

/** Retry-After（秒或 HTTP 日期）→ 毫秒。 */
export function retryAfterMs(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** 粗估 token：CJK 约 1 字 1 token，其余约 4 字符 1 token。 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  if (value === '') return 0
  let cjk = 0
  for (const ch of value) if (CJK.test(ch)) cjk += 1
  return cjk + Math.ceil((value.length - cjk) / 4)
}

/** 输入侧估算：system + 全部消息 + 工具 schema 一起算，缺一项就会低报数倍。 */
export function estimateInputTokens(messages, tools) {
  let total = 0
  for (const m of Array.isArray(messages) ? messages : []) total += estimateTokens(m?.content)
  if (tools) total += estimateTokens(JSON.stringify(tools))
  return total
}

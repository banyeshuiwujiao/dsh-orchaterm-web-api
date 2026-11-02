/**
 * 宿主侧 describe-first 识图：把图片交给一个 OpenAI 兼容的多模态端点描述成文字。
 *
 * 为什么需要它：上游助手网关的协议是**纯文本**（`content` 就是一串字符串），
 * 图片字节发不过去。DSH Web 侧本来有两条现成的路子：
 *   · magpie（网关侧转述）：只覆盖走 magpie 的 provider；
 *   · dsh-vision（本地多模态）：以工具形式暴露给模型自己调，需要模型主动发起。
 * 本路由既不走 magpie，工具调用又由上游 Agent 代理，于是走第三条：
 * 在**请求装配阶段**先把图片转述成文字再发给上游 —— 语义与 magpie 的 describe-first 一致。
 *
 * 端点配置与 dsh-vision 插件共用同一套环境变量（同一台机器、同一把钥匙）：
 *   VISION_API_KEY / VISION_BASE_URL / VISION_MODEL / VISION_LANG
 * 配齐即启用；没配就退化成「只给本地归一化副本的路径」。
 *
 * @module lib/vision.js
 */

/** 描述提示词：一次把「模型随后要回答的东西」都问出来（中文/英文两版）。 */
const PROMPTS = Object.freeze({
  zh: [
    '请用中文详细描述这张图片的全部可见内容，供一个看不到图片的助手模型使用。',
    '请覆盖：整体场景与主体、界面/物体元素、逐字可见文字、布局与配色、以及任何异常或值得注意之处。',
    '只描述你确实看到的内容，不要猜测；看不清的部分直接说明看不清。',
    '直接给描述正文，不要写“图片显示”这类开场白，也不要给建议或结论。',
  ].join('\n'),
  en: [
    'Describe this image in detail for an assistant model that cannot see images.',
    'Cover: the overall scene and subject, UI or object elements, visible text verbatim, layout and colours,',
    'and anything unusual or noteworthy.',
    'Only describe what you can actually see; do not guess. Say so plainly when something is illegible.',
    'Reply with the description only — no preamble, no advice, no conclusions.',
  ].join('\n'),
})

/**
 * 解析识图端点配置。
 *
 * 显式配置（插件 config）优先，其次环境变量（与 dsh-vision 同源）。
 * 三件套（key/baseUrl/model）缺一不可，否则判定为未启用。
 *
 * @param {object} opts 插件当轮配置
 * @returns {{enabled:boolean, apiKey:string, baseUrl:string, model:string, lang:string, timeoutMs:number, maxTokens:number}}
 */
export function resolveVisionConfig(opts) {
  const env = process.env
  const apiKey = String(opts?.visionApiKey || env.VISION_API_KEY || '')
  const baseUrl = String(opts?.visionBaseUrl || env.VISION_BASE_URL || '').replace(/\/+$/, '')
  const model = String(opts?.visionModel || env.VISION_MODEL || '')
  const lang = String(opts?.visionLang || env.VISION_LANG || 'zh') === 'en' ? 'en' : 'zh'
  const timeoutMs = Number(opts?.visionTimeoutMs) > 0 ? Number(opts.visionTimeoutMs) : 120000
  const maxTokens = Number(opts?.visionMaxTokens) > 0 ? Number(opts.visionMaxTokens) : 1024
  return {
    enabled: apiKey !== '' && baseUrl !== '' && model !== '',
    apiKey,
    baseUrl,
    model,
    lang,
    timeoutMs,
    maxTokens,
  }
}

/** 从 chat/completions 响应里取正文（兼容字符串与分块数组两种形态）。 */
function extractText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : '')))
      .join('\n')
      .trim()
  }
  if (typeof payload?.choices?.[0]?.text === 'string') return payload.choices[0].text.trim()
  return ''
}

/**
 * 描述一张图。
 *
 * @param {{attachmentId:string, mediaType:string, width:number, height:number, name?:string}} ref 归一化附件引用
 * @param {{config:object, readImage:(ref:object)=>Promise<{data:Uint8Array, mediaType:string}|undefined>, signal?:AbortSignal}} deps
 * @returns {Promise<{ok:true, text:string}|{ok:false, reason:string}>}
 */
export async function describeImage(ref, deps) {
  const config = deps?.config
  if (!config?.enabled) return { ok: false, reason: 'vision-not-configured' }
  if (typeof deps?.readImage !== 'function') return { ok: false, reason: 'image-bytes-unavailable' }
  let stored
  try {
    stored = await deps.readImage(ref)
  } catch (error) {
    return { ok: false, reason: `image-read-failed: ${error?.message || error}` }
  }
  if (!stored?.data || stored.data.length === 0) return { ok: false, reason: 'image-bytes-unavailable' }
  const mediaType = String(stored.mediaType || ref.mediaType || 'image/png')
  const base64 = Buffer.from(stored.data).toString('base64')
  const body = {
    model: config.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPTS[config.lang] || PROMPTS.zh },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        ],
      },
    ],
    max_tokens: config.maxTokens,
    stream: false,
  }
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const signal = deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout
  let response
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    return { ok: false, reason: `vision-request-failed: ${error?.message || error}` }
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { ok: false, reason: `vision-http-${response.status}: ${String(detail).slice(0, 200)}` }
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    return { ok: false, reason: `vision-bad-json: ${error?.message || error}` }
  }
  const text = extractText(payload)
  if (text === '') return { ok: false, reason: 'vision-empty-text' }
  return { ok: true, text }
}

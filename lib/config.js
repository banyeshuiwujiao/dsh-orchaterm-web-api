/**
 * 插件的可配置默认值与「哪些变更需要重启后端」的判定。
 *
 * 拆成独立模块的原因：适配器与安装自检（test/config_check.mjs）都要读同一份默认值，
 * 放在 provider.js 里会让自检被迫加载整个流式实现。
 *
 * @module lib/config.js
 */

/** provider 路由 id（模型选择器里的分组名）。 */
export const PROVIDER_ID = 'orcaterm-web-api'
export const PROVIDER_LABEL = 'OrcaTerm（反代）'

/** 反代默认监听端口：本机 8787(deepseek)/4555(minimax)/8791 已被占，故取 8793。 */
export const DEFAULT_PORT = 8793

/**
 * 静态模型目录（精简为用户选定的 5 个核心模型）：
 * - DeepSeek-V4.1-Flash: 开关 + Max/High/Low, 图片识别, 1M 长上下文, 思考模式
 * - Hy4-preview: 开关 + High, 1M 长上下文, 思考模式
 * - Hy3: 开关 + High/Low, 128K, 思考模式
 * - Kimi-K3: 无开关 + Max/High/Low, 图片识别, 1M 长上下文, 思考模式
 * - GLM-5.3-Flash: 无开关 + Max/High/Low, 图片识别, 申报 300K（非实测上限）, 思考模式
 *
 * `thinkingOff` 对应 OrcaTerm 客户端模型设置里的「思考模式」开关：有开关的模型可以整体
 * 关闭思考，选择器里多一个 Off 档（线上发 reasoning_effort:"none"）；没有开关的模型
 * 只能选档位（Kimi-K3 与 GLM-5.3-Flash 实测无开关）。
 */
export const KNOWN_MODELS = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash',
    thinking: true,
    thinkingOff: true,
    thinkingLevels: ['max', 'high', 'low'],
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    description: 'OrcaTerm 默认推荐（思考档位 Off/Max/High/Low，图片识别，1M 长上下文）',
  },
  {
    id: 'hy4-preview',
    name: 'Hy4-preview',
    thinking: true,
    thinkingOff: true,
    thinkingLevels: ['high'],
    inputModalities: ['text'],
    contextWindow: 1048576,
    description: '腾讯混元新一代预览（思考档位 Off/High，1M 长上下文）',
  },
  {
    id: 'hy3',
    name: 'Hy3',
    thinking: true,
    thinkingOff: true,
    thinkingLevels: ['high', 'low'],
    inputModalities: ['text'],
    contextWindow: 128000,
    description: '腾讯混元 3 主力模型（思考档位 Off/High/Low，128K）',
  },
  {
    id: 'kimi-k3',
    name: 'Kimi-K3',
    thinking: true,
    thinkingOff: false,
    thinkingLevels: ['max', 'high', 'low'],
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    description: '月之暗面 K3（思考档位 Max/High/Low，无关闭开关，图片识别，1M 长上下文）',
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    thinking: true,
    thinkingOff: false,
    thinkingLevels: ['max', 'high', 'low'],
    inputModalities: ['text', 'image'],
    contextWindow: 300000,
    description: '智谱 GLM 5.3 Flash（思考档位 Max/High/Low，无关闭开关，图片识别，300K 长上下文）',
  },
]

export const DEFAULTS = {
  baseUrl: `http://127.0.0.1:${DEFAULT_PORT}`,
  // 反代入口默认在本插件 backend/ 下；只有指向别处时才写 backendDir。
  backendDir: '',
  nodePath: '',
  // 上游两条通道；留空 = 沿用后端默认（桌面端口径 api.orcaterm.cloud.tencent.com
  // 与 lightai.cloud.tencent.com/assistant，见 backend/server.js 的 buildConfig）。
  cgiBase: '',
  assistantBase: '',
  // 以哪个客户端身份访问上游：'desktop'（默认，origin/referer = http://tauri.localhost，
  // 即桌面端 webview 的真实页面）或 'web'（https://orcaterm.com，v0.3.1 及之前的口径）。
  // 实测两个通道都不校验 origin/referer/UA，所以这是身份对齐而不是修故障。
  clientIdentity: 'desktop',
  assistant: 'orcaterm',
  mode: 0,
  // 凭据：默认由后端现读 OrcaTerm 桌面端的明文登录态，只有需要覆盖时才填。
  credentialsFile: '',
  cookies: '',
  assistantCookies: '',
  uin: '',
  skey: '',
  // AccessToken 自续期（v0.6.0）。官方动作 `OAuthRefreshToken`，只需曾经登录过一次。
  //   'auto'（默认）：临期自动续 + 后台巡检；'off'：退回 v0.5.x「只重读桌面端登录态」。
  tokenRefresh: 'auto',
  // 续期结果缓存：默认 ~/.dsh/orca-token-cache.json（含一枚 bearer token，0600 落盘）。
  // 反代进程重启后靠它接着用，不必再依赖桌面端是否写过新值。
  tokenCache: '',
  // 距过期不足这么久就提前续期（默认 10 分钟；官方是 110 分钟续 + 5 分钟巡检）。
  tokenRefreshLeadMs: 600000,
  // 后台巡检间隔（默认 5 分钟，对齐桌面端 TokenManager 的 periodic check）。
  tokenRefreshCheckMs: 300000,
  autoStart: true,
  startTimeoutMs: 20000,
  probeTimeoutMs: 3000,
  // 上游没公布上下文上限；申报保守值，内核的压缩线才不会过于乐观。
  maxContextWindow: 128000,
  defaultMaxTokens: 8192,
  toolDescriptionMaxChars: 0,
  healthTtlMs: 30000,
  // 助手网关首 token 可能很慢（Agent 先跑命令再回话），给到 180s。
  streamIdleTimeoutMs: 180000,
  // 把 DSH 的 sessionId 映射成 conversationId，让上游自己保住多轮上下文。
  reuseConversation: true,
  // 上游同一会话最多连续多少轮，超过就换新会话并补发 DSH 的历史。
  // 作用有二：借 DSH 的压缩结果给上游上下文瘦身；避免上游上下文无限增长。
  // 0 = 不限制（只靠压缩/重写/重试触发换会话）。
  conversationMaxRounds: 40,
  // 是否把 DSH 的多轮历史发给上游（input.historyMessages）。
  // 默认 false：上游会把历史逐条回灌成 ai 帧污染正文（详见 backend/upstream.js），
  // 而它凭 conversationId 自己就能保住上下文，历史既多余又有害。打开只用于对比排障。
  // 注意：provider 的上下文对账判定「需要换新会话」时会逐轮覆盖这一项。
  sendHistoryMessages: false,
  // 工具结果的回传信封形态（两种都是逆向出来的官方形态，都经真实流量验证能被消费）：
  //   'review'（默认）= {type:'review',reviewAction:'reportToolResult',toolResult,tool}
  //                    桌面端**唯一在用的**回传路径（子 Agent 循环，orcaterm_start/app.js）；
  //   'ask'           = {type:'ask',input:'{TOOL_RESULT}(<tool.name>): <result>'}
  //                    主循环模块 2481 导出的 reportToolResult（`st`）+ 常量 68280。
  // 默认取 'review'：与 clientIdentity='desktop' 一致 —— 桌面 bundle 里只有它在消费这一形态。
  // 逐轮可用请求体 `orca_result_envelope` 覆盖（对比排障用，不必重启后端）。
  resultEnvelope: 'review',
  // 回传工具结果时「上游是否受理」的阶段上限（官方 bundle 里是 15e3，模块 32804 `SE`）。
  // ⚠️ 它只覆盖到**拿到响应头**，不约束随后的流式答案 —— 官方那个 withTimeout 只是
  //    「停止等待」并重试，并不 abort 请求；把它做成 AbortSignal 挂在整个请求上，
  //    会在模型正常作答中途掐断连接（v0.5.5 修的实报缺陷）。0 = 不设这一阶段上限。
  reportRetryTimeoutMs: 15000,
  logFile: '~/.dsh/logs/orchaterm-web-api.log',
  detach: false,
  killTreeOnDispose: true,
  passEnvKeys: [],
  env: {},
  strictBackend: true,
  requiredCapabilities: [],
  minBackendVersion: '',
}

/** 影响后端进程与探活的项：只有这些变了才重建 manager（重建 = 杀掉旧子进程）。 */
export const MANAGER_KEYS = [
  'baseUrl', 'backendDir', 'nodePath', 'cgiBase', 'assistantBase', 'assistant', 'mode',
  'credentialsFile', 'cookies', 'assistantCookies', 'uin', 'skey', 'autoStart', 'startTimeoutMs',
  'probeTimeoutMs', 'healthTtlMs', 'logFile', 'detach', 'killTreeOnDispose', 'passEnvKeys', 'env',
  'strictBackend', 'requiredCapabilities', 'minBackendVersion', 'sendHistoryMessages',
  'clientIdentity', 'resultEnvelope', 'reportRetryTimeoutMs',
  'tokenRefresh', 'tokenCache', 'tokenRefreshLeadMs', 'tokenRefreshCheckMs',
]

/** 配置指纹：用于判定「与后端进程相关的项是否变了」。 */
export function managerKeyOf(opts) {
  return JSON.stringify(MANAGER_KEYS.map((key) => [key, opts[key] ?? '']))
}
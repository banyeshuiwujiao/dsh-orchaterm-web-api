All notable changes to the `dsh-orchaterm-web-api` plugin will be documented in this file.

## [0.6.1] - 2026-10-29

思考档位接入 DSH 模型选择器。

### Symptom
模型选择器里只能选模型，看不到 OrcaTerm 客户端那套思考强度（Low/High/Max），
也无法像客户端「思考模式」开关那样整体关闭思考；实际请求一直按
`enableThinking:true` + `thinkingLevel:'high'` 发上游。

### Root cause
DSH 的档位只来自适配器 `resolveModel()` 返回的 `reasoning.efforts`
（`dsh-api-session-controller` 的模型目录会逐个模型调用 `resolveModelInfo` 取 reasoning），
本插件从未申报该字段；`stream()` 也没有把宿主传入的 `options.reasoningEffort`
写进请求体。反代本身早已支持 `reasoning_effort`（`backend/server.js` 映射
`none`→关闭、`low`/`max`→对应档、其它→`high`），缺的只是适配器这一层。

### Fix
- `lib/config.js`：`KNOWN_MODELS` 增加 `thinkingOff`，对应客户端「思考模式」开关。
- `lib/provider.js`：`resolveModel()` 按模型申报 `reasoning.efforts`（Off/Low/High/Max，
  默认 High，目录外模型不申报）；`stream()` 透传 `reasoning_effort`，`Off` → `none`。
- 档位依据 OrcaTerm 1.6.6 模型设置实测：`DeepSeek-V4.1-Flash` / `Hy4-preview` / `Hy3`
  有「思考模式」开关；`Kimi-K3` / `GLM-5.3-Flash` 只有档位、没有开关。
- 测试：`test/smoke.mjs` 新增 5c（各模型档位申报）与 5d（`max`/`low` 透传、`Off`→`none`、默认不带字段）。

### Validation
`npm test` 7 条链全绿；对本地反代实测 `reasoning_effort:none` 无 reasoning 帧、
`low` 有 reasoning 帧，`resolveModel` 返回的档位与客户端设置一致。

## [0.6.0] - 2026-10-27

AccessToken 自己续期（`OAuthRefreshToken`）—— 不再需要把 OrcaTerm 客户端开着。

### Symptom
`本轮运行失败 orchaterm-web-api 错误: Invalid or expired AccessToken`；必须先手动打开
OrcaTerm、聚焦 AI Session 触发一次 token 刷新，反代才恢复。每 ~2 小时复发一次。

### Root cause
v0.5.x 的 `ensureFreshCredential` 只会**重读**桌面端 `data.bin` / `.cookies` 里的登录态。
谁来产生新 token？只有 OrcaTerm 桌面端的 `TokenManager`（110 分钟续一次 + 5 分钟巡检），
而它只在客户端运行时工作。客户端没开（或窗口长期失焦）时，落盘的 token 过了 2 小时就没人管，
反代便一直拿着过期快照去请求。

### Reverse engineering
取自 OrcaTerm 1.6.6 前端 bundle（`orcaterm_app.zh.*.js` 模块 24530）与 Rust 日志，双向印证：

| CGI action | 入参 | 说明 |
| --- | --- | --- |
| `OAuthExchangeToken` | `{sessionId}` | 首次登录换取（`orcaterm://oauth_callback?session_id=…`） |
| `OAuthRefreshToken` | `{accessToken}` | 续期；**入参就是当前 AccessToken** |

响应 `{Code:0, Message, AccessToken, ExpiresIn:7200}`，响应头 `X-OT-Token-Refreshed`
里另有同一枚 JWT（官方 `AuthStore.onServerTokenRefreshed` 消费它）。

本机实测（2026-10-27）：
- token **过期 30 小时后**调用 `OAuthRefreshToken` 仍返回 `Code:0` 和新 token；
- 续期前后 JWT 的 `jti` / `providerCredentialKey` 一致，只有 `iat`/`exp` 变（无 refresh token 轮换）；
- 链式续期成立；旧 token 在新 token 签发后仍可用（不会把桌面端踢下线）；
- 常规 CGI 头即可，`Authorization` / `Cookie` / `uin` 查询串都不是硬要求。

### Fix
- 新增 `backend/token-refresh.js`：单飞刷新 + 失败冷却 + 只落更晚 exp + `X-OT-Token-Refreshed` 吸收。
- `backend/credentials.js`：新增续期缓存 `~/.dsh/orca-token-cache.json`（0600、原子写），
  解析时在「缓存 / 桌面端 store / jar」之间按 exp 取最晚；`applyAccessToken` 同步
  `token`、`assistantBearer` 与 `ot_session`。
- `backend/server.js`：`ensureFreshCredential` 改为异步，先本地重读、仍临期则网络续期；
  启动即查一次 + 每 5 分钟巡检；认证失败强制续期后重试一次（流内失败则只续期，供下一轮）；
  `/health` 新增 `tokenRefresh` 自述（只报时间/状态码）。
- `backend/upstream.js`：`cgiCall` 支持注入 `fetchImpl`，并回传/吸收 `X-OT-Token-Refreshed`。
- 契约：能力清单新增 `token-self-refresh`（并列入必需项，旧构建会被拒绝复用）。
- 新配置：`tokenRefresh` / `tokenCache` / `tokenRefreshLeadMs` / `tokenRefreshCheckMs`
  （CLI/env 同名口径见 README）。
- `install.ps1`：自检增加 `token_refresh` 单测、续期缓存状态与 `/health.tokenRefresh` 展示。

### Verification
- `test/token_refresh.mjs` 12 组离线回归（健康零请求 / 临期续期 / force / 上游拒绝 /
  传输失败 / 并发单飞 / header 只吸收更晚 / ot_session 同步 / 缓存合并优先级 /
  buildConfig 接线 / header 先吸收不误判 `NO_PROGRESS` / 本地重读不得把新 token 换回旧值）。
  **第 11 组对应实报缺陷**：`cgiCall` 会先把响应头吸收进 credential，若在请求之后才取
  `previousExp`，就会误判成「没有更晚的过期时间」并拒绝落盘（首跑现场复现过）；
  第 12 组锁住并发续期 + 缓存写失败时「本地重读只看到桌面端旧值」的回退路径。
- 活体（OrcaTerm 客户端全程未启动）：从一枚**已过期 30 小时**的桌面端 token 强制续期成功，
  缓存落盘，随后 `/v1/models`、`/orca/cgi GetUserInfo`、`/v1/chat/completions` 全部 200
  且正常出字。
- 另：一次真实重启验证中，残留的过期 token 经新后端续期后写进缓存，**下一个进程启动直接
  从缓存接着用**（`/health.credential.sources = ['tokenCache']`），证明「重启不丢」成立。

### Boundaries
- 仍需**一次**初始登录（`data.bin` / `.cookies` / `credentialsFile` 里要有一枚 token）；
  从未登录过时报 `NO_TOKEN`，提示登录一次。
- 缓存文件是一枚 bearer token，已按 0600 落盘；不要提交或共享。
- 续期依赖服务端 `providerCredentialKey` 仍有效；账号被登出/吊销时续期会回 `Error`，
  需重新登录一次。
- 不写回桌面端 `data.bin`（避免与 Tauri Store 的写入时机打架），两套凭据按 exp 取最晚共存。

## [0.5.8] - 2026-10-27

修「映射会话被上游卡死后永久零输出」——DSH 侧表现为 `EMPTY_RESPONSE`
（「orchaterm-web-api 这一轮没有产出任何内容（检查 OrcaTerm 是否仍登录、账号额度是否用尽）」）
重试 2 次后整轮失败，点「继续」也无济于事。

### Root cause
实报 session-628db98d（2026-10-27 会话日志逐帧核对）：上游对同一 `conversationId` 的
会话上下文涨到 ~32k 后开始 **200 + 零输出**（provider 侧 `inputTokens≈32500` 计入、
`outputTokens` 恒 0，且失败得很快——不是超时），此后该 cid 的每一轮、**换模型**
（glm-5.3-flash → hy3）都零输出。同时间窗实测对照：

| 请求形态 | 结果 |
| --- | --- |
| 卡死 cid 上的任意轮（含换模型后） | 200 + 零输出，秒回 |
| 最小请求（新会话，几 KB） | 正常 |
| 新会话 + 127KB 大输入 | 正常，19s |

→ **卡死的是上游按 cid 保存的会话状态**，不是账号（登录态/额度正常）、不是模型、
不是后端进程（一直存活）。

宿主每轮都带同一个 cid（provider 的会话映射 `payload.user`），反代按 cid 去重只发
增量（`DELIVERED.textsFor`）——旧 cid 一旦被上游卡死就永远救不回来，桌面端那个会话
没有任何自愈路径。流式侧已有的「断流续传」（`/stream/resume`）只覆盖「单条流没走完」，
覆盖不了「上游对整个会话持续零输出」。

### Fix
- `backend/server.js`（serveChat 零输出救援）：流结束**零正文、零推理、零工具调用**
  且上游正常收尾（`[DONE]` 或无终止符）时——判定与 provider 的 `EMPTY_RESPONSE` 同
  口径——若本轮 cid 是宿主映射来的：abort 掉旧 cid 可能残留的僵尸流，**换全新会话 +
  补发全量历史**（与压缩摘要轮同款模式）重入一次。工具结果信封（review/ask/feedback）
  引用旧会话的调用 id，新会话认不得，降级为普通 `start`，工具结果文本并入 `input`；
  换新会话后上游不再按 cid 保留首轮上下文，系统提示以 `[系统要求]` 前缀随本轮补上
  （对齐首轮形态，已在 content 里就不重复）。救援后新会话也零输出则维持原样交 DSH
  （`EMPTY_RESPONSE` 兜底仍在，不无限重试）。
- `backend/server.js`（handleChat）：记住「旧 cid → 救援会话」映射（内存 LRU 64 条，
  进程重启丢失后由零输出检测重新发现），后续轮次直接用救援会话——不再先撞一次注定
  零输出的旧 cid，也不重复补发历史。
- 救援留痕到后端 stderr（`会话 <cid> 本轮零输出…已换新会话 <cid2> 补发历史重试`），
  排障时「这一轮为什么多了两次上游调用」有处可查。

### Verification
- 新增 `test/empty_response_rescue.mjs`（离线，假上游，**先证明测试抓得住 bug**：
  修复前第一组即红 `救援后应有正文，实际 ""`）。三组：带 `[DONE]` 的零输出、不带
  `[DONE]`（先走断流续传检查再救援）、救援后下一轮 remap；断言救援轮「换新会话 +
  补发历史（含系统要求）+ 降级 start + abort 僵尸流」。修复后三组全绿。
  （测试隔离注意：`RESCUED_CID`/`DELIVERED` 是模块级记忆，每组要用独立的卡死 cid。）
- 既有离线回归全绿：smoke（27 组）、compaction_summary（5 组）、malformed_envelope、
  report_timeout、config_check、direct-fetch；新测试已加入 `npm test` 链。
- 真栈回归 `test/live_regression.mjs`（8793，真桌面端 + 有效登录态）：**17/17 通过**。
- 部署：后端由 `lib/server.js` 的 supervisor 托管，进程退出即清空 health 缓存，
  下一次插件请求自动用新代码重启（无空窗）。

## [0.5.7] - 2026-10-27

修「压缩摘要与对话无关」——模型切换时的上下文压缩因此失败（`MODEL_SWITCH_COMPACTION_FAILED`）。

### Root cause
宿主的压缩摘要是**辅助 LLM 调用**（`purpose: 'compaction'`），消息体是
「待压缩的那段对话 + 一条压缩指令」。但反代默认**不补发历史**
（`sendHistoryMessages` 默认 false），上游于是**只收到最后那条压缩指令** ——
它根本没见过要压缩的对话，产出的摘要与对话无关：

| 上游实际收到的 | 摘要实测 |
| --- | --- |
| 只有压缩指令 | 161~191 字元话（「已按您指定的 Markdown 结构完成对话压缩检查点输出」），零事实 |
| 压缩指令 + 对话历史 | 999~1140 字，逐字复述对话里的事实（SHM 锁 / 8793 端口 / SQLite WAL） |

宿主随后拿摘要与被压缩内容比大小：无关的元话不比内容短 → 报
`summary is not smaller than the shadowed content`；摘要为空 → 报
`summarization produced no text summary content`。两者都让模型切换以
`MODEL_SWITCH_COMPACTION_FAILED` 收尾。

两个叠加原因：

1. **对账判 `fresh` → 不补发历史**。压缩请求走独立的 `aux:compaction:<sessionId>` 会话键，
   第一次必然判 `fresh`，而 `fresh` 不补发历史（`lib/context.js` 的语义：历史会被上游
   回灌成 `ai` 帧污染正文）。于是**第一次压缩必然拿到无内容的摘要**；宿主重试时判定变成
   `resync` 才补发历史 —— 修复前要靠「失败→重试」才成功（两次上游调用）。
2. **压缩轮可能被误判成「对未决工具调用的反馈」**。区域末尾那条 assistant 带 `tool_calls`
   时，后端会走 `feedback` 形态；而 `assistantBody` 的 review 分支**根本不带
   `historyMessages`** → 历史第二次丢失。

### Fix
- `lib/provider.js`：压缩轮（`purpose === 'compaction'`）**每次新会话 + 补发历史**，
  并绕开上下文对账（对账的 `fresh/resync` 语义在这里没有意义）。会话 id 用真随机的一段
  （官方形态 `cid-{uuid}-{assistant}`）—— 常规会话那套「会话键的稳定哈希」不够：
  上游服务端会留着旧会话，摘要里会掺进上一次压缩的旧内容（实测摘要出现过
  「最近标记为 user 3」这种上一轮的痕迹）。
- `lib/provider.js`：请求体带上 `orca_purpose`，把「本轮用途」告诉后端。
- `backend/server.js`：`orca_purpose === 'compaction'` 时走**普通 `start` 路径**，
  避开 review / feedback 两个不带 `historyMessages` 的分支。
- 普通轮的行为**完全不变**：不发 `orca_purpose`、不补发历史、对账逻辑照旧。

### Added
- `test/compaction_summary.mjs`：假上游断言「上游到底收到了什么」。
  ① 压缩轮必须带 `historyMessages` 且含待压缩对话的具体内容；
  ② 区域末尾 assistant 带 `tool_calls` 时也不得走 feedback 形态；
  ③ 非压缩轮行为不变；④ provider 侧压缩轮必须「新会话 + 补发历史」；
  ⑤ provider 发出的请求体必须带 `orca_send_history` 与 `orca_purpose`。
- `test/host_live_switch.spec.ts`：真实上游的模型切换压缩（宿主完整栈）。

### Verified
- **先证明测试抓得住 bug**：在真实宿主上把 provider 的压缩分支还原，
  同一份测试立刻失败，摘要正文变成
  「当前会话无实际运维任务需要处理。上下文仅包含：1）将对话压缩为结构化检查点的系统指令；
  2）执行环境说明……」—— 与对话完全无关。
- 修复后同一测试：模型切换放行、压缩检查点写入、摘要正文正确描述对话内容、
  **上游调用次数 = 1**（修复前需 2 次）。
- **one-shot CLI 走完整宿主栈（llm runtime + token-meter + compaction）真实验证**：
  用 `dsh --profile <one-shot profile> "<任务>"`（headless profile + orcaterm 插件）跑三轮：
  ① 两轮 hy4-preview 把历史堆到阈值以上；② `--patch` 切到 hy3 → 触发「模型切换 → 压缩」。
  会话日志证实：**恰好 1 次压缩**（`compaction/start` / `summary` / `end` 各一，无重试无报错，
  `llmStreamCall: true`），遮蔽 32820 tokens，摘要是宿主的 7 段结构化检查点且**逐字引用了
  对话**（「用户的原始问题（逐字）：『MARKER-ORCA-COMPACTION-7731 是什么？…』」），
  第三个请求头是 hy3 → 模型切换放行，最终从检查点正确恢复了答案。
- `npm test` 全绿（config_check + smoke 28 组 + malformed 3 组 + report_timeout 2 组 +
  compaction_summary 5 组）。
- 活体回归 **17/17**（真实 OrcaTerm 会话：思维链、工具调用、工具结果回传、上下文对账）。

### 边界（如实入册）
- 上游 token 的 TTL 约 **2 小时**，来自 OrcaTerm 桌面端登录态。插件的
  `ensureFreshCredential` 只能**重读桌面端 store**，不能自己续期 —— 过期后需要
  重启 OrcaTerm 桌面端（2026-10-27 12:56 那次就是这样恢复的）。
- 压缩摘要的**长度**仍由上游模型决定。宿主的护栏要求摘要严格短于被压缩内容；
  区域极小（例如被保留的尾巴本身就超过阈值）时，任何符合宿主 7 段结构的摘要都不可能
  更短 —— 那是宿主的内容护栏与「保留尾巴/阈值」的组合，不是本插件的缺陷。
  **宿主自带路由同样如此**（它的脚本化摘要也有 400 tokens 量级）。
- 宿主还有两条**与本插件无关**的边界，一并入册（实测撞到过，别误判成插件缺陷）：
  - `no safe compaction range can reduce context below threshold`：宿主按
    「保留尾巴预算 = 窗口 × retainRatio(默认 0.16)」保留最近内容；**若最近内容的
    token 数超过该预算**，就没有可压缩区间（切到小窗模型 + 大尾巴时尤其明显）。
  - `summary is not smaller than the shadowed content`：压缩成功但**降不到阈值以下**时，
    宿主会重试；重试会去压缩「刚写下的检查点」（通常一百多 token），而新的 7 段摘要
    有几百 token → 比不过 → 报这个错。宿主自带路由同样会这样。
- 本轮仍只修「上游看到什么」。压缩**区域如何选**、**阈值怎么算**属宿主策略，未改。

## [0.5.6] - 2026-10-27

修一个**宿主适配器契约面缺失**的实报缺陷（用户粘贴）：
`Cannot switch to orcaterm-web-api/hy4-preview: context compaction failed:
this.adapters.get(...)?.adapter.imageRequestPricing is not a function.`
（`orcaterm-web-api/glm-5.3-flash` 同样报；错误码 `MODEL_SWITCH_COMPACTION_FAILED`，
伴随重复的「处理失败」与 `compact`）

### Root cause
本插件的适配器是**普通 JS 类** —— 插件按约定只在 `lib/kernel.js` 里惰性 import
`@deepseek-ai/dsh-llm`（取归因头），拿不到 `LlmAdapter` **基类**，于是基类上的
**默认实现全部缺失**。而宿主 `LlmRuntime` 是**直接调用注册对象上的方法**的：

```ts
// packages/llm/llm/src/index.ts
imageRequestPricing(provider, model) {
  return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)  // ← 682 行
}
imageRequestTarget(provider, model, image) {
  return this.registration(provider).adapter.imageRequestTarget(provider, model, image)  // ← 693 行
}
```

缺方法不是「降级为 undefined」，而是 **TypeError**。宿主链路：

```
agent/request（模型切换，prepend）
  → compactPressure(agent, header)
    → token-meter measure(session, header)
      → _routeImagePricing(header)                       // token-meter/src/index.ts:202
        → ctx.llm.imageRequestPricing(provider, model)
          → adapter.imageRequestPricing(...)             // ← 适配器没这个方法 → TypeError
  → 包装成 LlmError('MODEL_SWITCH_COMPACTION_FAILED')
```

`registerAdapter()` 只做鸭子类型校验（`providerInfo` / `providerRetryPolicy`），
**不检查其余方法**，所以缺方法能一路溜到运行时才炸。

### Fixed
- **补齐宿主契约面**（等价移植基类默认实现，见 `lib/provider.js`）：
  - `imageRequestPricing(_provider, _model)` → `undefined`。本路由不按视觉 token 收费
    （上游是腾讯侧计费的助手网关，客户端拿不到每模型视觉单价），「声明无计价器」正是
    基类默认语义：token-meter 退回中性估算，spill-policy 遇图片时抛错并保持内联内容。
  - `imageRequestTarget(_provider, _model, image)` → `{width, height, maxBytes: image.bytes}`。
    本路由不缩放图片，保留归一化后的原图。
- **顺带修 `resolveModel` 的签名错配**：宿主契约是 `resolveModel(provider, model, signal)`，
  第三参是 **AbortSignal**；原先把它当**配置对象**用（`opts.maxContextWindow` /
  `opts.defaultMaxTokens`）。宿主直接调用时拿到的是 signal，这两个值全是 `undefined`
  → 上下文窗口退到 128000 兜底值（而不是目录里申报的 1M），压缩线随之失准。
  现在配置一律从 `this.current()` 取，signal 只用于提前放弃。

### Added
- `test/smoke.mjs` 第 5b 组「宿主适配器契约面完整」：逐个断言宿主会直接调用的方法存在，
  并断言 `imageRequestPricing` 返回 `undefined`、`imageRequestTarget` 保留原图尺寸、
  `resolveModel` 在**传 signal** 时仍申报目录里的上下文窗口（1M / 300K / 128K）。
- `test/host_contract.spec.ts`：宿主侧契约回归（真实 `LlmRuntime` + `TokenMeter` +
  `BasicCompactionEngine` + 插件真实适配器），复刻实报的模型切换压缩失败。
- `test/host_live_switch.spec.ts` + `test/direct-fetch.mjs`：**真实上游**的模型切换压缩。
  宿主的摘要用「上一个模型」做（compaction-basic/src/summarizer.ts:127），所以上个模型是
  orcaterm 路由时，摘要请求会原样经过插件适配器打到真实 OrcaTerm 上游。
  `direct-fetch.mjs` 绕开本机的 `NODE_USE_ENV_PROXY`（宿主的 vitest setup 会删掉 `NO_PROXY`，
  而 Node 的 fetch 在进程启动时已绑死代理 → 本地 8793 的请求被送进代理 → `fetch failed`）。

### Verified
- **先证明测试抓得住 bug**：在**真实宿主**上删掉 `imageRequestPricing`，
  同一测试立刻逐字复现用户报错：
  ```
  Cannot switch to orcaterm-web-api/hy4-preview: context compaction failed:
  this.adapters.get(...)?.adapter.imageRequestPricing is not a function.
  The previous request model is preserved; retry or select a model with a larger context window.
  ```
  修复后该路径**完全无错**（模型切换成功，压缩照常完成）。
- **真实上游活体验证通过**：摘要请求经插件适配器打到真实 OrcaTerm 上游并拿回摘要
  （真实往返 8~23 秒），全程无契约类错误。
- `npm test` 全绿（config_check + smoke 28 组 + malformed 3 组 + report_timeout 2 组）。
- 活体回归 **17/17**（真实 OrcaTerm 会话：思维链、工具调用、工具结果回传、上下文对账）。
- 其余 9 个插件均不注册 adapter（`grep registerAdapter` 仅本插件一处），无同类隐患。

### 边界
- 本路由的 `inputModalities` 仍申报 `image`（目录如此），但反代的 OpenAI 消息格式化
  （`lib/openai.js` 的 `flattenContent`）**丢弃非文本 block** —— 图片在到达上游前就被丢掉。
  这是既有的能力申报与实际能力之间的落差，不在本轮修复范围内；如需如实申报，
  下一步应把 `image` 从各模型的 `inputModalities` 里去掉，或补上图片透传。
- **新发现（未修）**：OrcaTerm 上游在「压缩摘要」这个用途上不稳定 —— 实测同一场景下
  出现过两种结局：`summary is not smaller than the shadowed content`（摘要比被压缩内容还长）
  与 `summarization produced no text summary content`（摘要为空）。两者都是**上游模型的
  内容表现**与宿主内容护栏的组合，不是契约缺陷（契约缺陷已修，且这两条文案证明请求确实
  到了上游）。但它们会让「模型切换 + 长历史」的压缩轮以 `MODEL_SWITCH_COMPACTION_FAILED`
  收尾。宿主自带路由（`llm-deepseek`）不受影响，因为它用的是确定性的脚本化摘要。
  本轮如实入册，未扩大范围。

## [0.5.5] - 2026-10-27

修一个**把官方的「停止等待」误移植成「掐断连接」**的缺陷（用户实报：
`session-21bd31eb`、`session-8b10359d` 频繁出现
`本轮运行失败 orchaterm-web-api 错误: The operation was aborted due to timeout`）。

### 故障现场（会话日志逐事件核对）
`session-21bd31eb` turn 1 step 2：pwsh 工具结果已成功回传（`isError=false`），接着模型开始正常作答，
`assistant/attempt` 的 reasoning 正在流（`诊断结果已出，核心问题非常明确：Windows 时间服务 (W32Time)…`），
**第 15 秒连接被掐断**：
```
usage {inputTokens:13231, outputTokens:0}
finish  {kind:'error', failure:{message:'orchaterm-web-api 错误: The operation was aborted due to timeout', code:'SERVER', status:500}}
```
随后 `llm/retry` 重试 2 次（延迟 1461ms、3373ms），**每次都在同样的位置被掐断**，turn 以 error 结束。
`session-8b10359d` 两轮 turn（1 与 2）都是同一形态，且都发生在**有 tool/result 的步骤**上。

### Root cause
官方回传工具结果：`SE(() => 回传(), {attempts:3, timeoutMs:15e3, baseDelayMs:300, maxDelayMs:1500})`。
`SE`（模块 32804）的实现是 `setTimeout` + `reject` 的 **promise 竞速** —— 语义是「**停止等待**并重试」，
**全程没有任何 AbortSignal**（错误文案亦为「回传工具结果 在 15000ms 内没有返回。」「…超时，已停止自动等待。」）。

v0.5.4 及之前把它实现成 `AbortSignal.timeout(REPORT_RETRY_TIMEOUT_MS)` 挂在 `fetch` 上，
于是 15 秒从「受理上限」变成了**整个 SSE body 的硬墙**：只要工具结果轮的答案吐超过 15 秒，
连接就必然被掐，内核重试也必然在同样位置再被掐 —— 结构性地整轮报废。

### Fixed
- **受理超时与流超时拆开**：`reportRetryTimeoutMs`（默认 15000）只覆盖「等响应头」这一段，
  拿到响应头立即撤销计时器；正文是否卡住交给 `streamIdleTimeoutMs`（默认 180000）的空闲判定。
  新增可配项，`0` = 不设该阶段上限。
- **两个 signal 合并而非覆盖**：原先同一对象里写了两个 `signal:` 键，后者静默吃掉前者
  （`payload._signal` 覆盖了受理计时器，或反之）—— 现在用 `AbortSignal.any()` 合并，
  DSH「点停止」与受理计时器都始终生效。
- **5xx 也走官方退避**：原实现里 `upstream.ok || status < 500` 为假时直接落到下一轮，
  跳过了 `reportRetryBackoffMs` 退避（与官方 300→600→1200ms 不符）。
- **续流不再有 60s 墙钟上限**：`/stream/resume` 原先是 `AbortSignal.timeout(60000)` 挂在整个
  fetch 上再 `pumpStream` —— 同一个误移植模式（续流本就是为长跑的 Agent 流准备的）。
  改为 `pumpStream(reader, {idle:true})` 的空闲判定。

### Added
- `pumpStream(reader, {idle})`：可选空闲上限，主流与续流共用同一判据。
- 配置项 `reportRetryTimeoutMs`（贯通 `DEFAULTS`/`MANAGER_KEYS`/`cordis.patch.yml`/provider env）。

### Verified
- **新增 `test/report_timeout.mjs`（已接入 `npm test`）**，假上游驱动、不需要登录态：
  1. 假上游立刻回头、正文慢吐（2600ms，远超受理上限 800ms）→ 断言正文**完整送达**、
     无错误帧、`finish=stop`、假上游未看到提前断开；
  2. 假上游只收不答 → 断言受理超时**仍然生效**（502 + 「在 300ms 内没有返回。」+ 恰好重试 3 次 +
     总耗时约 1.9s，与官方 300ms×3 + 退避 300/600 吻合）。
- **先证明测试抓得住 bug**：把 `signals` 临时换回修复前的 `AbortSignal.timeout(reportTimeoutMs)`，
  同一测试立刻报 `正文="" errors=["The operation was aborted due to timeout"]` ——
  与用户看到的报错文案逐字一致；换回修复后转绿。
- `npm test` 全绿（config_check + smoke 27 组 + malformed 3 组 + report_timeout 2 组）；
  活体回归 **17/17**（含工具结果轮 C2）；`/health` v0.5.5；正常回合 stderr 空。

### 边界
- 受理超时**不**限制整轮总时长：若上游受理了却又长时间不吐字，由 `streamIdleTimeoutMs`
  （180s 空闲）兜住，而不是 15s。这是刻意的 —— 15s 只该判断「这次回传有没有被接住」。
- 重试仍可能重复投递工具结果（官方同样是 3 次尝试）。上游侧对同一 review 的重复
  `reportToolResult` 是否幂等无法从 bundle 侧证明，属既有边界，未在本轮扩大。

## [0.5.4] - 2026-10-27

修一个**信封漏进正文**的实报缺陷（用户点名：`session-dba58595` turn 8「帮我关机，关闭电脑」）。

### 故障现场（来自会话日志，逐事件核对）
那一轮 assistant 消息里只有一条 `text` 块，内容是**整块原始信封**：

```
```json
{ "action": "review", "thinking": "…但用户已经明确说"帮我关机，关闭电脑"，…",
  "tool": { "type": "mcp", "mcpServer": "mcp-server-orcaterm-oauth",
            "name": "execute_command", "args": { "command": "shutdown /s /t 0" } } }
```
```

后果：DSH 没有任何 tool_call，关机命令没被执行；用户看到一大段 JSON。
**现场特征**：reasoning 恰好被截在 `但用户已经明确说`（未转义引号的断点），正文是整块围栏 JSON。

### Root cause
模型把信封写成了**非法 JSON** —— `thinking` 的值里带了未转义的 `"`。于是：
1. `parseToolEnvelope` 的 `JSON.parse` 整包失败 → 返回 null；
2. `finishUnwrap` 的兜底接着又 `JSON.parse` 一次 → 仍然抛异常 → catch；
3. `fallbackText = plainTextFallback` → **整包原文当正文下发**，信封里的工具调用就此丢失。

只要模型输出非法 JSON，信封就必然走这条链路 —— 与「模型心情」绑定的间歇性缺陷。

### 另修同类来路的第二条通道
正文侧的围栏拦截过去是对**单个 delta** 做 ```` ```…``` ```` 正则匹配。线上信封会被切成几十帧，
逐帧匹配永远等不到同时含首尾围栏的那一帧，原始 JSON 直接流给用户。

### Added
- `recoverToolEnvelope(raw)`：严格解析失败后的**容错恢复**。定位 `"tool"` 对象，用容忍未转义引号的
  取值器（收尾引号 = 后面跟 `,`/`}`/`]` 的那个）读出 `name`/`type`/`mcpServer`/`description`/`args`，
  并顺带取回完整 `thinking`。判据刻意收紧：必须拿到 `name`，且还要有「信封证据」
  （显式 `action` 或 `args` 对象）—— 宁可漏拦截，也不把散文里顺口一提的 `"tool": {…}` 误吞成工具调用。
- `createEnvelopeFenceGuard({maxHold})`：跨帧围栏守卫。疑似信封的 fenced 块**挂起到闭环**再判定；
  挂起期间不出字，闭环后交给 `recoverToolEnvelope`：是信封就转工具调用（并**不下发**原始 JSON），
  不是就**原样**放行（含围栏，不丢一个字）。`maxHold` 超限与 `flush()` 都把内容原样交还调用方，
  绝不吞正文。
- 被打断的思考链尾段改道：畸形信封里状态机只吐出了 `thinking` 的前半段，恢复出的完整值差额补进
  reasoning —— 否则这段思考会随原始 JSON 一起漏进正文。
- 后端 stderr 一行诊断（仅在恢复生效时）：`本回合的信封不是合法 JSON，已按兜底恢复：tool=… action=…`。
  畸形信封是模型侧输出缺陷，但必须留痕，否则事后无从解释「这一轮为什么有工具调用」。

### Fixed
- `finishUnwrap` 整包兜底改用容错恢复：非法 JSON 不再退化成「原文当正文」。
- 围栏守卫还挂着内容时，`finishUnwrap` 不再重复处理同一段文本（归属权归守卫，避免双份下发）。
- `createEnvelopeFenceGuard` 的单帧超长路径也会立即放行（原先只在跨帧路径检查 `maxHold`）。

### Verified
- **新增 `test/malformed_envelope.mjs`（已接入 `npm test`）**：用假上游（说 OrcaTerm SSE 方言）
  把线上那份**逐字符照抄**的畸形信封分 6 片投递，断言反代必须产出
  `pwsh {command:"shutdown /s /t 0"}`、`finish_reason=tool_calls`、**正文里不含 `action`/`mcpServer`/
  命令/围栏**、且思考尾段进了 reasoning。
- 该测试**先证明能抓到 bug**：把 `finishUnwrap` 临时换回修复前的严格解析逻辑，同一测试报
  `应恰好 1 个工具调用，实际 0；正文={"action": "review", "thinking": …}` —— 与线上现象一致；
  换回修复后转绿。（测试内还断言样本确实是非法的 `JSON.parse`，保证它测的是兜底路径。）
- `npm test` 全绿（config_check + smoke 27 组 + malformed_envelope 3 组）；活体回归 **17/17**
  （正文流式未受影响：守卫只在正文出现 ````json{` 时才挂起）；`/health` v0.5.4；正常回合 stderr 空。

### 边界
- 容错恢复是**尽力而为**：若 `args` 本身也是非法 JSON，仍能恢复工具名（`args` 退化成空对象，
  由 `resolveDshToolCall` 兜底），但恢复不出具体参数 —— 诊断行里的 `argsRecovered=false` 会标明。
- 守卫会在正文出现 ````json{` 时**延迟**该块的输出到围栏闭合（内容最终原样到达）。
  这是「要么延迟、要么漏拦截」的取舍：正文一旦流出就无法收回。

## [0.5.3] - 2026-10-27

把「上游提问」接成 DSH 的原生提问弹窗，并补上第二种官方工具结果信封；两者都经**真实 dsh web
会话**验证（不是只跑离线断言）。

### Added —— 提问信封 → `ask_user_question` 弹窗（双向）
- 上游 `{action:'ask',question,options}` 此前只被翻成「正文 + `**选项：**` 清单」，用户只能自由
  打字。现在调用方声明了 `ask_user_question` 时，反代**额外下发一个真的工具调用**
  （`askEnvelopeToQuestionTool`：信封 `options` → DSH 弹窗选项；`header`/`multiSelect` 透传；
  选项上限 12 条；字符串/对象两种选项形态都吃）。正文照常流式可见，不牺牲打字机。
- 答复回程按官方 `respondToAsk`（模块 2481 `at`）：`{type:'ask', input:<答复原文>}`，
  由 `askResultToAnswerText` 把 DSH 的 `{answers:[{id,selected,custom}]}` 拼成人读文本；
  跳过/未决/非 JSON 一律给明确文本，不回空串（空串会被上游当成「没答复」）。
- 没声明该工具时行为完全不变（退回正文 + 选项清单），不会下发宿主执行不了的工具名。

### Added —— 第二种官方工具结果信封
- `resultEnvelope`：`'review'`（默认）| `'ask'`。前者是桌面子 Agent 循环的形态（桌面 bundle 里
  **唯一在消费**的回传路径），后者是主循环模块 2481 导出 `reportToolResult`（`st`）的形态
  `{type:'ask', input:'{TOOL_RESULT}(<tool.name>): <result>'}`（标签常量见模块 68280、
  入站正则见模块 73383，由新增 `wrapToolResultInput` 按同样的 `[a-z0-9_-]+` 约束生成）。
- 支持逐轮覆盖 `orca_result_envelope`（live A/B 用，不必重启后端），并贯通到
  `lib/config.js` 的 `DEFAULTS`/`MANAGER_KEYS`、`cordis.patch.yml` 与 provider 的 env 下发。

### Changed
- `toAssistantInput(messages, options)` 新增可选第二参（`resultEnvelope` / `askCallIds`），
  旧调用方式与旧行为不变；提问答复优先于工具结果信封判定。
- `ORIG_TOOL_BY_CALL` 之外新增同寿命的 `ORCA_ASK_BY_CALL`：提问信封没有 `tool` 对象、
  回程也不走 `reportToolResult`，光靠前者分不出两种回传。

### Verified
- **真实 dsh web 会话（OrcaTerm DeepSeek-V4.1-Flash）端到端 4 步全绿**，会话日志逐事件核对：
  ① `tool/call ask_user_question`（`call_orca_ask_fa5a451a_1`，3 个选项）→ 在弹窗里选中第 1 项
  提交 → `tool/result {"answers":[{"id":"orca-q-fa5a451a","selected":["验证所有工具是否正常工作…"]}]}`；
  ② `tool/call pwsh` → `tool/result orchaterm-tool-probe`（真 stdout）；
  ③ `tool/call pwsh`（模型自己选 `Get-Content | ConvertFrom-Json`，没用 read）→
  `tool/result 0.5.2`；④ 收尾总结。说明工具调用识别、结果回传、弹窗问答三条链路都通。
- **工具结果信封 live A/B**：同一问句下 `review` 与 `ask` 两种形态都被上游正确消费
  （均读出 `orchaterm-tool-probe` 并给出正确结论）—— 所以默认值的选择依据是「哪个更贴官方」。
- `npm test` 全绿（smoke 25 → **27 组**：新增提问信封双向适配、以及**畸形结构化指令兜底**
  —— 畸形选项/超长选项/非字符串 question/畸形答复/丢档反推/坏 JSON 参数/混批/优先级）；
  活体回归 **17/17**；`/health` v0.5.3。

### 边界
- 提问信封只承载单个 `question` 字段，故恒定产出单问题批次；上游若把多问题塞进同一信封
  （未见过），会退化成「一个弹窗问合并后的问题」，不会丢内容。
- 混批（同一轮既有提问又有真工具结果）整批走工具结果信封，与官方「逐个回传」不同 ——
  DSH 一次给全部结果，只能取其一；已在 smoke 27m 锁定该行为。
- 「上游 ask 信封 → 弹窗」在调用方未声明 `ask_user_question` 时**不会**生效，这是刻意的
  降级而不是缺陷（避免下发不存在的工具名）。

## [0.5.2] - 2026-10-26

> ⚠️ **先记一次实现丢失事故**：v0.5.0 提交（7b21e4a）声称的「`run-*-tool-*` 帧结构化」与
> 「客户端掐断 → 补发 abort」两处 server.js 改动**实际不在提交里** —— 编辑期间多次出现
> "file changed since it was read"，其中两次编辑被文件竞争回滚，而文档照常写了。本轮核验
> git 历史时发现，已找回并补回。教训：**声称落地的行为必须在提交前用 grep/diff 对过盘**，
> 不能只看编辑工具报成功。

### Fixed（找回 v0.5.0 丢失的两处实现）
- `run-*-tool-*` 后端工具结果帧结构化透出（带类别与脱敏摘要、跳过解包器）；
- DSH 用户点停止 → 感知客户端掐断且流未走完 → fire-and-forget 补发 `/stream/abort/{cid}`。

### Added —— 断流续传接入对话流（`/stream/resume` 待办完结）
按官方 `It/Rt` 语义（模块 2481）接入 serveChat 主流程：
- 读循环重构为 `processLine`/`pumpStream`（主流与续流共用），新增 `frameCount` 按**全部 data
  item** 计数（官方 `streamChunkOffset` 的口径：onMessage 先 `u+=1` 再过滤）；
- 流异常中断（无 `[DONE]`/`[ERROR]`/`[ABORTED]`、客户端也没走）时先查 `/stream/status` ——
  仍 `running` 就 `GET /stream/resume/{cid}?offset=<frameCount>` 续流一次，解包状态机与滤镜
  原样延续，DSH 侧表现为同一条流；官方 `Rt` 有单次重入护栏，这里同样只续一次；
- 新增 `/orca/stream-resume?conversationId=&offset=` 直通端点（排障对照用）。

### Verified
- `npm test` 全绿（25 组）；活体回归 **17/17**；`/health` v0.5.2；stderr 空；
- 续流真机验证：对**已完成会话** `GET /stream/resume/{cid}?offset=0` → 上游回
  `text/event-stream` + `data: [DONE]`（无 running 流则立即正常终止），证明路径段 cid +
  offset 查询参数形态被上游真实接受；带凭据探测经 `/orca/stream-resume` 直通端点完成。

### 边界
- 「上游中途真断流 → 续流成功」的完整触发链无法在线上稳定复现（需人为掐上游连接），
  由 URL/响应判定的真机验证 + 与官方实现同构保证；status 非 running 时行为与旧版完全一致。

## [0.5.1] - 2026-10-26

补上 v0.5.0 逆向中发现但未接线的最后一个用户侧通道：**未决 review 的用户文本反馈**。

### 逆向依据
模块 2481 `ut`（resolveSendInput）：上一信封 `action:"review"` 时，用户打字不产生新 `start`，
而是 `{reviewAction:'feedback', input:<文本>, tool:<未决工具原件>}` 续进同一 review 循环；
`feedback` 与 `approve/cancel/reportToolResult/proceedToNextTool` 同属 reviewAction 枚举（模块 82025）。

### Changed
- **`toAssistantInput` 新增 feedback 分支**：最后一个 assistant 带 `tool_calls` 且 DSH 没回任何
  `role:'tool'`、用户直接打字/改口时，发 `{type:'review', reviewAction:'feedback', input, tool}`
  （tool 优先取信封原件 LRU，丢档走反推）。此前误发 `start`，上游挂着的 review 得不到回应。
  优先级：工具结果轮（reportToolResult）> feedback > start；上个 assistant 是纯文本时不触发。
- **reviewInput 分支补 `emphasisPrompt` 字段**：官方 `Fe` 对所有 input 类型统一注入
  `{id, emphasisPrompt, files}`，v0.5.0 只补了 `id/files`，这次补齐（空值）。

### Verified
- `npm test` 全绿（smoke 24 → 25 组：feedback 判定、reportToolResult 优先、start 不误触发、首轮不受影响）；
- feedback 场景活体重放 **2/2**：工具调用后用户改口「先不用查了」，模型把话理解为对未决工具的
  反馈、正常应答且**不重发工具调用**；
- 活体回归 **17/17**；`/health` v0.5.1；stderr 空。

## [0.5.0] - 2026-10-26

继续逆向客户端 API 封装（`orcaterm_start_core` 模块 2481 = 完整 Agent 状态机，19.6KB 美化后
1063 行逐行读毕），把流控制通道、回传重试语义、结果脱敏三块官方行为移植进反代。

### 逆向发现（模块 2481/82752/32804/35482/11232/72535/67537，均为一手源码）
1. **流控制三件套**（模块 2481 的 `It`/`Rt`/`Lt`/`jt`）：
   - 会话 ID 放在**路径段**：`GET {base}/stream/status/{cid}`、`GET {base}/stream/resume/{cid}?offset=N`、
     `POST {base}/stream/abort/{cid}`（空体 `{}`）；查询串统一 `name/mode/csrfCode/sseresume=true`；
   - 官方「停止」= 本地 AbortController.abort() **＋** 服务端 abort POST（`jt`）；
   - `/stream/resume`：页面重载后若 status=running，以 `offset=<已收 chunk 数>` 续流 SSE。
2. **回传重试公式**（模块 32804 `SE` + @78376 实参）：`attempts=3, timeoutMs=15000,
   baseDelayMs=300, maxDelayMs=1500`，退避 = `min(base·2ⁿ, max)` → 300/600/1200ms。
3. **`Sn.fp` = 敏感信息脱敏器**（模块 35482，此前误以为是「格式化器」）：14 条正则把
   PEM 私钥块、sk-/AKIA/ghp_/AIza/xox/sk_live、JWT、URL 内嵌凭据、Bearer、敏感 KEY=VALUE
   赋值、CLI 密码参数（sshpass/mysql -p/redis-cli -a/curl -u）全部替换为 `[已隐藏…]`/`***`，
   **回传工具结果前必过**。这是行为级等价——上游看到的工具结果形态与官方一致。
4. **UI 工具官方全集与权限分类**（@76135 En/Tn + `An`）：headless 15 个（官方**免确认**自动
   执行，含 remote_read/write/glob/grep、execute_terminal_command）、foreground 8 个
   （需前台确认，含 run_commands、remote_edit）。mcp → 先 approve（15s）再由上游代执行；
   system → 等前台。
5. **`reviewAction` 全集**（模块 82025）：`approve / feedback / cancel / reportToolResult /
   proceedToNextTool`；`feedback` 是用户以文本回复 review 的官方通道。
6. **请求形态对齐点**：`input.id` 与 `x-seqid` 是**同一个值**（Fe）；会话 ID 形态
   `cid-{id}-{assistant}`（orcaterm → `cid-<uuid>-orcaterm`，mode 0=RE_ACT 不加后缀）；
   后端代执行结果帧的判据是 id 匹配 `^run-.+-tool-.+`（模块 3222 `zV`）。
7. 子 Agent 循环 30 轮上限确认（`for(s+=1;s<30;)`），子 Agent 输入为 `type:'start'` +
   独立系统提示词数组；用户中断子 Agent 时直接抛错中止。

### Changed（行为级）
- **DSH 用户点停止 → 通知上游中止**：provider 掐断到反代的连接时，若上游流未走完，
  反代 fire-and-forget 补发 `POST /stream/abort/{cid}`（官方 stop 语义的完整移植）。
- **工具结果轮的传输重试升级为官方参数**：attempts=3、单次 15s 超时、退避 300→600→1200ms；
  普通轮维持既有 3 次/600ms。
- **回传工具结果前先脱敏**（`redactSecrets`，官方 Sn.fp 逐条移植），转存指引在其后追加。
- **请求对齐**：所有 input 补 `id = x-seqid`；新会话 ID 改为官方形态 `cid-<uuid>-orcaterm`
  （provider 的稳定 id 同步改为 `cid-<hash>-orcaterm`；老会话因此换新上游会话，一次性成本）。
- **后端工具结果帧结构化**：`run-*-tool-*` 帧不再喂给解包器（结果原文非 Agent JSON，
  喂进去会污染兜底缓冲），改为带类别与脱敏摘要的可读行。
- 新增管理端点：`POST /orca/stream-abort`、`GET /orca/stream-status?conversationId=`、
  `GET /orca/stream-url?conversationId=&kind=abort|status|resume`（观察用）。

### Verified
- `npm test` 全绿（smoke 扩到 24 组：脱敏 10 形态、分类器、退避公式、input.id/流控制 URL/cid 形态）；
- 活体回归 **17/17**；协议金标准重放 **4/4**（伪造 4711/2300/23 精确消费，假 JWT 被脱敏且
  模型复述时提示「令牌已隐藏」）；
- 流控制端点真机验证：`/stream/status/{不存在的cid}` → `{status:'none',chunkCount:0}`、
  `/stream/abort` → ok；`/health` v0.5.0；stderr 空。

### Notes / 边界
- `/stream/resume` 已实现 URL 构造与文档，但未接入对话流（DSH 无续流概念；官方用于页面重载
  后接回 running 流）。将来若要在认证重试中复用中断流，这里是入口。
- 我们声明 `uiServers` 且 `mcpServers: []`，所以「mcp 先 approve」路径仍未启用（待办 3 保留）；
  分类器与全集清单已移植（`classifyUiToolCategory` / `UI_TOOL_HEADLESS` / `UI_TOOL_FOREGROUND`），
  将来声明 mcpServers 时按 `An` 分类走 approve 即可。
- `selectedUITools` 仍只声明可真正映射到 DSH 工具的 7 项：官方全集 23 项里其余 16 项
  （get_terminal_output、list_terminals 等）依赖真实终端连接，声明了只会换来模型调用失败。

## [0.4.0] - 2026-10-25

按用户要求**原样逆向 OrcaTerm 客户端的 API 封装**（REA + 线上明文 bundle），据实测把工具结果
回传切换到**官方协议**。这是行为级变更，版本升 0.4.0。

### 逆向发现（orcaterm_start.js，REA evidence ev_fd6f9d58…，1962 个模块）
1. **官方工具结果协议**（子 Agent 循环，@345023 等 4 处一致）：
   ``{type:'review', reviewAction:'reportToolResult', toolResult, tool}``
   其中 `tool` 是上游信封里的**原样 tool 对象**；用户拒绝时同样走 reportToolResult（文本不同）；
   mcp/system 类工具先发 `{reviewAction:'approve'}` 由后端代执行。官方客户端回传带
   3 次重试 / 15s 超时 / 300→1500ms 退避；子 Agent 循环上限 30 轮。
2. **信封解包双路径**（@73109/@143035）：官方客户端的思维链 = SSE `reasoningContent` **或**
   `aiData.thinking`，二者取并集 —— 印证 v0.3.4/0.3.5 的双路径实现与官方一致；
   另有消息级 `reasoning` 布尔（reasoningActive）。
3. 权限模型：toolSource 枚举 `ui | mcp | system | sub_agent`，effect `allow|ask|deny`，
   lifetime `once|persistent`（客户端本地权限规则，与服务端无关）。

### 决定性对照实验（同任务、同凭据、同会话形状）
- **官方协议**：模型精确答出伪造结果里的「37 个 / 5 个超 300 行」——结果被结构化消费；
- **旧协议（ask + {TOOL_RESULT} 文本）**：模型答「总数 0，未找到任何 .md 文件」——
  **完全无视结果文本**。这正是此前会话「未收到扫描结果」症状的真正根源：
  旧协议把结果当普通用户消息，模型时吃时忽略。

### Changed（行为级）
- **工具结果回传切换到官方协议**：`toAssistantInput` 的工具轮改产
  `{type:'review', reviewAction:'reportToolResult', toolResult, tool}`；
  `tool` 优先取**信封原件**（新增调用级 LRU `ORIG_TOOL_BY_CALL`，512 条，emitToolCall 时按
  callId 记住上游原样 tool 对象），丢档（进程重启）时由 `reconstructOrcaTool` 按映射反推兜底。
  多个工具结果合并为一份 toolResult（官方逐个回传并等待响应；DSH 一次性给全部，只能合并，
  带序号标注）。`assistantBody` 新增 `reviewInput` 直通口；`appendSpillHint` 指引保留。

### Verified
- 协议重放（全链路走反代）：伪造「4711 个文件 / 2300 行 / 23 个超限」，模型精确答出全部三个数
  （4,711/2,300/23），未编造、未重发工具，5/5 PASS；
- `npm test` 全绿（20 组）；活体回归 17/17；`/health` v0.4.0；stderr 空。

### Notes
- `ask + {TOOL_RESULT}` 路径彻底移除（对照实验证明不可靠）；若上游将来变更协议，
  逆向依据与坐标都记录在 WORK_SUMMARY 第 17 节。
- 官方回传有 3 次重试；反代已有等价的传输层重试（serveChat attempt 1..3），未重复实现。
## [0.3.6] - 2026-10-25

用户追问 v0.3.5 没覆盖的「第二次中断」（模型称未收到扫描结果、dsh web 停止继续）。深挖后定位到完整链条，并加了针对性修复。

### 第二次中断的完整链条（实测复现）
1. 会话里三次 tool/result **全部精确 49,932 字符、开头从文件名中间截断** —— DSH 的 pwsh 工具
   在输出超限时**砍头留尾**（~50K 上限），并在结尾留转存文件指针
   `Full formatted result stored at <path>. Use read with offset/limit…`。
2. 直连复现证明**结果确实送达且可读**：无头 25K 结果回传后，模型能正确指出「输出被截断了，
   而且看起来是同一个文件重复输出了很多次」，追问时还能原样引用其中一行 ——
   它不是没收到，而是**正确判断这截无头数据不可用**。
3. 但它随后选择「要用户提供/重新扫描」而不是自救 —— dsh web 因此正常结束回合（模型以问题
   结尾、无工具调用，DSH 等用户输入，不是传输故障）。
4. 顺带测出上游的硬上限：60K 字符的工具结果可正常消化，90K 直接整请求失败（回退成问候语）。

### Fixed —— 转存恢复指引（`appendSpillHint`）
检测到工具结果带 DSH 的转存指针时，在 `{TOOL_RESULT}` 后附一段恢复指引：告知输出被截断、
完整内容在 `<spillPath>`、**不要认为数据缺失或要求用户提供**，应调用 execute_command
分段读取（`-TotalCount` / `-Tail` / `Select-Object -Skip`）或直接在文件上统计。

**验证（同形状重放）**：同样回传无头截断 + 转存指针的结果，修复前模型答复「扫描命令已提交，
尚未收到实际数据…请粘贴执行结果」；修复后它直接发出
`Get-Content -LiteralPath '…dsh-spill\\…-pwsh.txt' -Tail 20` 自救，2/2 PASS。

### Verified
- `npm test` 全绿（20 组不变）；活体回归 17/17；`/health` v0.3.6；stderr 空。

### Notes
- 该修复只对「带 DSH 转存指针的结果」生效（正则匹配 `Full (formatted )?result/output stored at`），
  普通结果不受影响。
- 上游对**整个请求**存在 ~60–90K 字符级的硬上限：即使 DSH 截到 50K，多轮累积后仍可能触顶 ——
  属上游限制，反代侧无法消除，只能靠指令让模型少拉全量输出（指引里已引导它做统计而非全读）。
## [0.3.5] - 2026-10-25

用户报（`session-fb62c7fd`）三个现象，实为**两个根因**，均已修：

### 根因一：标题生成请求污染主对话的上游会话（对应现象 1、3）
DSH 的会话标题请求（`session-title-llm`）带**同一个 sessionId** 和 `purpose: 'session-title'`
（`packages/session/session-title-llm/src/index.ts:263`），此前与主对话共用同一个上游
conversationId —— 「Create a concise title…」指令被插进主对话的工具流程中间，打乱上游
Agent 的待办状态。会话证据：turn=1 step=2 的推理内容是「为会话生成标题」而非处理工具结果；
turn 3 工具结果已送达（tool/result 记录存在、非 error），模型却答复「未收到扫描结果数据」。
（先排除了一个嫌疑：dsh web 进程 20:27 启动，晚于 v0.3.0 的 lib 修复提交，
`role:'tool'` 转换确实已生效 —— 工具结果是送达了的，乱的是上游会话状态。）

**修复**：`conversationKey` 对带 `purpose` 的辅助请求（`'session-title'` | `'compaction'`，
主循环不带此字段）改用独立键 `aux:<purpose>:<sessionId>` —— 标题/压缩请求各自落到独立的上游会话。

**复现验证**（真实 provider 完整重放该场景）：主对话发工具调用 → 同 sessionId 发标题请求 →
主对话回传工具结果。修复后标题请求走独立会话（cid-dsh-40f61d11 ≠ 主对话 cid-dsh-ac37aec7），
工具结果轮正确答出「37 个 .md 文件」（喂的是伪造结果，能答对即证明结果真的被使用），6/6 PASS。

### 根因二：`<thinking>` 字面标签漏进正文（现象 2）
模型偶尔把思维链**同时**写进信封 `thinking` 字段和 `taskCompletion` 正文里的字面
`<thinking>…</thinking>` 标签 —— 后者原样漏进用户可见正文。

**修复**：新增 `createThinkingTagRouter`（与问候语剥离器同型的流式状态机）：把正文里的
`<thinking>` 块吃掉、内容转成 reasoning 流；开标签未到齐时扣住尾部片段；等不到闭标签
（超 maxHold 或流结束）时把开标签补回去按正文放行 —— 宁可漏改道，不能吞正文。

### Verified
- `npm test` 全绿，smoke 扩到 20 组（新增 19：标签改道含逐字符分片/中段标签/无闭标签兜底；
  20：purpose 隔离键）。
- 场景重放 6/6（见上）；活体回归 17/17；`/health` v0.3.5；stderr 空。

### Notes
- `purpose` 隔离对 `compaction`（DSH 上下文压缩请求）同样生效 —— 压缩指令也不该进主上游会话。
- 标签改道只认完整的 `<thinking>`/`</thinking>`；模型若用别的标签名（如 `<think>`）不会误伤。
## [0.3.4] - 2026-10-25

用户报（`session-86560dd5`）：反代会话没有调用工具执行、全程看不到推理思维链。逐项核查：**工具桥没坏**，**推理是真 bug**，已修。

### 先说结论（避免误判故障）
- **该会话的任务是浏览器自动化**（登录 X.com 爬取资源、用 Chrome DevTools MCP）。而上游 OrcaTerm Agent
  只认它自己的终端/文件工具集（`execute_terminal_command` / `remote_read` …），且**忽略调用方声明的
  function schema**（v0.2.0 审计结论）—— DSH 的浏览器工具对它不存在。所以它回复了澄清式提问
  （`action:"ask"`）或纯文本（模型甚至在正文里手写了 `<thinking>` 标签）—— 这是上游行为，不是链路断了。
- **终端任务的工具链路实测正常**：同代理同配置，「列出目录并检查 git 仓库」稳定拿到
  `finish=tool_calls` + pwsh 调用（活体回归 16/16 里的 C1/C2 就是这条链）。

### Fixed —— 思维链被静默丢弃（真 bug）
- **现象**：dsh web 全程看不到推理流；会话里 reasoning 总字符 = 0。
- **根因（直连探针）**：当前 deepseek 槽位把思维链放在**信封 JSON 的 `"thinking"` 字段**里：
  `` `{`"action":"completion","thinking":"思维链…","taskCompletion":"正文…"`}` ``，
  而不是 SSE 帧的 `reasoningContent`。反代的解包状态机只认 `taskCompletion`/`question`，
  thinking 整段被无声丢弃。
- **修复**：`feedUnwrap` 改成多字段循环状态机 —— 依次解出 `thinking`（→ `reasoning_content`
  流式下发，不走正文滤镜）、`taskCompletion`/`question`（→ 正文）。安全性依据：JSON 字符串内的
  引号必为 `\"`，裸 `"key"` 只可能是真键，扫描不会误入字符串内部。`finishUnwrap` 的整包兜底
  同步补了 `obj.thinking`。修后实测：推理题回 102 字思维链、终端任务在发工具调用前回 101 字思维链。
- 顺带修了实现中段的一个自伤 bug：字符串收尾帧的 delta 会因 `currentField` 被提前置空而走错通道，
  现在先取局部快照再清。

### Verified
- 活体回归扩到 **17 项**：新增「A1 有思维链（信封 thinking 字段 → reasoning 流）」锁住这条链路。
- `npm test` 全绿（18 组 smoke 不变）；`/health` v0.3.4；stderr 空。

### Notes
- thinking 字段是在 **deepseek 槽位**上观测到的；glm-4.7-thinking 等其它槽位可能走 SSE
  `reasoningContent`（老路径保留，两种形态都支持）。
- 浏览器类任务走这个 provider 不会产生工具调用（上游没有浏览器工具），需要浏览器自动化时换
  DSH 本地直连的 provider。
# Changelog

## [0.3.3] - 2026-10-25

用户报：OrcaTerm 已启动，但 dsh web 走反代仍报 `Invalid or expired AccessToken`。这是同一根因的**第三次**出现 —— 本轮把它修成「不再需要人工重启反代」。

### 根因（老问题，这次有了完整数据）
- token 寿命 ~2h，桌面端运行中会持续刷新 `%APPDATA%\com.orcaterm-desktop.app\data.bin`；
- 但反代只在**启动时**读一次登录态（`buildConfig` 快照），此后桌面端刷新再多也不感知；
- 本次实测：代理进程里的 token 00:37 就过期了，桌面端 20:37 启动后 store 里已有到 21:28 的新 token，旧代理进程仍揣着旧的。手动重启反代即恢复（`HTTP 200 正文: "正常"`）。
- `resolveCredentials` 本来就会「挑最新」—— 问题从来只在「只跑一次」。

### Fixed
- **凭据临期自动刷新（`ensureFreshCredential`）**：`handleChat` / `handleModels` 在每次上游调用前检查 token 的 `exp`，距过期不足 120s（或解析不出 exp）就重读桌面端登录态（两次文件读）。健康时**零 IO**；桌面端没开时重读到的仍是旧值，行为不变差。
- **认证失败自动重试一次**：assistant 请求若返回认证类错误（`Invalid or expired AccessToken` / `NEED_UIN_AND_SKEY` / `VERIFY_USER_FAILED`），刷新凭据后**重入 `serveChat` 一次**（该分支响应头未写过，重入安全；`authRetried` 防死循环）。
- **流内认证错误也触发刷新**：SSE 中途收到认证类错误时本轮无法重试（头已发出），但立即刷新凭据，让**下一轮**拿到新 token。
- `buildConfig` 的 `cookieFor` 改为读**当时的** `config.credential`（此前捕获启动时的 jar/快照，刷新后不会生效）。

### Verified
- `npm test` 全绿；smoke 扩到 18 组：新增 18a–18e 覆盖「健康零重读 / 临期替换 / exp 解析不出也重读 / 手搓 config 不抛错 / cookieFor 跟随刷新」。
- 真机验证：重启后 `HTTP 200 正文: "正常"`；`/health` → `v=0.3.3`。
- 说明：本轮 token 尚未到期，「临期触发」路径无法在线上复现，由单测 18a–18e 覆盖；线上验证的是「不回归 + 恢复可用」。

### Notes
- 刷新只依赖桌面端**已落盘**的 store/jar；桌面端完全没开且 token 过期时，行为与之前一致（报 AUTH，提示开 OrcaTerm）。

## [0.3.2] - 2026-10-25

对齐客户端身份（origin / referer / UA）。**先记一条更正**：v0.3.1 的「遗留」里我写了
「桌面端 CGI 会带 `&region=`、`&withClientUA=1`、`&withClientIP=1`，插件没带」——
**那句归属错了**，本轮 grep 后撤回。

### 更正：`region` / `withClientUA` / `API_HOST` 不属于 OrcaTerm 的请求路径

v0.3.1 把 `web_sdk.zh.*.js`（腾讯云控制台**通用** CAPI SDK）当成了 OrcaTerm 自己的 CGI 路径。逐串统计：

| | `withClientUA` | `API_HOST` | `i=region/` |
| --- | --- | --- | --- |
| 网页版 `start.js`（**OrcaTerm 本体**） | 0 | 0 | 0 |
| 网页版 `web_sdk.js`（控制台通用 SDK） | 3 | 6 | 1 |
| 桌面端含 `/cgi/api?` 的那份产物 | 0 | 0 | 0 |
| 桌面端 22MB 主产物（内含同一份 web_sdk） | 有 | 有 | 0 |

OrcaTerm 自己的 CGI 构造只有一条：
`y(e) = "".concat(r.Uw ? i.xV : location.protocol+"//api."+location.host, "/cgi/api?").concat(e)`
—— 里面既没有 `region` 也没有 `withClientUA`。`r.Uw` 是平台开关，在**网页版** bundle 里被编译期
折叠成常量 `const r=!1`（`80212(e,t,n){n.d(t,{O1:()=>o,Uw:()=>r});const r=!1}`），所以网页走
`location.host` 推导分支、`i.xV` 不可达；桌面端是另一份构建、`Uw` 为真，走 `i.xV`
= `https://api.orcaterm.cloud.tencent.com`。这正好解释了 v0.3.1 看到的「桌面端产物里该常量只出现一次」。

结论：**这一项不该对齐，也没得对齐**。顺带确认 `start.js` 的 CGI 请求头就是
`{X-SeqId, X-Referer: parent.location.href, X-CsrfCode}` —— 插件此前已全带。

### 实测：两个通道都不校验 Origin / Referer / UA

先自证请求头**确实发出去了**（本地回环服务器收到的头：`origin: "http://tauri.localhost"`、
`user-agent: "DESKTOP-UW-SENTINEL"`），否则「不校验」的结论不成立。

助手通道固定同一内容、同一模型、同一参数，只换 Origin：

| Origin | HTTP | SSE | ai 帧数 | 消息数 | 终止符 |
| --- | --- | --- | --- | --- | --- |
| 不带 | 200 | 是 | **22** | 4 | DONE |
| `http://tauri.localhost`（桌面端） | 200 | 是 | **22** | 4 | DONE |
| `https://orcaterm.com`（网页版） | 200 | 是 | **22** | 4 | DONE |
| `https://evil.example`（乱填） | 200 | 是 | **22** | 4 | DONE |

CGI 通道同样：不带 Origin / 乱填 / 桌面端 / 网页版都是 `HTTP 200 OK keys=5`；
`X-Referer` 乱填甚至完全不带也一样 200。

> 上一轮的「不校验」只测了 CGI、且只跑一次，不够严谨；这轮补了助手通道的重复 A/B 才敢写死。

**所以这一项不是修故障。** 做它的理由只有两条：(1) 用户要求与真实客户端一致；
(2) UA 是唯一有远期风险的字段 —— 服务端将来若加客户端风控，
`dsh-orchaterm-web-api/0.3.1` 这种一眼非浏览器的 UA 最容易被识别，而浏览器 UA 实测可得。

### Added
- **`clientIdentity` 配置项**（默认 `desktop`，可选 `web`；CLI `--client-identity`、
  env `ORCA_CLIENT_IDENTITY`）：统一两个通道发出的 `Origin` / `Referer` / `X-Referer`。
  - `desktop` → `http://tauri.localhost`：桌面端 WebView2 History 里的主页面就是
    `http://tauri.localhost/`（访问 35 次），而 `X-Referer: parent.location.href` 发的正是它；
  - `web` → `https://orcaterm.com` + `https://orcaterm.com/terminal`，即 v0.3.1 及之前的口径。
- **`DESKTOP_IDENTITY.userAgent`**：Rust 日志实测的桌面端 WebView2 UA
  （`… Chrome/152.0.0.0 … Edg/152.0.0.0`），两个通道统一改用它，不再发插件自报名字。
  重新取值：`Select-String "$env:LOCALAPPDATA\com.orcaterm-desktop.app\logs\orcaterm.log" -Pattern 'userAgent='`。
  单项仍可用 `origin` / `referer` / `userAgent`（或 `ORCA_ORIGIN` / `ORCA_REFERER` / `ORCA_USER_AGENT`）覆盖。
- smoke 新增 16/17 组：身份口径与请求头拼装，含「绕过 `buildConfig` 手搓 config 时不得发出
  `undefined`」的回归。

### Fixed
- **`cgiHeaders` 的 cookie 回退分支写死了 `api.orcaterm.com`**：v0.3.1 换默认 host 后，
  当 `credential.cookieHeader` 为空、需要回退到按域取 jar cookie 时，会去取**错域**的 cookie。
  现按实际 `cgiBase` 的 host 取；`assistantHeaders` 同样改用统一的 `hostOf()`，
  不再 `new URL()` 直接抛。这是本轮改动暴露出的既有缺陷，与身份无关。

### Notes / 未做
- `clientIdentity` 已进 `MANAGER_KEYS`：它影响后端进程发出的头，改动需重启后端。
- UA 里的 Chrome/Edge 版本随 WebView2 升级而变，是**本机当前值**，不是恒定常量。
- 本轮活体回归中途出现过 `fetch failed` / `terminated`：先用独立计数排除嫌疑 ——
  CGI 通道旧/新 UA 各 10 次全成功，助手通道旧/新身份各 4 次全成功，与本次改动无关，
  是上游/网络的瞬时抖动；重跑后 `desktop` 与 `web` 两种口径均 16/16。

## [0.3.1] - 2026-10-24

用户指出：反代的**后端访问端点不对 —— 用的是网页版推导出来的那个，不是 OrcaTerm 这个封装好的软件实际访问的那个**。查证后确认属实，并修正默认值。

### 结论：不是「端口」问题，是 **host** 问题

先把容易走偏的三点排掉（都有实测证据）：

1. **桌面端没有监听任何本地端口。** `OrcaTerm.exe`（PID 16296）当时**零个 TCP/UDP 端点**；
   全机 LISTEN 列表里也没有 1420 / 1430 / 5180。
2. **1420 / 1430 / 5180 是 Tauri 开发服务器来源，不是生产 API。** 它们只出现在 exe 内嵌的
   **CSP** 里（`script-src` / `worker-src` / `child-src` 白名单，形如 `http://127.0.0.1:1430/**`）
   和图标路径 `http://127.0.0.1:5180/icons/128x128.png`；生产环境 webview 的 origin 是
   `http://tauri.localhost`（Rust 日志实测）。
3. **缓存里出现的 `127.0.0.1:10808` 是本机 v2rayN 代理**，出现在腾讯边缘节点回包的响应头里，
   与 OrcaTerm 无关。

真正的差异是**控制面 host**：

| | CGI 控制面 host | 依据 |
| --- | --- | --- |
| **网页版** | `https://api.orcaterm.com` | 网页端 bundle `orcaterm_start.zh.*.js` 里是**推导式**：<br>`"".concat(location.protocol, "//api.").concat(location.host)` + `/cgi/api?`<br>—— 网页跑在 `orcaterm.com` 上时，正好推出 `api.orcaterm.com` |
| **桌面端** | `https://api.orcaterm.cloud.tencent.com` | 桌面端前端 bundle 里**硬编码**的唯一 API 常量 |
| 助手通道 | `https://lightai.cloud.tencent.com` + `/assistant` | 桌面端常量与 Tauri cookie jar（`lightai.cloud.tencent.com`）一致 —— **这一条插件本来就是对的** |

证据链（桌面端产物，全部只读）：

- `OrcaTerm.exe`（43.3 MB）里 `api.orcaterm.com` 出现 **0 次**，`api.orcaterm.cloud.tencent.com` **1 次**；
- WebView2 缓存 JS（`Code Cache/js/3907231ce2eaa8e3_0`）中该常量唯一出现，邻近字符串为 `//api` 与 `/cgi/api?`；
- WebView2 的 HTTP 服务器属性表（= 桌面端 webview 真连过的 host）里有 `orcaterm.com`、`lightai.cloud.tencent.com`、`cdn.orcaterm.tencent-cloud.com`、`cloudcache.tencent-cloud.com`，**没有 `api.orcaterm.com`**；
- 桌面端区域/host 表另含 `orcaterm.cloud.tencent.com` / `.cn` / `.com.cn`、`orcaterm.intl.cloud.tencent.com`、`orcaterm.com`、`127.0.0.1`；
- exe 内嵌更新清单走 `https://orcaterm.com/cgi/api?action=CheckDesktopUpdateManifest…`。

### Changed
- **`cgiBase` 默认值改为桌面端的 `https://api.orcaterm.cloud.tencent.com`**（原 `https://api.orcaterm.com`）。
  - 仍可用配置项 `cgiBase` 或环境变量 `ORCA_CGI_BASE` 换回网页版口径，注释里写明了两种口径的来源。
  - `/health` 的 `cgiBase` 字段可直接确认当前用的是哪一个。
- 版本号 `0.3.0` → `0.3.1`（`package.json` 与 `backend/server.js` 的 `VERSION` 同步）。

### Verified
- 五个候选 host 用真实凭据逐个实测：`api.orcaterm.com`、`api.orcaterm.cloud.tencent.com`、
  `orcaterm.cloud.tencent.com`、`orcaterm.cloud.tencent.cn`、`orcaterm.com` **全部 200 且无上游 Error**；
  其中两个 `api.*` host 返回相同的用户 AI 设置，三个非 `api` host 返回另一套默认模型
  （`hunyuan_appcreate_agent`），说明 `api.` 前缀确实是另一个 API 面。
- 逐 action 对比两个 `api.*` host：桌面端 host 全部成功（139–7417ms）；网页版推导式 host
  在本轮出现 2 次 `fetch failed`（此前同 action 曾 2673ms 成功），稳定性不如桌面端 host。
- 切换后 `npm test` 全绿；`/health` → `cgiBase=https://api.orcaterm.cloud.tencent.com`；
  `/v1/models` 仍恰好 5 项；活体回归 **16/16 通过**。

### Notes / 未做
> ⚠️ 本节两条已在 [0.3.2] 更正，保留原文以便追溯：第 1 条已于 v0.3.2 实现（`clientIdentity`），
> 且实测两个通道都不校验这些头；第 2 条**归属错误**——`region`/`withClientUA`/`API_HOST`
> 只存在于腾讯云控制台通用 `web_sdk`，不在 OrcaTerm 自己的 CGI 路径上。

- 桌面端的 `Origin`/`Referer` 是 `http://tauri.localhost`，插件仍沿用 `https://orcaterm.com/terminal`。
  实测调用不受影响，故本轮**未改**；若将来出现签名/风控类拒绝，这里是第一个该试的开关。
- ~~桌面端 CGI 请求会带 `&region=`、`&withClientUA=1`、`&withClientIP=1`，网页端另有
  `?i=region/<Action>` 形态。插件目前只带 `action`/`uin`/`ownerUin`，实测够用；
  未验证这些参数是否影响限流或路由精度。~~ —— 见上方更正。

## [0.3.0] - 2026-10-24

本轮来自 `session-fc7c2c2f-6d9e-48d1-8c25-6ec3b06c7b1c` 的实测复盘：正文反复出现前几轮对话、同一个工具调用被重复下发 4 次。根因全部在真机复现并修掉，且都有回归测试。

### Added
- **`backend/agent-protocol.js`（新模块）**：把可单测的协议逻辑从 `server.js` 里拆出来，测试不再复制实现。
  - `createGreetingStripper()` —— 问候语流式前缀剥离（原内联逻辑，行为不变）；
  - `createRepeatStripper()` —— **历史回放剥离器**；
  - `createDeliveredHistory()` —— 会话级「已交付正文」环形记忆（LRU，默认留最近 6 轮 / 20K 字符 / 64 会话）；
  - `classifyCommandShell()` / `wrapCommandForShell()` / `resolvePosixShell()` —— 单 shell 判定与改写；
  - `splitCommandChain()` / `parseCdSegment()` / `toWindowsPath()` / `rewriteCommandChain()` / `describeShellRouting()` —— **混合语法命令的逐段路由**；
  - `resolveDshToolCall()` / `parseToolEnvelope()` —— 工具信封解析与 DSH 契约映射（从 `server.js` 迁入）；
  - `describeExecutionHost()` —— 生成写进上游提示词的执行环境自述。
- **`lib/context.js`（新模块）**：**上游会话上下文与 DSH 消息历史的对账**。
  - `fingerprintMessages()` —— 非 system 消息的逐条指纹（忽略 system，因为 DSH 系统提示词每轮可能带动态内容）；
  - `createContextTracker()` —— 判定 `fresh` / `continue` / `resync`。
- **`conversationMaxRounds` 配置项**（默认 `40`）：上游同一会话最多连续多少轮，超过就换新会话并补发历史（`0` = 不限制）。
- **`sendHistoryMessages` 配置项**（默认 `false`）：是否把 DSH 多轮历史发进 `input.historyMessages`。同步更新 `cordis.patch.yml`、`MANAGER_KEYS`（改它要重启后端）与 `--send-history` / `ORCA_SEND_HISTORY=1` 命令行开关；**仅用于对比排障**。provider 的上下文对账在判定需要换会话时会逐轮覆盖它（请求体 `orca_send_history`）。
- **执行环境自述注入**：`assistantBody` 的 `emphasisPrompt` 现在会带上本机真实环境（Windows → 「命令由 PowerShell 7 执行，请只用 PowerShell 语法；POSIX 风格的命令会被自动转交给本机 Git Bash」），从源头减少模型把命令写成另一个 shell 的语法。

### Fixed
- **工具结果根本没送到上游（这是「工具没有真正跑起来」的主因）**：`lib/openai.js` 的 `formatOpenAiMessages()` 把 `role:'tool'` 当成「未知角色」丢掉，同时把 assistant 消息里的 `{type:'tool-call'}` 内容块当「非文本 block」丢掉。结果是 DSH 明明执行完了工具，送到上游的请求里**既没有那次工具调用、也没有它的结果** —— 上游只能按同样的参数再发一次工具调用，于是死循环。
  - 复现（`provider-probe.mjs`，用 DSH 原生消息形态驱动真实适配器）：
    ```
    [warn] 丢弃非文本 block（type=tool-call）
    [warn] 忽略未知角色 "tool"
    第二轮有没有重复调用同一工具? 有（= 结果没被上游接受）
    ```
  - 修复：`flattenContent()` 把 `tool-call` 块翻成 OpenAI `tool_calls`，`role:'tool'` 翻成 `{role:'tool', tool_call_id, content}`（`reasoning` 块仍有意不回灌）。修复后同一探针：
    ```
    第二轮有没有重复调用同一工具? 没有  正文: "当前工作目录下共有 3 个项目：- AITask - work - dsh-client-config …"
    ```
  - 这一条独立于 shell 问题：**修好它之后，工具轮才第一次真正闭环**。
- **正文反复出现以前的对话内容（根因）**：`input.historyMessages` 会被上游 LightAI 网关**逐条原样回灌**成 `type:"ai"` 帧，位置在正式回答之前：
  ```
  data: {"id":"<uuid>","type":"human","content":"<上一轮用户话>"}
  data: {"id":"<uuid>","type":"ai","content":"<我们发上去的那段 assistant 正文>"}   ← 回灌
  data: {"id":"chatcmpl-<uuid>","type":"ai","content":"…正式回答…"}
  ```
  代理只过滤 `type:"human"`，回灌的 `ai` 帧会被当成正文；而下一轮的历史又包含「上一轮已被污染的正文」，重复逐轮叠加。
  - 决定性证据（`dupe.mjs` 探针，同一 conversationId 且已有服务端上下文时重发历史）：上游共回 3 组消息，其中 `ai` 组 182 字符与上一轮正文逐字相同；反证探针 `replay-probe.mjs` 确认该行为至今仍在，故干净正文确实是代理剥离的结果；
  - **修复**：默认不再发历史。上游凭 `conversationId` 自己保上下文——实测第二轮 `{TOOL_RESULT}` 被正常接受并转入 `action:"completion"`，第三轮（不带任何历史）仍能正确引用前两轮结论，故历史既多余又有害；
  - **二次保险**：`createRepeatStripper` 按会话记住已交付正文，在新一轮输出开头整段吃掉重复内容。即使把 `sendHistoryMessages` 打开，正文也不再回放。
- **工具信封被回灌正文带偏、甚至丢掉**：当上游在信封前先回灌历史时，`finishUnwrap` 的兜底分支会把「回灌正文 + 工具信封 JSON」整段当正文吐出去，`tryToolEnvelope` 因前缀不是 JSON 而失败——**既重复正文又丢掉工具调用**。由上一条的修复 + 剥离器解决（`toolreplay.mjs` 验证：`finish=tool_calls`、1 个干净工具调用、正文 0 字）。
- **命令被交给了错的 shell 解释**：上游按 Linux 主机写命令（`ls -la && git rev-parse …`），实测会话里模型则写了 cmd 写法（`dir /b`、`2>nul`），而两者都被送进 DSH 的 `pwsh`：
  - `dir /b` 在 PowerShell 里被解析成路径 `C:\b` → `Get-ChildItem: 找不到路径"C:\b"`；
  - `2>nul` 在 PowerShell 里会真的建一个叫 `nul` 的文件；
  - 输出不可用 → 模型拿不到有效结果 → 用完全相同的参数重发同一个工具调用。
  - 修复（单 shell）：`classifyCommandShell()` 按「PowerShell 特征 > cmd 特征 > POSIX 特征 > 默认 PowerShell」判定，`wrapCommandForShell()` 做等价改写：
    - cmd → `& 'C:\Windows\system32\cmd.exe' /c '<原文>'`（整体单引号包住，否则 PowerShell 7 会先把自己的 `&&`/`||` 解析掉）；
    - POSIX → `& 'C:\Program Files\Git\bin\bash.exe' -lc '<原文>'`（本机没有 POSIX shell 时如实退回不包装，不谎报成功）；
    - PowerShell → 原样放行。
  - 真机验证：`& '…cmd.exe' /c 'cd C:\AITask && dir /b /ad && echo ''---done---'' && git status --short 2>nul || echo not-a-git-repo'` 在 PowerShell 7 下正确输出目录清单与 git 判定；`& '…bash.exe' -lc "ls -la | head -5 && git rev-parse --is-inside-work-tree 2>&1"` 同样正常。
  - `execute_command` 在原生有 `bash` 的 DSH（Linux/macOS）上直接映射 `bash`，不再绕 PowerShell。
- **混合语法命令只能整体交给一种 shell（`cd x && dir /b && ls -la` 必有两段走偏）**：`rewriteCommandChain()` 现在按顶层操作符切段、逐段路由，再用 PowerShell 7 的 `&&` / `||` / `;` 重新串联：
  - 引号内的操作符不切；单个 `|` 不切（管道两侧必须在同一 shell 里才有意义）；
  - `cd` 段改写成 `Set-Location`：实测**子 shell 会继承 PowerShell 进程的当前目录**，因此后续 `cmd /c` 与 `bash -lc` 段自动落在同一目录（`cd C:\AITask && dir /b /ad && ls -la` 实测两段输出都在 `C:\AITask`）；
  - MSYS 盘符路径可翻译（`/c/AITask` → `C:\AITask`）；`/tmp` 这类 Git Bash 虚拟路径落点依赖安装配置，**不猜** —— 整条链退回单 shell，并优先退到 posix，让 `cd` 至少是对的、后续段报出可读的 `command not found`，而不是静默切错目录；
  - 路由结果写进工具 description（如 `[shell=composed:powershell+cmd+posix]`），判错时一眼能看出走了哪条路。
- **上游上下文与 DSH 侧的压缩/改写脱钩**：默认不发历史后，上下文由上游按 `conversationId` 维护，DSH 的压缩/编辑不会同步上去，上游会话丢失也无法自愈。新加 `lib/context.js` 按消息指纹前缀对账：
  - 追加轮 → `continue`（沿用上游上下文，不补发历史）；
  - 列表变短 / 前缀对不上 / **原样重发（重试）** / 轮数超上限 → `resync`：换一个新会话并一次性补发 DSH 的历史，把压缩结果同步上去并给上游上下文瘦身；
  - **工具结果轮永远 `continue`**：上游还挂着待办的工具调用，换会话会让它变成孤儿；
  - 实测：压缩后（列表只剩一条摘要）`resync` 到 `cid-dsh-…-r2`，模型仍能回答出摘要里的内容，证明改写后的历史确实送达了新会话。

### Verified
- `npm test`：`config_check` + `smoke` 全绿；smoke 扩到 **15 组**，新增：DSH→OpenAI 消息转换（工具结果必须活下来）、混合语法命令链切分与逐段路由、上下文对账判定；另有重复剥离（含逐字符分片、只相似非重放、空历史直通）、已交付正文记忆、shell 判定、命令改写、工具映射、环境自述。
- **可重跑的活体回归 `test/live_regression.mjs`**（`npm run test:live:regression [baseUrl]`，需要反代在跑 + 有效登录态），共 **16 项断言**：
  - A 回放剥离、B 工具信封、C 工具结果被接受、D **provider 契约（DSH 原生 tool-call/tool 消息）**、E **上下文对账（fresh/continue/resync）**；
  - 对 `http://127.0.0.1:8793` 跑通 **16/16**；
  - 脚本最后会打印本轮下发的真实命令，便于在本机直接执行验证「确实跑了」。
- 缺陷复现/修复对照（都是先复现再修）：
  - `provider-probe.mjs`（DSH 原生消息形态驱动真实适配器）：修复前第二轮**重发同一工具调用、零正文**；修复后**有正文、不重发**；
  - `ctx-probe.mjs`：首轮 `fresh` → 追加 `continue`（不补发历史）→ 原样重发 `resync`（换到 `-r1`）→ 压缩后 `resync`（换到 `-r2`，仍能答出摘要内容），9/9 通过；
  - `check.mjs`：混合语法 `cd C:\AITask && dir /b /ad && ls -la | head -4` 真机执行，cmd 与 bash 两段输出都落在 `C:\AITask`。
- 反证探针：确认上游**至今仍会回灌**历史（6 组消息、含 98 字符的上一轮正文原文），故干净正文确实是代理剥离的结果，而不是上游改了行为。

### Notes / 未做
- **不需要本地 SSH 服务**（本轮评估结论）：OrcaTerm 的原生设计是「桌面端连主机、云端下命令、客户端执行」。但本插件走的是 DSH 本机工具执行，命令**本来就在本机真实执行**；fc7c 会话里 8 次 `tool/call` 对应 8 次 `job/registered` + 8 次 `job/settled`，执行链是通的。真正卡住的先是「工具结果根本没发出去」（上文的 `role:'tool'` 丢弃），再是「命令写给了错的 shell」。走 DSH 工具还意味着**仍受 DSH 自己的审批与沙箱策略约束**，而自建 SSH + 桌面端执行会绕开这层约束。
- 上游上下文仍以服务端 `conversationId` 为主（省掉逐轮重发历史），DSH 的压缩/改写通过 `resync` 换会话 + 补发历史来同步；上游自身是否另外做摘要仍未验证。
- 逐段路由是字符串级启发式，不实现完整 shell 文法（例如 bash 的 `case`/`[[ ]]` 内部含 `;` 仍可能误切）；`/tmp` 这类 Git Bash 虚拟路径的 `cd` 不做翻译。两者都会退回单 shell 并在 description 里标 `fallback`，不假装成功。

## [0.2.0] - 2026-10-24

### Added
- **精简并精准核实 OrcaTerm 核心 5 模型矩阵（去除旧版冗余与别名）**：
  - 将模型目录彻底精简为用户选定的 5 个核心模型，完全对齐真实规格：
    1. `DeepSeek-V4.1-Flash` (`deepseek-v4.1-flash`)：思考模式 Max/High/Low，**图片识别（多模态）**，**1M 超长上下文**，客户端默认首选；
    2. `Hy4-preview` (`hy4-preview`)：思考模式 High，**1M 超长上下文**；
    3. `Hy3` (`hy3`)：思考模式 High/Low，128K 上下文；
    4. `Kimi-K3` (`kimi-k3`)：思考模式 Max/High/Low，**图片识别（多模态）**，**1M 超长上下文**；
    5. `GLM-5.3-Flash` (`glm-5.3-flash`)：思考模式 Max/High/Low，**图片识别（多模态）**，当前按用户提供值申报 300K（并非已测得的上限）；
  - 真实 session 负载回放：`session-2987fd6a-64f6-4267-8313-cf6f81fcef43` 原 provider 记录峰值 453,653 输入 tokens 和 325 个工具定义；重建 307 条消息与相同工具定义，经 GLM-5.3-Flash 路由成功完成，无 context-length 错误。
  - 原 session 的 token 计数来自另一个 provider；LightAI 没有返回 GLM 精确 usage 或硬上限，因此此次测试说明该真实请求负载可接受，但不能确定 GLM 的准确最大上下文，也不能把 300K 当作上限。
  - 旧桌面端设置中的 `deepseek-v3::deepseek-v4.1-flash` 只映射为五项中的 DeepSeek-V4.1-Flash 默认项，`/v1/models` 不再额外返回第六个 legacy ID。
  - GLM 实测：用 `session-2987fd6a-64f6-4267-8313-cf6f81fcef43` 重建的真实消息与 325 个工具 schema，经 GLM-5.3-Flash 路由成功完成；原 provider 记录 453,653 input tokens，但 LightAI 不提供 GLM token usage，故 300K 仅为申报值，最大上下文未知。
- **突破 OrcaTerm 封闭生态，实现与 DSH 工具系统的全双工双向桥接（Major Architectural Breakthrough）**：
  - **根因深度审计与推翻**：深入逆向 OrcaTerm Web 前端 bundle（`orcaterm_start_core` 与 `orcaterm_app`）的内部模块 2481 与 72535，彻底弄清了 OrcaTerm Agent 的真实工具调用协议。此前上游之所以「不响应 tools / 报 undefined / 陷入问候循环」，不是网关不可逾越的边界，而是因为：
    1. 前端协议从不传 OpenAI 的 `tools` 字段，而是依赖 `user.setting.uiServers`（客户端执行的 UI 工具）与 `selectedUITools`。此前插件把这些全部传了空数组/空对象，导致模型被剥夺了调用工具的能力。
    2. 上游 `mcpServers` 是云端自主沙箱，因没有远程主机连接而直接返回 undefined 并在首轮自行下发 `completion`；而 `uiServers` 则明确通知云端由**客户端本地执行**，云端下发 `review` 动作后会立即挂起流并等待客户端回报。
    3. 工具结果返回时，上游要求使用 `{TOOL_RESULT}(toolName): output` 标签语法且请求类型为 `type: "ask"`，此前直接作为普通对话历史发送，导致模型无法识别工具返回值。
  - **客户端 UI 工具集激活**：
    - `backend/upstream.js` 在 `user.setting` 中正式注入 `uiServers: ['orcaterm']`、`selectedUITools` 与 `approvedTools`（`execute_terminal_command`, `remote_read`, `remote_write`, `remote_edit`, `remote_glob`, `remote_grep`, `list_terminals`），且保持 `mcpServers: []`，确保工具调用权完整交还给 DSH 客户端，绝不触发云端未绑主机的自动执行。
    - 注入 `emphasisPrompt` 强指令，指导模型在面临运维任务时必须调用工具执行，彻底消除模型在多轮对话中「假装审核完成」的幻觉。
  - **智能工具语义映射器 (`resolveDshToolCall`)**：
    - 在 `backend/server.js` 中构建双向映射：
      - `execute_command` / `execute_terminal_command` / `run_commands` 自动映射为 DSH 本机的 `pwsh`（Windows 环境）或 `bash`（Linux/macOS 环境），并将命令与描述参数自动组装；
      - `remote_read` 映射为 DSH `read` (`file_path`)；
      - `remote_write` 映射为 DSH `write` (`file_path`, `content`)；
      - `remote_glob` 映射为 DSH `glob` (`pattern`)；
      - `remote_grep` 映射为 DSH `grep` (`pattern`)；
      - 若 DSH 声明了同名工具则原样透传。
    - 伴随工具调用下发标准 OpenAI `tool_calls` delta 及 `finish_reason: "tool_calls"`，精准触发 DSH Agent 循环的本地工具执行阶段。
  - **工具返回结果逆向装配 (`toAssistantInput`)**：
    - 当 DSH 本地执行完毕返回 `role: 'tool'` 消息时，`toAssistantInput` 自动捕获前序 `tool_call_id`，将结果重构为 OrcaTerm Agent 协议标准的 `{TOOL_RESULT}(execute_command): <output>`，并将请求 `type` 动态置为 `ask`。
    - 模型接收到真实的本机执行结果后，顺利推进至下一阶段生成最终报告，`finish_reason` 输出 `stop`。

### Verified
- 实测端到端验证：
  - Turn 1：提问查看目录 -> 模型触发 `execute_command` -> 映射并下发 DSH `pwsh` tool_calls -> finish_reason 为 `tool_calls`。
  - Turn 2：DSH 本机执行 `pwsh` 并回传目录输出 -> 逆向装配为 `{TOOL_RESULT}` -> 模型成功解析真实文件列表并输出格式化表格，finish_reason 为 `stop`。
- 完整闭环，真实可用！

## [0.1.4] - 2026-10-24

### Fixed
- **思维链（reasoning）透传打通**：
  - 根因一：`assistantBody` 把 `enableThinking` 硬编码为 `false`（`config.enableThinking === true`，配置从未暴露）。改为缺省 `true`，并跟随 OpenAI 请求的 `reasoning_effort`/`reasoning` 字段动态开关。
  - 实测：`deepseek-reasoner` 回传 883 字符 `reasoning_content`，provider 层已有 reasoning-delta → DSH 思考气泡渲染。注：`deepseek-chat-latest` 等非推理模型本身无思维链，属模型能力而非插件缺陷。
- **工具声明透传链路修复**：
  - provider 层此前把 DSH 工具 schema 完全丢弃（只打警告、`x-orca-tools: ignore`）。现改为 `formatOpenAiTools` 结果放进请求体 `tools` 字段，反代 `toUpstreamTools` 过滤转换后透传给上游 Agent 网关的 `user.setting.tools`。
  - 上游自身执行的工具帧（`item.tool`）从静默计数改为可见正文行（`> ⚙️ [上游工具] …`），让「上游在干什么」对用户可观测。
  - **上游能力边界（实测结论）**：OrcaTerm Agent 网关忽略外部 function schema（tools 字段已确认送达但模型不响应），其命令执行绑定自家 MCP 生态且需会话内已连接服务器；DSH 场景下工具调用仍不可用，纯问候/寒暄轮次上游还会回问候语信封。
- **SSE 中途崩溃导致进程退出**：
  - `session-62714398` 期间 reasoner 测试触发 `ERR_HTTP_HEADERS_SENT` 崩溃（异常处理路径对已 writeHead 的流式响应再次写 JSON 状态行）。`json()` 与顶层 catch 现在检查 `res.headersSent`，SSE 中途出错直接终结连接。

### Verified
- `deepseek-reasoner` 思维链流式透传（883 字符 reasoning）。
- tools 字段确认送达上游（抓包 body 验证），上游忽略为能力边界非插件丢失。
- `npm test` 全绿；进程崩溃路径修复。

## [0.1.3] - 2026-10-24

### Fixed
- **解决 `session-2827878b` 首轮问候语泄漏（第三种问候形态）**：
  - 上游会把问候语作为**正文前缀**拼在回复最前面（含新变体：「…腾讯云云端服务器运维专家」「…遨驰终端内置的…」等，结尾统一为「需要什么帮助？」），且会嵌在 `taskCompletion` 值内部或 fenced 信封正文的开头。
  - 新增 `stripGreeting` 流式前缀剥离器（`backend/server.js`）：分片边界安全（前缀/结尾标记均可跨分片命中），300 字符超长兜底防止吞正文；剥离的问候语记录在 `greetingStripped`。
  - 纯问候语回合（剥离后零正文、零工具调用、未向客户端写过任何字节）：把剥离的问候语原样吐回——寒暄应答寒暄，避免 DSH 侧 EMPTY_RESPONSE 误报。已验证上游对寒暄类首轮**无条件**回问候语，提示词压制与伪造历史均无效，吐回是唯一正确策略。
- **解决 `action: "review"` 等 MCP 工具调用信封泄漏**：
  - 上游第三种动作信封 `{"action":"review","tool":{"type":"mcp","name":"execute_command","args":{...}}}` 原样透传成 ```json 代码块。
  - 新增 `tryToolEnvelope` / `emitToolCall`：拦截 `action + tool` 结构信封，转成 OpenAI `tool_calls` 流式 delta；fenced 匹配改为贪婪模式修复嵌套 `args:{...}}` 截断。
- **`lib/provider.js` 工具调用渲染**：
  - 丢弃 tool_calls 的旧逻辑替换为 DSH `tool-call` 内容块转换（`block-end` + `{type:'tool-call', id, name, arguments}`），DSH Web 端可渲染工具调用卡片。
  - 有工具调用时 finish reason 输出 `tool-calls`（对齐 `@deepseek-ai/dsh-llm` `FinishReason` 契约）；纯工具轮不再误判 EMPTY_RESPONSE。
- **正文统计口径修正**：
  - 新增 `emittedText` 作为「真正下发给客户端的正文」的权威计数（问候语剥离前 `full` 口径错误导致空回合判断永不成立）；非流式响应 `content` 改用 `emittedText`。
  - 流式响应头改为惰性初始化（`beginStream`），空轮判定与吐回兜底可在首字节前完成。

### Verified
- 真实上游端到端回归：fenced completion 信封 + 问候语前缀 + 嵌套 args 的混合流 → 无问候语、无代码块泄漏、正文完整保留（3 项 PASS）。
- 寒暄首轮 → 问候语剥离后吐回，非空。
- 离线 `npm test` 全绿（新增第 6 节：剥离器分片边界 / 变体结尾 / 非问候放行 / 工具信封识别 / 非信封不误伤回归）。

## [0.1.2] - 2026-10-24

### Fixed
- **解决提问工具 (`action: "ask"`) 原始 JSON 泄漏问题**：
  - OrcaTerm Agent 的响应除了正常回答 (`action: "completion"`, 字段 `taskCompletion`)，还包含向用户反问澄清的提问工具 (`action: "ask"`, 字段 `question` 与 `options`)。
  - 重构了 `backend/server.js` 中的流式状态机，同时监听并精确提取 `taskCompletion` 与 `question` 字段内部的正文，剥除外层 JSON 包装及 Markdown 代码块语法。
  - 若 `ask` 工具附带 `options` 选项数组，自动排版为清晰的 Markdown 列表追加至正文末尾。
- **解决正文反复出现重复问候语的问题**：
  - 拦截 OrcaTerm Agent 发送的草稿撤销帧（`id: "remove-*"`），在撤销事件到达且尚未正式输出有效字段时重置缓冲区，彻底避免上游将未提交的初始问候语混入最终正文。
  - 修复 `toAssistantInput` 的消息切分逻辑：准确定位最后一个 `assistant` 消息，其后的多条消息（包括系统提示、用户提问、上下文快照）均合并为当前轮次输入，历史轮次仅包含完成交互的交替消息，消除上游回显多段历史导致的级联重复。
- **Token 自动保活与平滑回退**：
  - 新增 `decodeJwtExp` 函数，比对 JWT 的真实有效截止期。
  - 当手工配置的 `assistantBearer` 过期后，系统自动回退到 OrcaTerm 桌面端实时刷新的 `.cookies` 文件中的 `ot_session`，无需人工频繁换取 Token。
  - 给 LightAI 网关连接增加了自动网络重试（3次），化解偶发的 TLS 握手 reset (`ECONNRESET`)。

## [0.1.1] - 2026-10-24

### Added
- **LightAI 助手双重鉴权支持**：
  - 适配了网关同时校验 `Cookie`（含 `skey`、`uin`、`saas_synced_session`）与 `Authorization: Bearer <assistantBearer>` 的复杂鉴权模型。
  - 增加了 `~/.dsh/orca-credentials.json` 自动解析机制。
- **Agent 协议初版流式状态机**：
  - 初步实现了从 OrcaTerm Agent 的 SSE 流中实时提取 `taskCompletion`，过滤非 AI 历史回显。

## [0.1.0] - 2026-10-24

### Added
- **首次发布**：
  - 实现基于 Node.js 原生的本地反代服务（`backend/`），端口 `8793`。
  - 逆向并打通 OrcaTerm 桌面端凭据解析（`data.bin` 与 `.cookies`）。
  - 实现 CGI 控制台通道与模型列表查询（`DescribeUserAiSetting` / `DescribeAIModelList`）。
  - 实现原生 `LlmAdapter`，成功作为 `orcaterm-web-api` 路由接入 DSH Web 模型选择器。
  - 交付 `install.ps1`、`test/config_check.mjs` 与 `test/smoke.mjs`。

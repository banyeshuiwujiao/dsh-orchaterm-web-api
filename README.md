# dsh-orchaterm-web-api (OrcaTerm / 腾讯或壳终端反代 Provider 插件)

将本机已安装并登录的 OrcaTerm 桌面端（`OrcaTerm.exe`）所承载的云端终端与 AI 模型能力，反向代理为本地 OpenAI 兼容端点，并作为 LLM Provider 接入 DeepSeek Harness (DSH) 客户端模型选择器。

> **架构原则：**
> 1. 本插件**仅注册 Provider（作为模型大语言模型路由）**，不污染全局工具列表。
> 2. 反代服务采用**零依赖 Node.js (>=20)** 原生实现，随插件自带打包（`backend/run.js`），无需外部 Python 虚拟环境或二次编译构建。
> 3. 插件负责全自动的子进程管理（`autoStart` / `killTreeOnDispose` / 管道守护 / `/health` 探活与契约自省）。

---

## 核心设计与逆向分析发现

本插件基于对 OrcaTerm 1.6.6 桌面端（Tauri + WebView2）及线上 Web 版 bundle 的深入逆向分析开发：

1. **凭据来源**：
   - 桌面端数据持久化在 `%APPDATA%\com.orcaterm-desktop.app\data.bin`（明文 JSON，包含 `oauth_access_token` JWT、`userId` 等）和 `%LOCALAPPDATA%\com.orcaterm-desktop.app\.cookies`（Tauri Cookie Jar，包含 `ot_session` 与 `sid`）。
   - 插件后端会自动探测并读取本地登录态，并在日志与接口中执行严格脱敏。
   - **AccessToken 由插件自己续期（v0.6.0）**：用官方 CGI 动作 `OAuthRefreshToken` 换新，结果落在
     `~/.dsh/orca-token-cache.json`。因此**不需要一直开着 OrcaTerm 客户端** —— 只要历史上登录过
     一次（桌面端登录态或 `~/.dsh/orca-credentials.json` 里有一枚 token），之后由插件接管续期。
     详见下文「AccessToken 自续期」。
2. **通道分离与上游鉴权**：
   - **CGI 控制台通道**（桌面端口径：`https://api.orcaterm.cloud.tencent.com/cgi/api`）：
     - 认桌面端的 Bearer JWT 和 `ot_session` Cookie。
     - 支持获取用户身份（`GetUserInfo`）、用户 AI 配置（`DescribeUserAiSetting`）、模型列表（`DescribeAIModelList`）、会话管理（`DescribeConversationList`）等，**本机测试全部 100% 连通通过**。
     - ⚠️ **host 分两种口径（v0.3.1 修正）**：桌面端前端 bundle 里硬编码的是
       `api.orcaterm.cloud.tencent.com`；而 `api.orcaterm.com` 是**网页版按
       `location.protocol + "//api." + location.host` 推导出来的**（网页跑在 `orcaterm.com` 上时正好得到它）。
       桌面端产物里 `api.orcaterm.com` 一次都没出现，所以默认值取桌面端那个。
       要换回网页版口径：配置项 `cgiBase` 或环境变量 `ORCA_CGI_BASE`；`/health` 的 `cgiBase` 字段可确认当前用的哪个。
     - 附：桌面端**没有监听任何本地端口**（`OrcaTerm.exe` 零 TCP 端点）；exe 里的 `1420/1430/5180`
       只是 Tauri 开发服务器的 CSP 白名单，不是生产 API。
   - **Assistant AI 对话通道**（`https://lightai.cloud.tencent.com/assistant/chat`）：
     - 基于 SSE 流式传输，上游要求 `Cookie`（含 `uin`、`skey` 等）结合 `authorization: Bearer` 双重鉴权。
     - 凭据由 `~/.dsh/orca-credentials.json`、本地桌面端持久化与插件自续期缓存联合管理；Bearer 就是上面那枚 AccessToken，续期后 `authorization` 与 `ot_session` 会同步换新。
3. **Agent 协议动态解包与降噪机制**：
   - OrcaTerm 上游服务以运维 Agent 状态机组织输出，包含回答动作（`action: "completion"` / 字段 `taskCompletion`）与反问澄清动作（`action: "ask"` / 字段 `question`）。
   - 反代内核内置字符级流式状态机（`OrcaStreamFilter`），打字机式实时过滤外层 JSON 脚手架与 Markdown 语法围栏，拦截上游的历史反射（`type: "human"`）与草稿撤销帧（`remove-*`），杜绝重复问候语与协议标签泄露。
4. **上游历史回放的处理原则（v0.3.0）**：
   - 上游 LightAI 网关会把调用方发来的 `input.historyMessages` **逐条原样回灌**成 `type:"ai"` 帧（位置在正式回答之前），而它本身已凭 `conversationId` 保存上下文。
   - 所以反代**默认不发历史**（`sendHistoryMessages: false`），并额外用会话级「已交付正文」记忆做二次剥离（`createRepeatStripper`），确保同一段正文不会在下一轮再露一次脸。
5. **上下文对账：DSH 侧的压缩/改写如何同步到上游（v0.3.0）**：
   - 默认不发历史后，DSH 的压缩、编辑不会自动上去，上游会话丢失也无法自愈。`lib/context.js` 按消息指纹前缀比对，逐轮判定：
     追加 → `continue`（沿用上游上下文）；列表变短 / 前缀对不上 / 原样重发（重试）/ 轮数超 `conversationMaxRounds` → `resync`（换新会话 + 一次性补发 DSH 的历史）。
   - **工具结果轮永远 `continue`**：上游还挂着待办的工具调用，换会话会让它变成孤儿。
   - 只比对非 system 消息 —— DSH 的系统提示词每轮可能带动态内容（时间、目录等），算进来会让每轮都被判成「改写」而反复补发历史。

---

## 安装与接入 dsh web

### 1. 执行安装自检脚本
在插件目录下执行：
```powershell
cd C:\AITask\dsh-client-config\plugins\dsh-orchaterm-web-api
.\install.ps1
```
脚本会自动检查 Node.js 运行环境、探测 OrcaTerm 桌面端凭据有效性、启动本地反代验证 `/health` 与 `/v1/models`、并在 `~/.dsh/profiles/web/node_modules/` 建立软链接 (Junction)。

### 2. 启用插件并重启客户端
确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中包含 `dsh-orchaterm-web-api`。
退出并重新启动 DeepSeek Harness 客户端即可在模型选择器中看到 **OrcaTerm（反代）** 分组。

---

## 协议与工具系统适配 (v0.2.0 / v0.3.0)

1. **双向全双工工具调用系统**：
   - 逆向并打通了 OrcaTerm 的客户端 UI 工具系统（`uiServers: ['orcaterm']`）。当模型需要执行运维任务、命令或文件检索时，反代自动拦截上游 Agent 的 `action: "review"` 工具动作，智能映射为 DSH 本机工具（如 `execute_command` -> `pwsh` / `bash`，`remote_read` -> `read`，`remote_write` -> `write` 等），下发给 DSH 执行。
   - DSH 本机执行工具后，反代自动将工具输出重构为 `{TOOL_RESULT}(execute_command): <output>` 标签回传给上游，模型顺利读取真实机器数据并推进下一阶段。
   - **回传链的完整闭环（v0.3.0 关键修复）**：DSH 交给适配器的是 `role:'tool'` 消息（带 `toolCallId`）与 assistant 的 `{type:'tool-call'}` 内容块。此前 `lib/openai.js` 把它们分别当成「未知角色」和「非文本 block」丢掉，导致工具结果**根本发不到上游**，上游只能反复重发同一个工具调用。现在 `flattenContent()` 会翻成 OpenAI 的 `tool_calls` / `{role:'tool', tool_call_id, content}`。
   - **命令目标 shell 自适应（v0.3.0）**：上游按 Linux 主机写命令（`ls -la`），真实会话里模型偶尔写成 cmd 写法（`dir /b`、`2>nul`），而 Windows 上 DSH 只暴露 `pwsh`。反代按「PowerShell 特征 > cmd 特征 > POSIX 特征 > 默认 PowerShell」判定后改写：cmd → `cmd /c`、POSIX → 本机 Git Bash（`-lc`）、PowerShell → 原样。同时把本机真实环境写进提示词，让模型直接写对语法。判错 shell 时命令会以「路径不存在」这类形式静默走偏，所以**默认交给 PowerShell**是刻意的保守选择。
   - **混合语法逐段路由（v0.3.0）**：`cd x && dir /b && ls -la` 这种一条链里混了三种语法的命令，按顶层 `&&`/`||`/`;` 切段后**逐段**交给对应 shell，再用 PowerShell 7 的操作符串联。`cd` 段改写成 `Set-Location`（实测子 shell 会继承 PowerShell 的当前目录，后续各段自动落在同一目录）。路由结果写进工具 description，如 `[shell=composed:powershell+cmd+posix]`。
2. **多动作支持与问候语过滤**：
   - 完整支持上游的回答模式（`completion`）与提问反问模式（`ask`），反问选项自动格式化为 Markdown 列表。
   - 内置流式前缀剥离器，彻底消除上游无意义的初始问候语，纯寒暄轮次智能原样吐回。
   - 会话级重复正文剥离（v0.3.0）：同一段正文不会在下一轮再显示一次。
3. **思维链（Thinking）流式支持与可选档位（v0.6.1）**：
   - 深度思考过程以 `reasoning-delta` 实时流式呈现在 DSH 思考气泡中。
   - DSH 模型选择器会显示 OrcaTerm 客户端的思考档位，默认 `High`；选择会被透传为
     `reasoning_effort`，其中 `Off` 发 `none`（反代据此发 `enableThinking:false`）。
   - 档位表：`DeepSeek-V4.1-Flash` Off/Low/High/Max；`Hy4-preview` Off/High；
     `Hy3` Off/Low/High；`Kimi-K3` Low/High/Max；`GLM-5.3-Flash` Low/High/Max。
     后两个模型在客户端没有「思考模式」开关，因此不提供 Off。
4. **精选 5 大核心模型**：
   - `DeepSeek-V4.1-Flash`（默认，1M 上下文，支持图片）、`Hy4-preview`（1M 上下文）、`Hy3`（128K）、`Kimi-K3`（1M 上下文，支持图片）、`GLM-5.3-Flash`（申报 300K，支持图片）。
5. **模型 ID 兼容路由（证据边界）**：
   - 展示名直接发给 LightAI 会被拒（`LLM(...) is not loaded`），反代用 `backend/upstream.js` 的 `UPSTREAM_MODEL_MAP` 转到可加载的槽位。
   - 这些槽位与展示名的模型版本、能力是否严格等价，LightAI 未提供公开元数据，本插件也未做等价性验证；因此是**兼容路由**，输出质量可能与展示名有偏差。
   - `GLM-5.3-Flash` 的 300K 是按你提供值申报给 DSH 的 `contextWindow`，不是实测上限；实测中该路由能接受真实会话规模的负载，但 LightAI 不返回其精确 token 数或硬上限。
6. **客户端身份口径（v0.3.2）**：
   - `clientIdentity: 'desktop'`（默认）→ `Origin`/`Referer`/`X-Referer` = `http://tauri.localhost`，
     UA = 桌面端 WebView2 实测 UA（从 `%LOCALAPPDATA%\com.orcaterm-desktop.app\logs\orcaterm.log` 的 `userAgent=` 取）。
     依据：WebView2 History 里桌面端主页面就是 `http://tauri.localhost/`，而 OrcaTerm 代码写的是 `X-Referer: parent.location.href`。
   - `clientIdentity: 'web'` → `https://orcaterm.com` + `https://orcaterm.com/terminal`，即 v0.3.1 及之前的口径。
   - ⚠️ **实测：`/cgi/api` 与 `/assistant/chat` 都不校验这些头** —— 不带、乱填都返回 200 且 ai 帧数一致。
     所以这一项是「与真实客户端一致」，**不修任何故障**；改它的唯一实际意义是 UA ——
     上游将来若加客户端风控，`dsh-orchaterm-web-api/x.y.z` 这种一眼非浏览器的 UA 最容易被识别。
   - UA 里的 Chrome/Edge 版本随 WebView2 升级而变，是**本机当前值**，不是恒定常量。

---

## 官方语义移植（v0.4.0 / v0.5.0）

1. **工具结果官方协议（v0.4.0）**：DSH 执行完工具，反代按官方子 Agent 循环的信封回传
   `{type:'review', reviewAction:'reportToolResult', toolResult, tool}`（`tool` 为上游信封原件），
   对照实验证明模型精确消费结果（旧的 `{TOOL_RESULT}` 文本协议时吃时忽略）。
2. **流控制通道（v0.5.0/0.5.2）**：逆向 `orcaterm_start_core` 模块 2481 后移植 —— 会话 ID 放在路径段：
   `GET /stream/status/{cid}`、`GET /stream/resume/{cid}?offset=N`、`POST /stream/abort/{cid}`（空体）。
   **DSH 用户点停止时，反代在感知到客户端掐断且上游流未走完的情况下，自动补发
   `POST /stream/abort/{cid}`**（官方 stop = 本地断流 + 通知服务端，双动作）。
   **上游流异常中断（无终止符）时自动查 status，仍 running 就按 offset 续流**（v0.5.2，
   官方 Rt 语义，单次护栏；解包与滤镜原样延续，DSH 侧表现为同一条流）。管理端点：
   `POST /orca/stream-abort`、`GET /orca/stream-status?conversationId=`、
   `GET /orca/stream-resume?conversationId=&offset=`。
3. **回传重试官方参数（v0.5.0）**：工具结果轮 `attempts=3`、单次 15s 超时、退避 300→600→1200ms
   （`min(base·2ⁿ, max)`，模块 32804 公式 + @78376 实参）。
4. **工具结果脱敏（v0.5.0）**：官方客户端回传前必过 `Sn.fp` —— 14 条正则把 PEM 私钥、
   sk-/AKIA/ghp_/AIza/xox、JWT、URL 内嵌凭据、Bearer、敏感赋值、CLI 密码参数替换为
   `[已隐藏…]`/`***`（模块 35482 逐条移植为 `redactSecrets`）。上游看到的工具结果形态与官方一致。
5. **请求形态对齐（v0.5.0）**：`input.id` 与 `x-seqid` 同值；会话 ID 采用官方生成式
   `cid-<id>-orcaterm`（模块 72535：`cid-{id}-{assistant}`，mode 0=RE_ACT 不加后缀）；
   后端代执行结果帧（id 形如 `run-*-tool-*`）以带类别与脱敏摘要的可读行透出。
6. **UI 工具官方全集（证据）**：headless 15 项（官方免确认）+ foreground 8 项（需确认），
   见 `agent-protocol.js` 的 `UI_TOOL_HEADLESS`/`UI_TOOL_FOREGROUND` 与分类器
   `classifyUiToolCategory`；`selectedUITools` 仍只声明可映射到 DSH 工具的 7 项。
7. **未决 review 的用户反馈通道（v0.5.1）**：模型发过工具调用而 DSH 未回工具结果、用户直接
   打字改口时，反代按官方 `ut` 语义发 `{reviewAction:'feedback', input, tool}` 续进同一 review
   循环（而非误开新 `start`，让上游挂着的 review 悬空）。
8. **提问信封 → DSH 提问弹窗（v0.5.3）**：上游的 `{action:'ask',question,options}` 原本只被
   翻成「正文 + `**选项：**` 清单」，用户只能自由打字。现在当调用方声明了 `ask_user_question`
   时，反代**额外下发一个真的 `ask_user_question` 工具调用**（信封的 `options` → DSH 弹窗选项），
   于是 dsh web 用原生提问卡片接管；用户提交的答复按官方 `respondToAsk`（模块 2481 `at`）以
   `{type:'ask', input:<答复原文>}` 回传，上游据此继续。问题正文照常流式可见（不牺牲打字机）。

### 工具结果回传的两种官方形态（v0.5.3 补齐并实测）

桌面 bundle 里**两处**都叫 reportToolResult，但信封不同；v0.5.3 把两者都实现，用
`resultEnvelope` 选（默认 `review`），并逐轮可用请求体 `orca_result_envelope` 覆盖：

| 形态 | 信封 | 逆向出处 |
| --- | --- | --- |
| `review`（默认） | `{type:'review', reviewAction:'reportToolResult', toolResult, tool}` | 桌面端**唯一在消费**的回传路径：子 Agent 循环，`orcaterm_start.js`/`orcaterm_app.js`（各 4 处调用点） |
| `ask` | `{type:'ask', input:'{TOOL_RESULT}(<tool.name>): <result>'}` | 主循环模块 2481 导出的 `reportToolResult`（`st`）+ 标签常量 `TOOL_RESULT`（模块 68280）；入站正则在模块 73383 |

默认取 `review` 的依据：本插件 `clientIdentity='desktop'`，而桌面两个 bundle 里只有子 Agent 循环
在**消费**这种回传（模块 2481 那套在主包里没有调用点，属导出 API）。**两种形态都经真实流量
A/B 验证能被上游正确消费**（同样问句下都能从结果里读出 `orchaterm-tool-probe` 并给出正确结论），
所以这是「哪个更贴官方」的选择，不是「哪个能用」的选择。

### 工具结果轮的「受理超时」不是流超时（v0.5.5）

官方回传工具结果用 `SE(() => 回传(), {attempts:3, timeoutMs:15e3, baseDelayMs:300, maxDelayMs:1500})`。
关键在 `SE` 的实现（模块 32804）：它只是 `setTimeout` + `reject` 的 **promise 竞速**，用来
「停止等待」并重试，**从不 abort 请求**（错误文案是「回传工具结果 在 15000ms 内没有返回。」）。

v0.5.4 及之前把它实现成 `AbortSignal.timeout(15e3)` 挂在 `fetch` 上 —— 于是 15 秒变成了
**整个 SSE body 的硬墙**：工具结果轮里模型正在正常作答，到第 15 秒连接被掐断，DSH 侧报
`本轮运行失败 orchaterm-web-api 错误: The operation was aborted due to timeout`，内核再重试 2 次、
每次都同样失败，整轮报废（实报：`session-21bd31eb`、`session-8b10359d`）。

v0.5.5 按官方语义拆开两个阶段：

| 阶段 | 判据 | 可配 |
| --- | --- | --- |
| 上游**是否受理**（等响应头） | `reportRetryTimeoutMs`（默认 15000），超时则按 300→600→1200ms 退避重试 3 次 | ✅ 0 = 不设上限 |
| 正文**是否卡住**（已开始流） | `streamIdleTimeoutMs`（默认 180000）**空闲**判定 | ✅ |

同理，断流续传 `/stream/resume` 也不再套 60s 墙钟上限，改用同一套空闲判定 —— 续流本来就是为
长跑的 Agent 流准备的。两个 `signal` 现在用 `AbortSignal.any()` **合并**而不是互相覆盖
（原先同对象里写两个 `signal:` 键，后者会静默吃掉前者，DSH 的「停止」可能失效）。

---

### 适配器必须自己实现 LlmAdapter 的全部方法（v0.5.6）

本插件的适配器是**普通 JS 类**，不是 `LlmAdapter` 的子类 —— 插件按约定只在
`lib/kernel.js` 里惰性 import `@deepseek-ai/dsh-llm`（取归因头），不引宿主包，
因此**拿不到基类上的默认实现**。

而宿主 `LlmRuntime` 是**直接调用注册对象上的方法**的：

```ts
// packages/llm/llm/src/index.ts
imageRequestPricing(provider, model) {
  return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)   // 682
}
imageRequestTarget(provider, model, image) {
  return this.registration(provider).adapter.imageRequestTarget(provider, model, image)  // 693
}
```

缺方法不是「降级为 undefined」，而是 **TypeError**。实报（模型切换时）：

```
Cannot switch to orcaterm-web-api/hy4-preview: context compaction failed:
this.adapters.get(...)?.adapter.imageRequestPricing is not a function.
```

链路：模型切换 → `compactPressure` → token-meter `measure()` → `ctx.llm.imageRequestPricing()`
→ 适配器没这个方法 → TypeError → `MODEL_SWITCH_COMPACTION_FAILED`。

`registerAdapter()` 只校验 `providerInfo` / `providerRetryPolicy`，**不检查其余方法**，
所以缺方法能一路溜到运行时才炸。宿主会直接调用的方法共 7 个，插件必须全部实现：

| 方法 | 本插件的实现 |
| --- | --- |
| `providerInfo(provider)` | ✅ `{id, name}` |
| `providerRetryPolicy(provider)` | ✅ 路由级重试策略 |
| `listModels(provider)` | ✅ 后端 `/v1/models` + 静态目录兜底 |
| `resolveModel(provider, model, **signal**)` | ✅ 第三参是 **AbortSignal**（曾被误当配置对象用） |
| `prepareCall(provider, model, signal)` | ✅ |
| `imageRequestPricing(provider, model)` | ✅ 返回 `undefined`（本路由不按视觉 token 收费） |
| `imageRequestTarget(provider, model, image)` | ✅ 保留归一化后的原图（不缩放） |

`test/smoke.mjs` 第 5b 组与 `test/host_contract.spec.ts`（宿主侧端到端）守着这张表。

---

模型会把信封写成**非法 JSON**（实测：`thinking` 的值里带未转义的 `"`）。此时严格 `JSON.parse`
整包失败，旧代码会退化成「整包原文当正文」——用户看到一大段 ```json，信封里的工具调用丢失。
v0.5.4 用两层守卫兜住：

| 层 | 组件 | 作用 |
| --- | --- | --- |
| 解析 | `recoverToolEnvelope(raw)` | 严格 JSON 失败后按容错路径恢复 `tool`（容忍值里未转义的引号）；必须拿到 `name` 且有 `action`/`args` 证据才认，避免把散文误吞成工具调用 |
| 流式 | `createEnvelopeFenceGuard()` | 正文里出现 ````json{` 时把该块**挂起到围栏闭合**再判定；是信封就转工具调用，不是就原样放行（不丢字） |

两条都不「吞正文」：判不出来一律原样下发。守卫的代价是那一块的输出会被延迟到围栏闭合 ——
这是「要么延迟、要么漏拦截」的取舍，因为正文一旦流出就无法收回。

---

## AccessToken 自续期（v0.6.0）

### 为什么需要

AccessToken 是 **2 小时**有效期的 JWT。v0.5.x 只能「重读桌面端登录态」——
桌面端不开、或开了但一直没聚焦窗口，token 就没人续，反代随即报
`Invalid or expired AccessToken`，必须手动打开 OrcaTerm 触发一次刷新才能恢复。

v0.6.0 把续期搬进插件：**只要曾经登录过一次，之后不再需要 OrcaTerm 客户端常驻。**

### 逆向后拿到的官方接口

来源：OrcaTerm 1.6.6 前端 bundle `orcaterm_app.zh.*.js` 模块 24530 + Rust 侧
`[TokenManager]` 日志，双向印证：

| CGI action | 入参 | 用途 |
| --- | --- | --- |
| `OAuthExchangeToken` | `{sessionId}` | 浏览器 OAuth 回调后的首次换取（`orcaterm://oauth_callback?session_id=…`） |
| `OAuthRefreshToken` | `{accessToken}` | **续期**；入参就是当前这枚 AccessToken |

响应形如 `{Code:0, Message:"Success", AccessToken, ExpiresIn:7200}`，同时响应头
`X-OT-Token-Refreshed` 里也回一份同样的 JWT。官方前端的 `reconcile()`
在剩余寿命 `<= 5min` 时调它，Rust `TokenManager` 则是「110 分钟后续 + 每 5 分钟巡检」。

本机实测（2026-10-27）确认的边界：

- **过期 30 小时后调用仍成功** —— 续期不要求 token 未过期；
- 续期前后 JWT 的 `jti` / `providerCredentialKey` **完全一致**，只有 `iat`/`exp` 变
  → 不需要 `RefreshToken`，也不存在 refresh token 轮换；
- 链式续期成立（拿新 token 再换一次仍成功）；
- 旧 token 在新 token 签发后**仍然可用** → 插件续期不会把桌面端踢下线；
- 请求头只需常规 CGI 头（`X-SeqId` / `X-Referer` / `X-CsrfCode` + 身份口径），
  `Authorization` / `Cookie` / `uin` 查询串都不是硬要求（仍照常带，保持与真实客户端一致）。

### 机制

`backend/token-refresh.js`：

1. **到期前主动续**：剩余寿命 < `tokenRefreshLeadMs`（默认 10 分钟）时，先本地重读
   （桌面端若在跑通常已经替我们续过了，零网络），仍然临期才调 `OAuthRefreshToken`；
2. **后台巡检**：启动即查一次，之后每 `tokenRefreshCheckMs`（默认 5 分钟）检查一次
   —— 对齐桌面端 `Periodic check started (every 5 minutes)`；
3. **认证失败强制续**：非流式分支 `Invalid or expired AccessToken` 时强制续期后
   **重试一次**；流内认证错误（头已发出、本轮无法重试）也强制续期，让下一轮拿到新 token；
4. **滑动续期吸收**：任何已认证响应带 `X-OT-Token-Refreshed` 时，只在新 `exp` 更晚时吸收；
5. **落盘**：成功的 token 写入 `~/.dsh/orca-token-cache.json`（`{accessToken, expiresAt, refreshedAt}`，
   POSIX `0600`，临时文件 + rename 原子写，**只取更晚 exp**）。反代进程重启后直接接着用；
6. **单飞 + 冷却**：并发回合只发一次续期请求；失败后 30 秒内自动路径不再重试。

换新时同时同步 `token`、`assistantBearer` 和 jar/cookieHeader 里的 `ot_session`
—— 只换 Bearer 不换 cookie，CGI 的 cookie 鉴权仍会拿旧值。

### 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `tokenRefresh` | `'auto'` | `'off'` 退回 v0.5.x 的「只重读桌面端登录态」 |
| `tokenCache` | `''`（`~/.dsh/orca-token-cache.json`） | 续期结果缓存位置 |
| `tokenRefreshLeadMs` | `600000`（10 分钟） | 提前多久续期 |
| `tokenRefreshCheckMs` | `300000`（5 分钟） | 后台巡检间隔 |

环境变量同名口径：`ORCA_TOKEN_REFRESH` / `DSH_ORCA_TOKEN_CACHE` /
`ORCA_TOKEN_REFRESH_LEAD_MS` / `ORCA_TOKEN_REFRESH_CHECK_MS`；CLI：
`--token-refresh` / `--token-cache` / `--token-refresh-lead-ms` / `--token-refresh-check-ms`。

### 怎么确认它在工作

```powershell
Invoke-RestMethod http://127.0.0.1:8793/health | ConvertTo-Json -Depth 6
```

`tokenRefresh` 字段只报时间与状态码（不含 token）：

```jsonc
{
  "enabled": true,
  "expiresAt": "2026-10-28T01:28:52.000Z",
  "remainingSec": 7043,
  "leadSec": 600,
  "checkSec": 300,
  "cachePath": "C:\\Users\\<user>\\.dsh\\orca-token-cache.json",
  "cacheExpiresAt": "2026-10-28T01:28:52.000Z",
  "attempts": 1,
  "lastRefreshedAt": "2026-10-27T15:28:52.000Z",
  "last": { "ok": true, "code": "OK", "message": "", "reason": "expiring", "at": "..." }
}
```

### 边界（如实记录）

- **需要一次初始登录**：从来没有登录过 OrcaTerm（`data.bin` / `.cookies` / `credentialsFile`
  里都没有 token）时仍然无法凭空造一枚，此时 `/health.tokenRefresh.last.code` 是 `NO_TOKEN`，
  提示登录一次；登录后即可长期自续。
- 助手通道实测**只认 Bearer**（不带 cookie、不带 `uin` 查询串也返回 200 并出字），
  所以 `sid` 这类会话 cookie 过期不会挡住长期自续；插件仍照常带 cookie，保持与客户端一致。
- 缓存文件里是**一枚 bearer token**（等价于账号凭据），已按 0600 落盘；不要把该文件提交/共享。
- 续期建立在「`providerCredentialKey` 在服务端仍有效」之上。若账号被登出/吊销，
  续期会返回 `Error`（`last.code` 可见），此时需要重新登录一次。
- 这些都是对**当前**上游行为的观测，不构成对未来的保证；上游若换动作名/加签名，
  先按本文方法复测，不要沿用结论。
- 不写回桌面端的 `data.bin`：桌面端的 Tauri Store 有自己的写入时机，跨进程改它的文件
  容易打架；插件用自己的缓存并与之**按 exp 取最晚**，两套并存互不干扰。

---

## 验证

```powershell
npm test                       # 离线：cordis/DEFAULTS 静态校验 + smoke + 12 组续期回归 + 3 组零输出救援 + 3 组畸形信封 + 2 组受理超时
npm run test:live:regression   # 活体：需反代在跑 + 有效登录态，17 项断言，会让模型真发工具调用
npm run test:malformed         # 只跑畸形信封回归（假上游驱动，不需要登录态）
npm run test:token-refresh     # 只跑 AccessToken 自续期（假上游，不需要登录态）
# 凭据说明（v0.6.0）：临期/过期时反代先重读桌面端登录态，仍临期就调官方 OAuthRefreshToken 自续期，
# 结果落到 ~/.dsh/orca-token-cache.json；认证失败还会强制续期并重试一次。
# 因此不必一直开着 OrcaTerm —— 只有「从未登录过 / 登录态被吊销」才需要重新登录一次。
# 宿主侧契约回归（v0.5.6）：两份 spec 都需要在宿主仓库根目录跑 ——
#   cd C:\AITask\deepseek-harness
#   Copy-Item <插件>\test\host_contract.spec.ts packages\compaction\compaction-basic\tests\
#   npx vitest run packages/compaction/compaction-basic/tests/host_contract.spec.ts
#   （host_live_switch.spec.ts 同理；它会真打上游，需要反代在跑 + 有效登录态）
```

`host_contract.spec.ts` 是**跨仓库**的哨兵：它用真实 `LlmRuntime` + `TokenMeter` +
`BasicCompactionEngine` 加载**插件的真实适配器**，复刻实报的「模型切换 → 上下文压缩 →
图片计价解析」失败链。宿主升级导致契约漂移时，插件自己的离线测试未必能发现
（它只断言方法存在，不走宿主调用链），这份能。

`host_live_switch.spec.ts` 更进一步：宿主的摘要是用**上一个模型**做的，所以上个模型是
orcaterm 路由时，摘要请求会原样经过插件适配器打到**真实 OrcaTerm 上游** ——
契约缺陷若还在，这一步就会崩；摘要与对话无关的缺陷也会在这里暴露
（断言「摘要正文含待压缩对话的内容」+「上游只被调用一次」）。

`compaction_summary.mjs` 是**假上游驱动**的确定性回归（不需要登录态）：它按
OrcaTerm 的 SSE 方言回话，同时**记录上游到底收到了什么**，断言压缩轮确实带了
`historyMessages`、且里面是待压缩对话的内容。

### 走完整宿主栈的真实验证（one-shot CLI）

宿主的一次性 CLI 能把 **llm runtime + token-meter + compaction** 全链路真实跑一遍：

```powershell
# 一个 headless + orcaterm 插件的 profile（本机已建好 C:\Users\Admin\.dsh\profiles\orca-oneshot）
cd C:\AITask\deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts --profile orca-oneshot "<任务>"
# 任务文本可经 stdin 喂（避免命令行长度上限）：
Get-Content task.txt -Raw | node --import tsx/esm apps/cli/src/bin.ts --profile orca-oneshot
# 切模型用 --patch 覆盖（覆盖 agent-default-model）：
node --import tsx/esm apps/cli/src/bin.ts --profile orca-oneshot --patch switch.yml --session-id <id> "<任务>"
```

要点：**压缩配置沿用宿主默认**，触发靠**历史长度**（把历史堆过目标模型的阈值），
不要为了「触发」去调低 `thresholdRatio` —— 阈值一旦低于「保留尾巴」的体积，宿主就会
进入「降不到阈值 → 重试 → 压刚写的检查点」的路径，报的错与真实场景不同
（详见 WORK_SUMMARY §24.8）。

### 压缩摘要轮的特殊处理（v0.5.7）

宿主的上下文压缩把摘要作为**辅助 LLM 调用**（`purpose: 'compaction'`）发出，消息体是
「待压缩的那段对话 + 一条压缩指令」。**待压缩的对话本身就是输入** —— 若上游只收到那条
指令，产出的摘要与对话完全无关（实测 161 字的元话，零事实），宿主拿它与被压缩内容
比大小就会判失败，模型切换因此以 `MODEL_SWITCH_COMPACTION_FAILED` 收尾。

所以压缩轮与普通轮不同：

| | 普通轮 | 压缩摘要轮 |
| --- | --- | --- |
| 上游会话 | 按上下文对账决定（fresh/continue/resync） | **每次新会话**（官方形态 `cid-{uuid}-{assistant}`，真随机） |
| 补发历史 | 按对账结果（默认不补发） | **总是补发** |
| 请求体标记 | 无 | `orca_purpose: 'compaction'` + `orca_send_history: true` |
| 后端路径 | 视消息形态（start / review / feedback） | 强制 **start**（review 与 feedback 两种形态都不带 `historyMessages`） |

普通轮的行为完全没变。

`live_regression.mjs` 覆盖五段：回放剥离 → 工具信封 → 工具结果被接受 → **provider 契约（DSH 原生 `tool-call`/`tool` 消息）** → **上下文对账（fresh/continue/resync）**；
结束时会把本轮下发的真实命令打印出来，便于在本机直接执行确认「确实跑了」。
想连「重发历史」这条危险路径一起测，就对 `--send-history` 起的实例跑（例如 8794 端口）。

`malformed_envelope.mjs` 是**假上游驱动**的确定性回归（不需要登录态、不碰真 OrcaTerm）：它按 OrcaTerm 的
SSE 方言把一份线上实测的**非法 JSON 信封**分片投递，断言反代仍能恢复出工具调用、且原始 JSON 绝不落进正文。
覆盖两类畸形：模型写出非法 JSON（`thinking` 值里带未转义的 `"`），以及信封被切成多帧到达。

---

## 为什么不需要再拉一个本地 SSH 服务（v0.3.0 评估结论）

OrcaTerm 的原生设计确实是「桌面端连接主机 → 云端 Agent 下发命令 → 客户端在主机上执行」。但那套机制要解决的问题，本插件用另一条路已经解决了：

1. **命令本来就在本机真实执行**。`session-fc7c2c2f` 里有 8 次 `tool/call`，对应 8 次 `job/registered` + 8 次 `job/settled` —— 执行链是通的。
2. **当时真正卡住的是两件事，都不是执行通道**：① **工具结果根本没送回上游** —— DSH 的 `role:'tool'` 消息在 `lib/openai.js` 里被判成「未知角色」丢弃，上游收不到结果，只能按同样参数反复重发同一个工具调用；② **命令写给了错的 shell** —— `dir /b` 被 PowerShell 解析成路径 `C:\b`，输出全是错误信息。v0.3.0 的「回传链闭环 + 环境自述 + shell 自适应/逐段路由」解决的正是这两层。
3. **走 DSH 工具比自建 SSH 更安全**：命令是通过 DSH 自己的 `pwsh` 工具执行的，因此**仍然受 DSH 的审批与沙箱策略约束**；而「本地 SSH 服务 + 桌面端执行」会让命令绕开 DSH 这层管控，直接以登录用户权限运行。
4. 若将来确实需要真正的 POSIX 环境（例如上游坚持 Linux 语义而本机 Git Bash 不够用），更小的改动是让 DSH 暴露 `bash` 工具——`resolveDshToolCall` 已经优先走 `bash`，不需要引入 SSH。

> 本机已具备的条件（实测）：`C:\Program Files\Git\bin\bash.exe` 与 `wsl.exe` 均可用，故 POSIX 命令能跑；系统未安装 OpenSSH Server（`sshd` 服务不存在），自建 SSH 还需要额外开启系统可选功能。


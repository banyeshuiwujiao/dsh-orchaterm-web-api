import assert from 'node:assert/strict'
import { OrcaTermWebApiAdapter, PROVIDER_ID, name, inject, apply } from '../lib/provider.js'
import { classifyDataLine, cgiHeaders, assistantHeaders, assistantBody, identityOf, DESKTOP_IDENTITY, streamControlUrl } from '../backend/upstream.js'
import { csrfCodeOf } from '../backend/credentials.js'
import { buildConfig, ensureFreshCredential, toAssistantInput } from '../backend/server.js'
import { createContextTracker, fingerprintMessages } from '../lib/context.js'
import { DEFAULTS, MANAGER_KEYS } from '../lib/config.js'
import { flattenContent, formatOpenAiMessages } from '../lib/openai.js'
import {
  askEnvelopeToQuestionTool,
  askResultToAnswerText,
  ASK_TOOL_NAME,
  classifyCommandShell,
  classifyUiToolCategory,
  createDeliveredHistory,
  createGreetingStripper,
  createRepeatStripper,
  createThinkingTagRouter,
  describeExecutionHost,
  parseToolEnvelope,
  redactSecrets,
  REPORT_RETRY_TIMEOUT_MS,
  reportRetryBackoffMs,
  resolveDshToolCall,
  rewriteCommandChain,
  splitCommandChain,
  toDshOption,
  toWindowsPath,
  UI_TOOL_FOREGROUND,
  UI_TOOL_HEADLESS,
  wrapCommandForShell,
  wrapToolResultInput,
} from '../backend/agent-protocol.js'

console.log('1. 验证插件基本导出与元数据...')
assert.equal(name, 'dsh-orchaterm-web-api-provider')
assert.deepEqual(inject, ['llm'])
assert.equal(typeof apply, 'function')

console.log('2. 验证 CSRF 算法一致性 (djb2)...')
assert.equal(csrfCodeOf(''), '')
// 测试固定字符串哈希验证算法正常运行
const code = csrfCodeOf('test_skey_12345')
assert.match(code, /^\d+$/)

console.log('3. 验证 SSE 数据行解析分类器 (classifyDataLine)...')
assert.deepEqual(classifyDataLine(''), { kind: 'noop' })
assert.deepEqual(classifyDataLine('data: [DONE]'), { kind: 'done' })
assert.deepEqual(classifyDataLine('data: [ABORTED]'), { kind: 'aborted' })
assert.deepEqual(classifyDataLine('data: [ERROR]: test error'), { kind: 'error', message: 'test error' })
const jsonItem = classifyDataLine('data: {"id":"123","content":"hello"}')
assert.equal(jsonItem.kind, 'data')
assert.equal(jsonItem.item.content, 'hello')

console.log('4. 验证 Provider 适配器生命周期与插件注册...')
let registeredRoute = null
let registeredAdapter = null
let registeredConfigurable = null

const fakeCtx = {
  llm: {
    registerAdapter(routes, adapter) {
      registeredRoute = routes[0]
      registeredAdapter = adapter
      return () => { registeredRoute = null }
    },
    registerConfigurableProviders(list) {
      registeredConfigurable = list
    }
  },
  on(event, handler) {}
}

const adapterInstance = apply(fakeCtx, { baseUrl: 'http://127.0.0.1:8793' })
assert.equal(registeredRoute, PROVIDER_ID)
assert.equal(registeredConfigurable[0].provider, PROVIDER_ID)
assert.ok(adapterInstance instanceof OrcaTermWebApiAdapter)

console.log('5. 验证模型解析 (resolveModel)...')
const resolved = await adapterInstance.resolveModel(PROVIDER_ID, 'deepseek-v4.1-flash')
assert.equal(resolved.id, 'deepseek-v4.1-flash')
assert.equal(resolved.provider, PROVIDER_ID)
assert.ok(resolved.context.contextWindow > 0)
assert.ok(resolved.defaultMaxTokens > 0)

console.log('5b. 验证宿主适配器契约面完整（实报：imageRequestPricing is not a function）...')
{
  // 宿主 LlmRuntime 直接调用注册对象上的这些方法（packages/llm/llm/src/index.ts）。
  // 插件的适配器是普通 JS 类（拿不到 LlmAdapter 基类），基类默认实现全部缺失，
  // 缺一个就会在压缩/模型切换时炸掉 —— 这里逐个对齐宿主实际会调的方法。
  const REQUIRED = [
    'providerInfo',
    'providerRetryPolicy',
    'imageRequestPricing',
    'imageRequestTarget',
    'listModels',
    'resolveModel',
    'prepareCall',
  ]
  for (const method of REQUIRED) {
    assert.equal(
      typeof adapterInstance[method],
      'function',
      `适配器缺少宿主必需方法 ${method}()`,
    )
  }

  // imageRequestPricing：本路由不按视觉 token 收费 → 声明「无计价器」是基类默认语义。
  assert.equal(adapterInstance.imageRequestPricing(PROVIDER_ID, 'deepseek-v4.1-flash'), undefined)

  // imageRequestTarget：不缩放图片，保留归一化后的原图（与基类默认实现一致）。
  const imageRef = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 2048, width: 640, height: 480 }
  assert.deepEqual(
    adapterInstance.imageRequestTarget(PROVIDER_ID, 'deepseek-v4.1-flash', imageRef),
    { width: 640, height: 480, maxBytes: 2048 },
  )

  // resolveModel 的第三参是 AbortSignal，不是配置对象（实修的签名错配）。
  // 宿主传 signal 时，目录里申报的上下文窗口必须照常生效，而不是退到兜底值。
  const viaSignal = await adapterInstance.resolveModel(PROVIDER_ID, 'hy4-preview', new AbortController().signal)
  assert.equal(viaSignal.context.contextWindow, 1048576, 'hy4-preview 应申报 1M 上下文')
  const viaModel = await adapterInstance.resolveModel(PROVIDER_ID, 'glm-5.3-flash', new AbortController().signal)
  assert.equal(viaModel.context.contextWindow, 300000, 'glm-5.3-flash 应申报 300K 上下文')

  // 已取消的 signal 应立刻放弃，而不是继续解析。
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    () => adapterInstance.resolveModel(PROVIDER_ID, 'hy4-preview', aborted.signal),
    /aborted/,
  )
}

console.log('5c. 验证思考档位申报（宿主选择器只认 resolveModel.reasoning）...')
{
  const effortsOf = async (model) => {
    const info = await adapterInstance.resolveModel(PROVIDER_ID, model)
    return info.reasoning === undefined ? undefined : info.reasoning.efforts.map((effort) => effort.id)
  }

  // 有「思考模式」开关的模型：Off + 各自档位，默认 High。
  assert.deepEqual(await effortsOf('deepseek-v4.1-flash'), ['off', 'low', 'high', 'max'])
  assert.deepEqual(await effortsOf('hy4-preview'), ['off', 'high'])
  assert.deepEqual(await effortsOf('hy3'), ['off', 'low', 'high'])

  // 客户端没有开关的模型：只能选档位，不给 Off。
  assert.deepEqual(await effortsOf('kimi-k3'), ['low', 'high', 'max'])
  assert.deepEqual(await effortsOf('glm-5.3-flash'), ['low', 'high', 'max'])

  const ds = await adapterInstance.resolveModel(PROVIDER_ID, 'deepseek-v4.1-flash')
  assert.equal(ds.reasoning.defaultEffort, 'high')
  const hy4 = await adapterInstance.resolveModel(PROVIDER_ID, 'hy4-preview')
  assert.equal(hy4.reasoning.defaultEffort, 'high')

  // 目录没收录的 BYO 模型不申报，避免给出上游不认的档位。
  const byo = await adapterInstance.resolveModel(PROVIDER_ID, 'byo-custom-model')
  assert.equal(byo.reasoning, undefined)
}

console.log('5d. 验证 reasoning_effort 透传（Off → none）...')
{
  const originalFetch = globalThis.fetch
  let sent = null
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body)
    const chunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
    }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const opts = { ...DEFAULTS, baseUrl: 'http://127.0.0.1:8793' }
  const fakeManager = { ensure: async () => ({ status: 'ok' }), dispose() {} }
  const drain = async (reasoningEffort) => {
    sent = null
    const options = {
      messages: [{ role: 'user', content: 'hi' }],
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
    // 每次用新适配器，避免上下文对账把「同样的问题重发」当成重试而打日志。
    const adapter = new OrcaTermWebApiAdapter({}, null, null)
    for await (const _chunk of adapter.stream('deepseek-v4.1-flash', options, opts, fakeManager)) {
      // 只关心请求体
    }
    return sent
  }
  try {
    assert.equal((await drain('max')).reasoning_effort, 'max')
    assert.equal((await drain('low')).reasoning_effort, 'low')
    assert.equal((await drain('off')).reasoning_effort, 'none')
    assert.equal(Object.hasOwn(await drain(undefined), 'reasoning_effort'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('6. 验证问候语剥离 (createGreetingStripper)...')
{
  // 分片模拟打字机流：问候语被吃掉，正文放行
  {
    const s = createGreetingStripper()
    const pieces = ['你好', '，我是 Orca', 'Term AI，腾讯云 OrcaTerm（遨驰终端）内置的', '云端服务器运维专家。请告诉我你需要什么帮助？', '帮我查 git log']
    const out = pieces.map((p) => s.feed(p)).filter(Boolean).join('')
    assert.equal(out, '帮我查 git log')
  }
  // 整条纯问候语 → 输出为空，但 stripped() 留底供「寒暄回合」归还
  {
    const s = createGreetingStripper()
    assert.equal(s.feed('你好，我是 OrcaTerm AI，腾讯云 OrcaTerm（遨驰终端）内置的云端服务器运维专家。请告诉我你需要什么帮助？'), '')
    assert.equal(s.stripped().startsWith('你好，我是 OrcaTerm AI'), true)
    assert.equal(s.clearStripped().length > 0, true)
    assert.equal(s.clearStripped(), '')
  }
  // 非问候语正文直接放行
  {
    const s = createGreetingStripper()
    assert.equal(s.feed('正常回答内容'), '正常回答内容')
  }
  // 问候语变体缺结束标记时不吞正文（超长兜底放行）
  {
    const s = createGreetingStripper({ maxHold: 40 })
    const out = s.feed('你好，我是 OrcaTerm AI' + '啊'.repeat(60) + '真正的正文')
    assert.ok(out.includes('真正的正文'), '超长兜底必须把内容放出来')
  }
}

console.log('7. 验证重复正文剥离 (createRepeatStripper)...')
{
  const prior = '我将帮您完成以下操作：\n\n1. 检查当前状态\n2. 清理临时文件\n\n请问是否按这个思路开始执行？'
  // 7a. 上一轮正文被原样重放 → 吃掉，只留新内容
  {
    const s = createRepeatStripper([prior])
    assert.equal(s.feed(`${prior}\n\n好的，开始执行。`), '好的，开始执行。')
    assert.ok(s.droppedChars() > 0)
  }
  // 7b. 同一段被重放两次 → 两份都吃掉
  {
    const s = createRepeatStripper([prior])
    assert.equal(s.feed(`${prior}${prior}\n\n新内容`), '新内容')
  }
  // 7c. 完全无关的新正文 → 立刻放行，不受剥离器影响
  {
    const s = createRepeatStripper([prior])
    assert.equal(s.feed('这是一段全新的回答'), '这是一段全新的回答')
  }
  // 7d. 无历史可比 → 直通
  {
    const s = createRepeatStripper([])
    assert.equal(s.feed('任意内容'), '任意内容')
  }
  // 7e. 逐字符分片到达也要能剥离（打字机流）
  {
    const s = createRepeatStripper([prior])
    const stream = `${prior}\n\n结论如下`
    let out = ''
    for (const ch of stream) out += s.feed(ch)
    assert.equal(out, '结论如下')
  }
  // 7f. 只是与历史正文「开头相似」但并非重放 → 最终必须放行，不能被吞掉
  {
    const s = createRepeatStripper([prior])
    const fresh = '我将帮您完成以下操作，但这次是另一件事'
    let out = ''
    for (const ch of fresh) out += s.feed(ch)
    out += s.flush()
    assert.equal(out, fresh)
  }
}

console.log('8. 验证会话级已交付正文记忆 (createDeliveredHistory)...')
{
  const store = createDeliveredHistory({ maxRounds: 2, maxChars: 5000 })
  store.remember('cid-x', '第一轮的正文内容（足够长以通过最短长度门槛）')
  store.remember('cid-x', '第二轮的正文内容（足够长以通过最短长度门槛）')
  store.remember('cid-y', '另一个会话的正文内容（互不串台）')
  assert.deepEqual(store.textsFor('cid-x'), [
    '第二轮的正文内容（足够长以通过最短长度门槛）',
    '第一轮的正文内容（足够长以通过最短长度门槛）',
  ])
  assert.deepEqual(store.textsFor('cid-y'), ['另一个会话的正文内容（互不串台）'])
  // 太短的不记（噪音大、误伤高）
  store.remember('cid-z', '短')
  assert.deepEqual(store.textsFor('cid-z'), [])
}

console.log('9. 验证命令目标 shell 判定 (classifyCommandShell)...')
{
  // 真实会话里出现过、且被 PowerShell 曲解的那条
  assert.equal(classifyCommandShell('cd C:\\AITask && echo === 目录结构 === && dir /b && echo. && echo === Git 状态 === && git status --short 2>nul'), 'cmd')
  assert.equal(classifyCommandShell('git status --short 2>nul'), 'cmd')
  assert.equal(classifyCommandShell('findstr /i error log.txt'), 'cmd')
  assert.equal(classifyCommandShell('echo %USERPROFILE%'), 'cmd')
  // 上游按 Linux 主机写出来的
  assert.equal(classifyCommandShell("ls -la && echo '---' && git rev-parse --is-inside-work-tree 2>&1"), 'posix')
  assert.equal(classifyCommandShell('sudo systemctl restart nginx'), 'posix')
  assert.equal(classifyCommandShell('awk -F, \'{print $1}\' data.csv'), 'posix')
  assert.equal(classifyCommandShell('echo -e "a\\nb"'), 'posix')
  // PowerShell 自身
  assert.equal(classifyCommandShell('Get-ChildItem -Recurse -Filter *.js'), 'powershell')
  assert.equal(classifyCommandShell('$env:PATH -split ";"'), 'powershell')
  assert.equal(classifyCommandShell('Remove-Item -Force build'), 'powershell')
  // 无把握的一律交给 PowerShell（与 DSH 系统提示词一致）
  assert.equal(classifyCommandShell('git log --oneline -5'), 'powershell')
  assert.equal(classifyCommandShell(''), 'powershell')
}

console.log('10. 验证命令改写 (wrapCommandForShell)...')
{
  const cmdWrapped = wrapCommandForShell("dir /b && echo 'ok'", 'cmd', { comspec: 'C:\\Windows\\system32\\cmd.exe' })
  assert.equal(cmdWrapped.wrapped, true)
  assert.equal(cmdWrapped.shell, 'cmd')
  assert.equal(cmdWrapped.command, "& 'C:\\Windows\\system32\\cmd.exe' /c 'dir /b && echo ''ok'''")

  const posixWrapped = wrapCommandForShell('ls -la', 'posix', { posixShell: 'C:\\Program Files\\Git\\bin\\bash.exe' })
  assert.equal(posixWrapped.wrapped, true)
  assert.equal(posixWrapped.command, "& 'C:\\Program Files\\Git\\bin\\bash.exe' -lc 'ls -la'")

  // 本机没有 POSIX shell 时，只能退回 PowerShell 尽力而为（不谎报成功）
  const posixUnavailable = wrapCommandForShell('ls -la', 'posix', { posixShell: '' })
  assert.equal(posixUnavailable.wrapped, false)
  assert.equal(posixUnavailable.command, 'ls -la')

  // PowerShell 命令原样放行
  const ps = wrapCommandForShell('Get-Date', 'powershell', {})
  assert.equal(ps.wrapped, false)
  assert.equal(ps.command, 'Get-Date')
}

console.log('11. 验证工具调用解析 (resolveDshToolCall / parseToolEnvelope)...')
{
  // 上游真实下发过的信封（实测样本，含 ph_1 这类网关附加字段）
  const envelope = parseToolEnvelope('```json\n' + JSON.stringify({
    action: 'review',
    ph_1: '--',
    tool: { type: 'mcp', mcpServer: 'mcp-server-orcaterm-oauth', name: 'execute_command', args: { command: 'ls -la' } },
  }) + '\n```')
  assert.ok(envelope, '工具信封应被识别')
  assert.equal(envelope.tool.name, 'execute_command')
  // 普通 fenced JSON 不是工具信封
  assert.equal(parseToolEnvelope('```json\n{"action":"completion","taskCompletion":"hi"}\n```'), null)
  assert.equal(parseToolEnvelope('普通文本'), null)

  const pwshTools = [{ type: 'function', function: { name: 'pwsh' } }, { type: 'function', function: { name: 'read' } }]
  const cmdCall = resolveDshToolCall({ name: 'execute_command', args: { command: 'dir /b' } }, pwshTools, { posixShell: '', comspec: 'cmd.exe' })
  assert.equal(cmdCall.name, 'pwsh')
  assert.equal(cmdCall.shell, 'cmd')
  assert.equal(cmdCall.arguments.command, "& 'cmd.exe' /c 'dir /b'")
  assert.equal(cmdCall.mappedFrom, 'execute_command')

  const readCall = resolveDshToolCall({ name: 'remote_read', args: { path: 'a.txt' } }, pwshTools)
  assert.equal(readCall.name, 'read')
  assert.equal(readCall.arguments.file_path, 'a.txt')

  // Linux 上的 DSH 有 bash：命令不再绕 PowerShell
  const bashCall = resolveDshToolCall({ name: 'execute_command', args: { command: 'ls -la' } }, [{ type: 'function', function: { name: 'bash' } }])
  assert.equal(bashCall.name, 'bash')
  assert.equal(bashCall.arguments.command, 'ls -la')
}

console.log('12. 验证执行环境自述 (describeExecutionHost)...')
{
  const win = describeExecutionHost({ platform: 'win32', cwd: 'C:\\AITask', posixShell: 'bash.exe' })
  assert.ok(/Windows/.test(win))
  assert.ok(/PowerShell/.test(win))
  assert.ok(/Git Bash/.test(win))
  assert.ok(/C:\\AITask/.test(win))
  const linux = describeExecutionHost({ platform: 'linux', cwd: '/srv/app', posixShell: '' })
  assert.ok(/linux/.test(linux))
  assert.ok(/POSIX/.test(linux))
}

console.log('13. 验证 DSH 消息 → OpenAI 消息（工具结果必须活下来）...')
{
  // 13a. assistant 的 tool-call 块 → OpenAI tool_calls；reasoning 块静默丢弃
  const flat = flattenContent([
    { type: 'reasoning', text: '想一下' },
    { type: 'text', text: '好的' },
    { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"dir /b"}' },
  ])
  assert.equal(flat.text, '好的')
  assert.deepEqual(flat.dropped, [])
  assert.deepEqual(flat.toolCalls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'pwsh', arguments: '{"command":"dir /b"}' },
  }])
  // 缺 id/name 的 tool-call 块算丢弃，不静默造一个假调用
  assert.deepEqual(flattenContent([{ type: 'tool-call', name: 'x' }]).dropped, ['tool-call'])
  assert.deepEqual(flattenContent([{ type: 'image', attachment: {} }]).dropped, ['image'])

  const warn = []
  const wire = formatOpenAiMessages({
    system: 'SYS',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '列出文件' }] },
      // 纯工具调用的 assistant 消息没有文本，绝不能因此被整条丢掉
      { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"dir /b"}' }] },
      { role: 'tool', toolCallId: 'call_1', source: { kind: 'tool', callId: 'call_1' }, isError: false, content: [{ type: 'text', text: '目录清单' }] },
    ],
  }, (m) => warn.push(m))

  assert.deepEqual(wire.map((m) => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.deepEqual(wire[0], { role: 'system', content: 'SYS' })
  assert.equal(wire[2].tool_calls[0].id, 'call_1')
  assert.equal(wire[3].tool_call_id, 'call_1')
  assert.equal(wire[3].content, '目录清单')
  assert.deepEqual(warn, [], '工具调用/工具结果都不该产生丢弃告警')
}

console.log('14. 验证混合语法命令链的切分与逐段路由...')
{
  // 14a. 引号内的操作符不切；管道不切
  const s1 = splitCommandChain('echo "a && b" && dir /b | findstr x')
  assert.deepEqual(s1.segments, ['echo "a && b" ', ' dir /b | findstr x'])
  assert.deepEqual(s1.operators, ['&&'])
  const s2 = splitCommandChain('a; b || c')
  assert.deepEqual(s2.operators, [';', '||'])
  assert.deepEqual(s2.segments, ['a', ' b ', ' c'])

  // 14b. MSYS 盘符路径可翻译；Git Bash 虚拟路径不猜
  assert.equal(toWindowsPath('/c/AITask'), 'C:\\AITask')
  assert.equal(toWindowsPath('/d'), 'D:\\')
  assert.equal(toWindowsPath('C:\\AITask'), 'C:\\AITask')
  assert.equal(toWindowsPath('..\\x'), '..\\x')
  assert.equal(toWindowsPath('/tmp'), null)

  const env = { posixShell: 'C:\\Program Files\\Git\\bin\\bash.exe', comspec: 'C:\\Windows\\system32\\cmd.exe' }

  // 14c. 单一 shell 走旧路径（行为不变）
  assert.equal(rewriteCommandChain('dir /b', env).strategy, 'single')
  assert.equal(rewriteCommandChain('Get-ChildItem', env).strategy, 'single')
  assert.equal(rewriteCommandChain('ls -la', env).strategy, 'single')

  // 14d. 混合语法逐段路由，cd 交给 PowerShell 让子 shell 继承目录
  const mixed = rewriteCommandChain('cd C:\\AITask && dir /b && ls -la', env)
  assert.equal(mixed.strategy, 'composed')
  assert.equal(
    mixed.command,
    "Set-Location 'C:\\AITask' && & 'C:\\Windows\\system32\\cmd.exe' /c 'dir /b' && & 'C:\\Program Files\\Git\\bin\\bash.exe' -lc 'ls -la'",
  )
  // POSIX 盘符路径同样能翻译
  assert.equal(rewriteCommandChain('cd /c/AITask && dir /b && ls -la', env).strategy, 'composed')

  // 14e. cd 目标无法翻译 → 退回单 shell，且优先退到能解释这条命令的 posix
  const fallback = rewriteCommandChain('cd /tmp && dir /b', env)
  assert.equal(fallback.strategy, 'fallback')
  assert.ok(fallback.command.includes('bash.exe'), '退路应落在 bash，至少让 cd 是对的')
  // 本机没有 POSIX shell 时不能假装成功
  const noPosix = rewriteCommandChain('cd /tmp && dir /b', { posixShell: '', comspec: 'cmd.exe' })
  assert.equal(noPosix.strategy, 'fallback')

  // 14f. 混合链里的空段不猜；单一 shell 的畸形命令原样透出，让 shell 自己报语法错
  assert.equal(rewriteCommandChain('dir /b && && ls -la', env).strategy, 'fallback')
  assert.equal(rewriteCommandChain('a && && b', env).command, 'a && && b')
  assert.equal(rewriteCommandChain('', env).strategy, 'empty')

  // 14g. resolveDshToolCall 把路由结果写进 description，便于排查
  const call = resolveDshToolCall(
    { name: 'execute_command', args: { command: 'cd C:\\AITask && dir /b && ls -la' }, description: '看看目录' },
    [{ type: 'function', function: { name: 'pwsh' } }],
    env,
  )
  assert.equal(call.name, 'pwsh')
  assert.equal(call.strategy, 'composed')
  assert.ok(call.arguments.description.startsWith('看看目录'), call.arguments.description)
  assert.ok(call.arguments.description.includes('shell=composed:'), call.arguments.description)
}

console.log('15. 验证上下文对账 (createContextTracker)...')
{
  const tracker = createContextTracker()
  const msg = (role, text, extra = {}) => ({ role, content: text, ...extra })
  const U1 = msg('user', '第一问')
  const A1 = msg('assistant', '第一答')
  const U2 = msg('user', '第二问')
  const A2 = msg('assistant', '第二答')

  // 15a. 首轮
  let d = tracker.decide('k', [{ role: 'system', content: 's' }, U1])
  assert.equal(d.action, 'fresh')
  // 15b. 追加 → 沿用上游上下文
  d = tracker.decide('k', [{ role: 'system', content: 's' }, U1, A1, U2])
  assert.equal(d.action, 'continue')
  assert.equal(d.reason, 'append-only')
  // 15c. system 变了但非 system 消息是追加 → 仍然 continue（DSH 系统提示词每轮可能带动态内容）
  d = tracker.decide('k', [{ role: 'system', content: 's2' }, U1, A1, U2, A2])
  assert.equal(d.action, 'continue')
  // 15d. 重试同一条（列表一模一样）→ 必须换会话，否则上游会看到重复的一轮
  d = tracker.decide('k', [{ role: 'system', content: 's2' }, U1, A1, U2, A2])
  assert.equal(d.action, 'resync')
  assert.equal(d.reason, 'retry-same-history')
  // 15e. 压缩：列表变短 → 换会话 + 补发历史
  d = tracker.decide('k', [{ role: 'system', content: 's' }, U1])
  assert.equal(d.action, 'resync')
  assert.equal(d.reason, 'history-shrank')
  // 15f. 改写：把已有消息换了个说法 → 换会话
  d = tracker.decide('k', [{ role: 'system', content: 's' }, { role: 'user', content: '被改写过的第一问' }])
  assert.equal(d.action, 'resync')
  assert.equal(d.reason, 'history-rewritten')
  // 15g. 工具结果轮永远留在原会话（上游还挂着待办的工具调用）
  const withTool = [
    { role: 'system', content: 's' }, U1,
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'pwsh', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '输出' },
  ]
  for (let i = 0; i < 3; i += 1) {
    d = tracker.decide('k2', withTool)
    if (i > 0) assert.equal(d.action, 'continue', '工具结果轮不该触发换会话')
  }
  assert.equal(d.reason, 'tool-round')
  // 15h. 轮数上限：连续追加到上限后必须换一次会话，且理由正确
  const capped = createContextTracker()
  capped.decide('c', [U1])
  const actions = []
  for (let i = 1; i <= 5; i += 1) {
    const seen = capped.decide('c', [U1, ...Array.from({ length: i }, (_, j) => msg('user', `第${j}轮`))], { maxRounds: 3 })
    actions.push(seen)
  }
  assert.ok(actions.some((a) => a.action === 'resync' && a.reason === 'round-cap'), JSON.stringify(actions))
  assert.ok(actions.every((a) => a.action === 'resync' || a.action === 'continue'))
  // 上限 0 = 不限制
  const unlimited = createContextTracker()
  unlimited.decide('u', [U1])
  const seenU = unlimited.decide('u', [U1, msg('user', '再问')], { maxRounds: 0 })
  assert.equal(seenU.action, 'continue')
  // 15i. 指纹忽略 system/developer
  assert.deepEqual(fingerprintMessages([{ role: 'system', content: 'a' }, { role: 'developer', content: 'b' }]), [])
}

console.log('16. 验证客户端身份口径 (identityOf / 请求头拼装)...')
{
  const desktop = identityOf('desktop')
  assert.equal(desktop.origin, 'http://tauri.localhost')
  assert.equal(desktop.referer, 'http://tauri.localhost/')
  const web = identityOf('web')
  assert.equal(web.origin, 'https://orcaterm.com')
  assert.equal(web.referer, 'https://orcaterm.com/terminal')
  // 未知口径回落桌面端（默认口径），不抛错
  assert.deepEqual(identityOf('nonsense'), desktop)
  // 桌面端 UA 是实测来的浏览器 UA，不是插件自报名字
  assert.match(DESKTOP_IDENTITY.userAgent, /^Mozilla\/5\.0/)
  assert.doesNotMatch(DESKTOP_IDENTITY.userAgent, /dsh-orchaterm/)

  const asked = []
  const cfg = {
    cgiBase: 'https://api.orcaterm.cloud.tencent.com',
    origin: desktop.origin,
    referer: desktop.referer,
    userAgent: DESKTOP_IDENTITY.userAgent,
    credential: { token: 't', cookieHeader: '', csrfCode: '7', uin: 'u1', ownerUin: 'o1' },
    cookieFor: (host) => { asked.push(host); return `Cookie-for-${host}` },
  }
  const cgi = cgiHeaders(cfg)
  assert.equal(cgi.Origin, 'http://tauri.localhost')
  assert.equal(cgi['X-Referer'], 'http://tauri.localhost/')
  assert.equal(cgi['user-agent'], DESKTOP_IDENTITY.userAgent)
  // cookie 按**实际 cgiBase 的 host** 取，不再写死 api.orcaterm.com
  assert.deepEqual(asked, ['api.orcaterm.cloud.tencent.com'])
  assert.equal(cgi.Cookie, 'Cookie-for-api.orcaterm.cloud.tencent.com')

  const asst = assistantHeaders({ ...cfg, assistantBase: 'https://lightai.cloud.tencent.com/assistant' }, 'seq-1')
  assert.equal(asst.origin, 'http://tauri.localhost')
  assert.equal(asst.referer, 'http://tauri.localhost/')
  assert.equal(asst['X-Referer'], 'http://tauri.localhost/')
  assert.equal(asst['x-seqid'], 'seq-1')
  assert.equal(asst.Accept, 'text/event-stream')

  // 绕过 buildConfig 手搓 config 时也不能发出 undefined
  const bare = cgiHeaders({ cgiBase: 'https://x.test', credential: { csrfCode: '', uin: '', token: '' } })
  assert.equal(bare.Origin, 'http://tauri.localhost')
  assert.equal(bare['X-Referer'], 'http://tauri.localhost/')
  assert.match(bare['user-agent'], /^Mozilla\/5\.0/)
  const bareAsst = assistantHeaders({ assistantBase: 'https://y.test/assistant', credential: { csrfCode: '' } })
  assert.equal(bareAsst.origin, 'http://tauri.localhost')
  assert.doesNotMatch(JSON.stringify(bareAsst), /undefined/)
}

console.log('17. 验证新增配置键与重启判定...')
{
  assert.equal(DEFAULTS.clientIdentity, 'desktop')
  assert.ok(MANAGER_KEYS.includes('clientIdentity'), '改身份口径要重启后端')
}

console.log('18. 验证凭据临期自动续期 (ensureFreshCredential / refreshCredential / tokenRefresher)...')
{
  const future = () => JSON.stringify({ exp: Math.floor((Date.now() + 3600_000) / 1000) })
  const expiring = () => JSON.stringify({ exp: Math.floor((Date.now() + 30_000) / 1000) })
  const jwtOf = (payload) => `header.${Buffer.from(payload()).toString('base64')}.sig`
  const ready = { token: 't', cookieHeader: '', jar: [], csrfCode: '1', uin: 'u', skey: 's' }

  // 18a. 健康凭据（距过期 > 10min）：不重读本地、不续期
  {
    let reads = 0
    const cfg = { credential: { ...ready, token: jwtOf(future) }, tokenRefreshLeadMs: 600000, refreshCredential: () => { reads += 1; return { ...ready, token: jwtOf(future) } } }
    await ensureFreshCredential(cfg)
    assert.equal(reads, 0)
  }
  // 18b. 临期（< 10min）：本地重读并替换（桌面端若在跑，这一步就够了，零网络）
  {
    const cfg = { credential: { ...ready, token: jwtOf(expiring) }, tokenRefreshLeadMs: 600000, refreshCredential: () => { cfg.credential = { ...ready, token: jwtOf(future) }; return cfg.credential } }
    const got = await ensureFreshCredential(cfg)
    assert.equal(got.token, cfg.credential.token)
    assert.notEqual(got.token, '')
  }
  // 18c. exp 解析不出（=0）：与「过期」同等对待，也重读
  {
    let reads = 0
    const cfg = { credential: { ...ready, token: 'not-a-jwt' }, tokenRefreshLeadMs: 600000, refreshCredential: () => { reads += 1; return { ...ready, token: jwtOf(future) } } }
    await ensureFreshCredential(cfg)
    assert.equal(reads, 1)
  }
  // 18d. 没有 refreshCredential / tokenRefresher 的 config（手搓的）：原样返回不抛错
  {
    const cfg = { credential: { ...ready } }
    assert.equal(await ensureFreshCredential(cfg), cfg.credential)
  }
  // 18e. buildConfig 产物自带 refreshCredential，且 cookieFor 读的是**当时的** credential
  {
    const cfg = buildConfig({ credential: { ...ready, cookieHeader: 'a=1', jar: [{ name: 'a', value: '1', domain: 'x.test', path: '/' }] } })
    assert.equal(typeof cfg.refreshCredential, 'function')
    assert.equal(typeof cfg.forceRefreshCredential, 'function')
    assert.equal(typeof cfg.tokenRefresher?.ensureFresh, 'function')
    cfg.credential = { ...cfg.credential, cookieHeader: '', jar: [{ name: 'b', value: '2', domain: 'y.test', path: '/' }] }
    assert.equal(cfg.cookieFor('y.test'), 'b=2')
  }
  // 18f. 本地重读仍是临期 → 交给 tokenRefresher 走网络续期（先重读、再续期，次序固定）
  {
    const order = []
    const cfg = {
      credential: { ...ready, token: jwtOf(expiring) },
      tokenRefreshLeadMs: 600000,
      tokenRefreshEnabled: true,
      refreshCredential: () => { order.push('local'); return cfg.credential },
      tokenRefresher: { ensureFresh: async () => { order.push('network'); return { ok: true, refreshed: true } } },
    }
    await ensureFreshCredential(cfg)
    assert.deepEqual(order, ['local', 'network'])
  }
  // 18g. tokenRefresh='off'（enabled=false）：不调用续期器，退回纯重读
  {
    let network = 0
    const cfg = {
      credential: { ...ready, token: jwtOf(expiring) },
      tokenRefreshLeadMs: 600000,
      tokenRefreshEnabled: false,
      refreshCredential: () => {},
      tokenRefresher: { ensureFresh: async () => { network += 1; return { ok: true } } },
    }
    await ensureFreshCredential(cfg)
    assert.equal(network, 0)
  }
}

console.log('19. 验证 <thinking> 标签改道 (createThinkingTagRouter)...')
{
  const routed = []
  // 19a. 开头的完整标签块 → 内容进推理，正文只剩后半
  {
    const r = createThinkingTagRouter({ onReasoning: (t) => routed.push(t) })
    const out = r.feed('\n\n<thinking>\n先扫描再分类。\n</thinking>\n\n好的，开始执行。')
    assert.equal(out.trim(), '好的，开始执行。')
    assert.equal(routed.join('').includes('先扫描再分类。'), true)
  }
  // 19b. 逐字符分片也要正确
  {
    routed.length = 0
    const r = createThinkingTagRouter({ onReasoning: (t) => routed.push(t) })
    const stream = 'A<thinking>推理内容</thinking>B'
    let out = ''
    for (const ch of stream) out += r.feed(ch)
    out += r.flush()
    assert.equal(out, 'AB')
    assert.equal(routed.includes('推理内容'), true)
  }
  // 19c. 没有标签 → 原样放行
  {
    const r = createThinkingTagRouter({ onReasoning: (t) => routed.push(t) })
    assert.equal(r.feed('普通正文 <t 但不是标签'), '普通正文 <t 但不是标签')
    assert.equal(r.flush(), '')
  }
  // 19d. 只有开标签没有闭标签 → 流结束兜底按正文放行（含开标签），不能吞内容
  {
    const r = createThinkingTagRouter({ maxHold: 40, onReasoning: (t) => routed.push(t) })
    const held = r.feed('<thinking>一直没结束的内容')
    const out = held + r.flush()
    assert.ok(out.includes('<thinking>'), '兜底必须把开标签吐回正文')
    assert.ok(out.includes('一直没结束'), out)
  }
  // 19e. 中段出现标签块 → 前后正文都保留
  {
    routed.length = 0
    const r = createThinkingTagRouter({ onReasoning: (t) => routed.push(t) })
    const out = r.feed('前文<thinking>中间思考</thinking>后文')
    assert.equal(out, '前文后文')
    assert.equal(routed.includes('中间思考'), true)
  }
}

console.log('20. 验证辅助请求（purpose）不共用主会话键...')
{
  const adapter = new OrcaTermWebApiAdapter({}, null, null)
  const main = { sessionId: 'sess-1', messages: [{ role: 'user', content: 'hi' }] }
  const title = { sessionId: 'sess-1', purpose: 'session-title', messages: [{ role: 'user', content: 'hi' }] }
  const compact = { sessionId: 'sess-1', purpose: 'compaction', messages: [{ role: 'user', content: 'hi' }] }
  const kMain = adapter.conversationKey(main)
  const kTitle = adapter.conversationKey(title)
  const kCompact = adapter.conversationKey(compact)
  assert.equal(kMain, 's:sess-1')
  assert.ok(kTitle.startsWith('aux:session-title:'), kTitle)
  assert.ok(kCompact.startsWith('aux:compaction:'), kCompact)
  assert.notEqual(kTitle, kMain)
  assert.notEqual(kTitle, kCompact)
  // 无 sessionId 的辅助请求也要有自己的键
  const t2 = adapter.conversationKey({ purpose: 'session-title', messages: [{ role: 'user', content: 'hi' }] })
  assert.ok(t2.startsWith('aux:session-title:'), t2)
}

console.log('21. 验证工具结果脱敏（官方 Sn.fp 移植 redactSecrets）...')
{
  // 21a. JWT 三段式（官方正则要求前两段都以 eyJ 开头）
  assert.equal(
    redactSecrets('token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeK-adQssw5c'),
    'token is [已隐藏的 JWT 令牌]',
  )
  // 21b. API key / AWS / GitHub
  assert.equal(redactSecrets('key sk-ant-abc123def456ghi789'), 'key [已隐藏的 API 密钥]')
  assert.equal(redactSecrets('AKIAIOSFODNN7EXAMPLE'), '[已隐藏的 AWS 密钥]')
  assert.ok(redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234').includes('已隐藏'))
  // 21c. Bearer
  assert.equal(redactSecrets('Authorization: Bearer abcdef12345678'), 'Authorization: Bearer ***')
  // 21d. 敏感赋值（password=xxx）与非敏感赋值（name=xxx 不动）
  assert.equal(redactSecrets('db connect with password=hunter2 now'), 'db connect with password=*** now')
  assert.equal(redactSecrets('run with name=abc'), 'run with name=abc')
  // 21e. CLI 形态：sshpass / mysql -p / curl -u / --token
  assert.ok(redactSecrets('sshpass -p s3cret ssh host').includes('***'))
  assert.ok(redactSecrets('mysql -u root -ps3cret -h db').includes('***'))
  assert.ok(redactSecrets('curl -u admin:topsecret https://x').includes('admin:***'))
  assert.ok(redactSecrets('git push --token abc123def https://x').includes('***'))
  // 21f. URL 内嵌凭据
  assert.equal(
    redactSecrets('postgres://admin:p4ss@db:5432/app'),
    'postgres://admin:***@db:5432/app',
  )
  // 21g. 环境变量赋值
  assert.ok(redactSecrets('PGPASSWORD=secret psql').includes('***'))
  // 21h. PEM 私钥块
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
  assert.equal(redactSecrets(pem), '[已隐藏的私钥证书]')
  // 21i. 非字符串入参 → 空串（官方 s 函数语义）
  assert.equal(redactSecrets(undefined), '')
  assert.equal(redactSecrets(''), '')
}

console.log('22. 验证 UI 工具注册表与官方分类器 (classifyUiToolCategory)...')
{
  // 官方全集：headless 15 个 + foreground 8 个
  assert.equal(UI_TOOL_HEADLESS.length, 15)
  assert.equal(UI_TOOL_FOREGROUND.length, 8)
  assert.ok(UI_TOOL_HEADLESS.includes('execute_terminal_command'))
  assert.ok(UI_TOOL_FOREGROUND.includes('remote_edit'))
  // 分类器：mcp → server_mcp；system → server_system；名字落两集；未知 → foreground_required
  assert.equal(classifyUiToolCategory({ type: 'mcp', mcpServer: 'x', name: 'execute_command' }), 'server_mcp')
  assert.equal(classifyUiToolCategory({ type: 'system', name: 'internal_fallback' }), 'server_system')
  assert.equal(classifyUiToolCategory({ name: 'remote_read' }), 'headless_ui')
  assert.equal(classifyUiToolCategory({ name: 'run_commands' }), 'foreground_required')
  assert.equal(classifyUiToolCategory({ name: 'totally_unknown_tool' }), 'foreground_required')
}

console.log('23. 验证回传重试退避公式（官方 xn.SE：base*2^n 封顶 max）...')
{
  assert.equal(reportRetryBackoffMs(0), 300)
  assert.equal(reportRetryBackoffMs(1), 600)
  assert.equal(reportRetryBackoffMs(2), 1200)
  assert.equal(reportRetryBackoffMs(3), 1500) // 封顶
  assert.equal(reportRetryBackoffMs(9, { baseDelayMs: 250, maxDelayMs: 2000 }), 2000)
  assert.equal(REPORT_RETRY_TIMEOUT_MS, 15000)
}

console.log('24. 验证官方对齐的请求细节（input.id=x-seqid / 流控制 URL / 会话 ID 形态）...')
{
  const cfg = buildConfig({ credential: { uin: 'u1', token: 't', csrfCode: 'c', assistantReady: true } })
  // 24a. assistantBody：reviewInput 与普通输入都带 input.id
  const b1 = assistantBody(cfg, { conversationId: 'cid-x-orcaterm', content: 'hi', inputId: 'seq-1' })
  assert.equal(b1.input.id, 'seq-1')
  const b2 = assistantBody(cfg, { conversationId: 'cid-x-orcaterm', content: 'hi', inputId: 'seq-2', reviewInput: { type: 'review', reviewAction: 'reportToolResult', toolResult: 'r', tool: { name: 'execute_command', args: {} } } })
  assert.equal(b2.input.id, 'seq-2')
  assert.equal(b2.input.type, 'review')
  assert.equal(b2.input.files.length, 0)
  // 24b. 流控制 URL：会话 ID 在路径段，查询串带 name/mode/csrfCode/sseresume
  const abortUrl = streamControlUrl(cfg, '/stream/abort', 'cid-x-orcaterm')
  assert.ok(abortUrl.includes('/assistant/stream/abort/cid-x-orcaterm'), abortUrl)
  assert.ok(abortUrl.includes('name=orcaterm'), abortUrl)
  assert.ok(abortUrl.includes('sseresume=true'), abortUrl)
  // 24c. 官方会话 ID 形态：cid-<uuid>-orcaterm（不再用 cid-dsh- 前缀）
  const cid = `cid-${'0123456789abcdef'.slice(0, 8)}-orcaterm`
  assert.match(cid, /^cid-[0-9a-f]+-orcaterm$/)
}

console.log('25. 验证未决 review 的用户文本走 feedback 通道（官方 ut 语义）...')
{
  const toolCalls = [{ id: 'call_x_1', type: 'function', function: { name: 'pwsh', arguments: '{"command":"dir"}' } }]
  // 25a. assistant 发了 tool_calls、用户没回工具结果直接打字 → review+feedback，带未决工具原件
  const fb = toAssistantInput([
    { role: 'user', content: '帮我看看目录' },
    { role: 'assistant', content: '', tool_calls: toolCalls },
    { role: 'user', content: '别跑了，换个方式' },
  ])
  assert.equal(fb.type, 'review')
  assert.equal(fb.reviewInput.type, 'review')
  assert.equal(fb.reviewInput.reviewAction, 'feedback')
  assert.equal(fb.reviewInput.input, '别跑了，换个方式')
  assert.equal(fb.reviewInput.tool.name, 'execute_command')
  assert.equal(fb.content, '别跑了，换个方式')
  // 25b. 正常工具结果轮优先级更高：仍是 reportToolResult，不误判 feedback
  const rep = toAssistantInput([
    { role: 'user', content: '帮我看看目录' },
    { role: 'assistant', content: '', tool_calls: toolCalls },
    { role: 'tool', tool_call_id: 'call_x_1', content: '文件 A\n文件 B' },
  ])
  assert.equal(rep.reviewInput.reviewAction, 'reportToolResult')
  assert.equal(rep.reviewInput.toolResult.includes('文件 A'), true)
  // 25c. 上个 assistant 是纯文本（工具循环已闭环）→ 用户文本仍是 start，不进 feedback
  const start = toAssistantInput([
    { role: 'assistant', content: '上一轮的回答' },
    { role: 'user', content: '新问题' },
  ])
  assert.equal(start.type, 'start')
  assert.equal(start.reviewInput, undefined)
  // 25d. 首轮（无 assistant）不受影响
  const fresh = toAssistantInput([{ role: 'user', content: '你好' }])
  assert.equal(fresh.type, 'start')
}

console.log('26. 验证 ask 提问信封 ⇄ DSH ask_user_question 双向适配...')
{
  // 26a. 选项是纯字符串（上游实测形态）→ 映射成 {label}，并按信封原文给出问题
  const ask = { action: 'ask', question: '请问您想清理哪个目录？', options: ['临时文件夹', '系统临时文件夹', '我自己指定路径'] }
  const args = askEnvelopeToQuestionTool(ask, { idPrefix: 'orca-q-test' })
  assert.equal(args.questions.length, 1)
  assert.equal(args.questions[0].id, 'orca-q-test')
  assert.equal(args.questions[0].question, '请问您想清理哪个目录？')
  assert.deepEqual(args.questions[0].options, [{ label: '临时文件夹' }, { label: '系统临时文件夹' }, { label: '我自己指定路径' }])
  // 单选语义：信封没声明多选时不下发 multi_select（DSH 默认单选）
  assert.equal('multi_select' in args.questions[0], false)

  // 26b. 选项是对象（{label,description}）→ 描述透传
  const objAsk = askEnvelopeToQuestionTool({
    action: 'ask',
    question: '选哪个？',
    options: [{ label: 'A', description: '第一个' }, { label: 'B' }],
  })
  assert.deepEqual(objAsk.questions[0].options, [{ label: 'A', description: '第一个' }, { label: 'B' }])

  // 26c. 没有 question 字段 → 不产出（调用方退回正文+选项清单）
  assert.equal(askEnvelopeToQuestionTool({ action: 'ask', options: ['A'] }), null)
  assert.equal(askEnvelopeToQuestionTool({ action: 'ask', question: '   ' }), null)

  // 26d. 无选项也能成问题（DSH 弹窗降级为自由文本输入框）
  const noOpts = askEnvelopeToQuestionTool({ action: 'ask', question: '部署到哪个环境？' })
  assert.equal(noOpts.questions[0].options, undefined)

  // 26e. 选项形状兜底：非字符串非对象、空串一律丢掉，不产出空 label
  assert.equal(toDshOption('  x  ').label, 'x')
  assert.equal(toDshOption('   '), null)
  assert.equal(toDshOption(42), null)
  assert.equal(toDshOption(null), null)
  assert.equal(toDshOption({ name: 'name 键也算 label' }).label, 'name 键也算 label')

  // 26f. 工具名常量与 DSH 工具定义一致（packages/interaction/tool-ask-user）
  assert.equal(ASK_TOOL_NAME, 'ask_user_question')

  // 26g. DSH 答复 → 上游答复正文（官方 respondToAsk 的 input）
  assert.equal(
    askResultToAnswerText(JSON.stringify({ answers: [{ id: 'orca-q-test', selected: ['临时文件夹'] }] })),
    '临时文件夹',
  )
  assert.equal(
    askResultToAnswerText(JSON.stringify({ answers: [{ id: 'q', selected: ['A', 'B'], custom: '补充' }] })),
    'A、B、补充',
  )
  // 用户跳过（selected 空、无 custom）→ 给一句明确说明，不能回空串让上游以为没答复
  assert.equal(askResultToAnswerText(JSON.stringify({ answers: [{ id: 'q', selected: [] }] })), '（用户跳过了这个问题，没有给出答复）')
  assert.equal(askResultToAnswerText(JSON.stringify({ answers: [] })), '（用户跳过了这个问题，没有给出答复）')
  // 未决（DSH 延迟应答）与非法输入
  assert.equal(askResultToAnswerText(JSON.stringify({ pending: true })), '（用户跳过了这个问题，没有给出答复）')
  assert.equal(askResultToAnswerText('用户说：先别动'), '用户说：先别动')
  assert.equal(askResultToAnswerText(''), '（用户跳过了这个问题，没有给出答复）')

  // 26h. 逐轮信封开关：默认 review（桌面端唯一消费的形态），显式传 ask 才切
  const toolCalls = [{ id: 'call_x_1', type: 'function', function: { name: 'pwsh', arguments: '{"command":"dir"}' } }]
  const msgs = [
    { role: 'assistant', content: '', tool_calls: toolCalls },
    { role: 'tool', tool_call_id: 'call_x_1', content: 'done' },
  ]
  assert.equal(toAssistantInput(msgs).reviewInput.reviewAction, 'reportToolResult')
  const asked = toAssistantInput(msgs, { resultEnvelope: 'ask' })
  assert.equal(asked.type, 'ask')
  assert.equal(asked.reviewInput, undefined)
  // 官方 reportToolResult 的 input 形态：{TOOL_RESULT}(<tool.name>): <result>
  assert.equal(asked.content.startsWith('{TOOL_RESULT}(execute_command): '), true)
  assert.equal(asked.content.endsWith('done'), true)
  // 26i. 标签生成器（模块 73383 的 v/b）在两种名字形态下的输出
  assert.equal(wrapToolResultInput('remote_read', 'X'), '{TOOL_RESULT}(remote_read): X')
  assert.equal(wrapToolResultInput('', 'X'), '{TOOL_RESULT}: X')
  assert.equal(wrapToolResultInput('bad name!', 'X'), '{TOOL_RESULT}: X')
  // 26j. 已知是提问的 callId → 回程走 respondToAsk（不带 {TOOL_RESULT} 标签）
  const asAsk = toAssistantInput(
    [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_ask_1', type: 'function', function: { name: 'ask_user_question', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_ask_1', content: JSON.stringify({ answers: [{ id: 'q', selected: ['B'] }] }) },
    ],
    { askCallIds: new Set(['call_ask_1']) },
  )
  assert.equal(asAsk.type, 'ask')
  assert.equal(asAsk.content, 'B')
  assert.equal(asAsk.reviewInput, undefined)
}

console.log('27. 验证结构化指令残缺时的兜底（畸形 ask 信封 / 畸形答复 / 丢档 / 混批）...')
{
  // ── 畸形 ask 信封：模型把 options 写成各种样子 ──────────────────
  // 27a. options 里混进 null / 数字 / 空白串 / 缺 label 的对象 → 逐个丢掉，不产出空 label
  const messy = askEnvelopeToQuestionTool({
    action: 'ask',
    question: '选一个',
    options: ['A', null, 42, '   ', {}, { description: '没有 label' }, { label: '  B  ', description: '  ' }],
  })
  assert.deepEqual(messy.questions[0].options, [{ label: 'A' }, { label: 'B' }])
  // 27b. 选项列表超长 → 截到上限，弹窗不被撑爆
  const many = askEnvelopeToQuestionTool({ action: 'ask', question: 'q', options: Array.from({ length: 40 }, (_, i) => `opt${i}`) })
  assert.equal(many.questions[0].options.length, 12)
  // 27c. question 不是字符串（模型写成数字/对象）→ 不产出，调用方退回正文+清单
  assert.equal(askEnvelopeToQuestionTool({ action: 'ask', question: 123 }), null)
  assert.equal(askEnvelopeToQuestionTool({ action: 'ask', question: { text: 'x' } }), null)
  // 27d. 可选字段透传：header 与 multiSelect
  const withHeader = askEnvelopeToQuestionTool({ action: 'ask', question: 'q', header: '  确认  ', multiSelect: true })
  assert.equal(withHeader.questions[0].header, '确认')
  assert.equal(withHeader.questions[0].multi_select, true)
  // 27e. header 是空白串 → 不下发该字段（避免弹窗出现空标题）
  assert.equal('header' in askEnvelopeToQuestionTool({ action: 'ask', question: 'q', header: '   ' }).questions[0], false)

  // ── 畸形答复：DSH 回传的工具结果不是我们以为的 JSON ─────────────
  const SKIP = '（用户跳过了这个问题，没有给出答复）'
  // 27f. answers 缺字段 / 不是数组 → 原文兜底，不吞内容
  assert.equal(askResultToAnswerText(JSON.stringify({ id: 'x' })), '{"id":"x"}')
  assert.equal(askResultToAnswerText(JSON.stringify({ answers: 'oops' })), '{"answers":"oops"}')
  // 27g. selected 里混进非字符串 / 空白 → 过滤掉，保住剩下的
  assert.equal(askResultToAnswerText(JSON.stringify({ answers: [{ id: 'q', selected: ['A', 42, '', '  ', 'B'] }] })), 'A、B')
  // 27h. 只有 custom、空白 custom、非字符串 custom
  assert.equal(askResultToAnswerText(JSON.stringify({ answers: [{ id: 'q', selected: [], custom: '手写答案' }] })), '手写答案')
  assert.equal(askResultToAnswerText(JSON.stringify({ answers: [{ id: 'q', selected: [], custom: '   ' }] })), SKIP)
  assert.equal(askResultToAnswerText(JSON.stringify({ answers: [{ id: 'q', selected: [], custom: 7 }] })), SKIP)
  // 27i. 多问题批次拼成一段（上游信封只有单问题，这里只保证不崩且都带上）
  assert.equal(
    askResultToAnswerText(JSON.stringify({ answers: [{ id: 'a', selected: ['X'] }, { id: 'b', custom: 'Y' }] })),
    'X；Y',
  )
  // 27j. 工具报错的文本（非 JSON）原样当答复，不吞掉错误信息
  assert.equal(askResultToAnswerText('Error: ask_user_question was aborted before the user answered'),
    'Error: ask_user_question was aborted before the user answered')

  // ── 回传轮：丢档与混批 ─────────────────────────────────────────
  // 27k. LRU 丢档（进程重启后）→ reconstructOrcaTool 反推，review 信封照样成形
  const lostCall = [{ id: 'call_lost_1', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.txt"}' } }]
  const lost = toAssistantInput([
    { role: 'assistant', content: '', tool_calls: lostCall },
    { role: 'tool', tool_call_id: 'call_lost_1', content: 'file body' },
  ])
  assert.equal(lost.reviewInput.reviewAction, 'reportToolResult')
  assert.equal(lost.reviewInput.tool.name, 'remote_read')
  assert.equal(lost.reviewInput.toolResult.includes('file body'), true)
  // 27l. 工具参数不是合法 JSON（模型吐坏）→ 反推不炸，退化成原样 args
  const badArgs = toAssistantInput([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'pwsh', arguments: '{不是 JSON' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'ok' },
  ])
  assert.equal(badArgs.reviewInput.toolResult.includes('ok'), true)
  // 27m. 混批（一个提问 + 一个真工具结果）→ 整批走工具结果信封，不做 respondToAsk
  const mixed = toAssistantInput(
    [
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'ask1', type: 'function', function: { name: 'ask_user_question', arguments: '{}' } },
          { id: 'tool1', type: 'function', function: { name: 'pwsh', arguments: '{"command":"dir"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'ask1', content: JSON.stringify({ answers: [{ id: 'q', selected: ['A'] }] }) },
      { role: 'tool', tool_call_id: 'tool1', content: 'done' },
    ],
    { askCallIds: new Set(['ask1']) },
  )
  assert.equal(mixed.reviewInput.reviewAction, 'reportToolResult')
  // 27n. 提问与「官方主循环信封」同时启用时，提问优先走 respondToAsk（答复是用户的话，不是 {TOOL_RESULT}）
  const askWins = toAssistantInput(
    [
      { role: 'assistant', content: '', tool_calls: [{ id: 'ask1', type: 'function', function: { name: 'ask_user_question', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'ask1', content: JSON.stringify({ answers: [{ id: 'q', selected: ['B'] }] }) },
    ],
    { resultEnvelope: 'ask', askCallIds: new Set(['ask1']) },
  )
  assert.equal(askWins.type, 'ask')
  assert.equal(askWins.content, 'B')
  assert.equal(askWins.content.includes('{TOOL_RESULT}'), false)
}

console.log('smoke 测试全部通过！')

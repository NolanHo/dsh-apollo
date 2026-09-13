/**
 * 浏览器半边（src/client.js）的 node 单测。分两层：
 *
 * 1. 装载层：fake `window.__ModuleLoader__` + fake `require('react')`（模块体只
 *    注册工厂，与真实浏览器加载同构），断言注册契约、locale 词典与包清单注入。
 * 2. 组件层：最小 hooks 运行时（useState/useEffect/useRef，见 makeReact）驱动真实
 *    组件，断言 effect 的行为——按 id 开流与差分、结算即释放、失败标记、abort
 *    清理、展示时钟。这些只在 effect 里发生，纯函数测不到。
 *
 * 不起浏览器：真实 GUI 由 Lead 在第二个 dsh 实例上验证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** 装载工厂：捕获 __ModuleLoader__.load 的入参定义。 */
async function loadDefinition() {
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded.push(definition) } } }
  await import('../src/client.js')
  assert.equal(loaded.length, 1)
  return loaded[0]
}

const definition = await loadDefinition()

/**
 * 模块级 fake react：工厂只 materialize 一次，所以这里放一层可换的委托——默认
 * 不渲染（只测注册契约的用例不需要元素树），组件层用例用 useReactRuntime() 换上
 * 真正产出元素与 effect 的 hooks 实现。
 */
function inertHooks() {
  return {
    createElement: () => null,
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  }
}
let runtime = inertHooks()
const react = {
  createElement: (...args) => runtime.createElement(...args),
  useEffect: (...args) => runtime.useEffect(...args),
  useRef: (...args) => runtime.useRef(...args),
  useState: (...args) => runtime.useState(...args),
}

/**
 * 通用工具行存根：折叠/展开归 harness 的 `ToolRow`（本插件的测试不覆盖它），这里
 * 只钉"展开体被作为 `bodyContent` 交给通用行、并带上 conversation 的翻译函数"。
 */
function genericToolCardStub(props) {
  // 不渲染 bodyContent：生产里 `ToolRow` 是 `{open && children}`，收起时展开体
  // 根本不挂载；这把"折叠时不订阅"的语义留给 harness，也保证本文件里实时行的
  // 断言都打在展开体组件上。
  return react.createElement('div', {
    'data-generic-tool-card': props.toolName,
    'data-generic-body': props.bodyContent !== undefined,
    'data-generic-t': typeof props.t,
  })
}
const uiToolStub = { GenericToolCard: genericToolCardStub }

const client = definition.factory((name) => {
  if (name === 'react') return react
  if (name === '@deepseek-ai/dsh-client-ui-tool') return uiToolStub
  throw new Error('unexpected external "' + name + '"')
})

const { zh, en } = client.__test

/** fake ctx：记录 inject 的座位名、注册的座位与 effect 标签。 */
function makeCtx({ withSlots = true, registerThrows = false } = {}) {
  const injected = []
  const seats = []
  const effects = []
  const ctx = {
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (factory, label) => { effects.push(label); factory() },
    get: () => undefined,
  }
  if (withSlots) {
    ctx.slots = {
      inject: (name, callback) => { injected.push(name); callback(ctx) },
      register: (registration, component) => {
        if (registerThrows) throw new Error('slot unavailable')
        seats.push({ registration, component })
        return () => {}
      },
    }
  }
  return { ctx, injected, seats, effects }
}

/** 按座位名取注册项（缺项即失败）。 */
function seatOf(seats, name) {
  const seat = seats.find((entry) => entry.registration.name === name)
  assert.notEqual(seat, undefined, `missing seat ${name}`)
  return seat
}

test('工厂：注册包名行并导出 inject/apply/__test 接缝', () => {
  assert.equal(definition.id, 'dsh-apollo')
  assert.equal(typeof definition.factory, 'function')
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'locale', 'remote', 'remote.session'])
  assert.deepEqual(Object.keys(client.__test).sort(), [
    'WaitSubagentBody', 'WaitSubagentCard', 'en', 'foldEvents', 'followRequest', 'formatAge',
    'subscriptionDiff', 'targetKey', 'targetRecords', 'waitedIds', 'zh',
  ])
})

test('apply：保留设置页标签，并按工具名接管 wait_subagent 的工具卡', () => {
  const { ctx, injected, seats, effects } = makeCtx()
  client.apply(ctx)

  // 标题栏座位已撤掉：本插件不再注入 conversation.session.header.actions。
  assert.deepEqual(injected, ['settings.plugins.tab', 'tool.call.toolview'])

  const settings = seatOf(seats, 'settings.plugins.tab')
  assert.equal(settings.registration.id, 'eng')
  assert.equal(settings.registration.order, 30)
  assert.equal(settings.registration.locale, 'eng-panel')
  assert.equal(typeof settings.component, 'function')

  // 键就是 wire 工具名本身：注册即接管该工具的卡（未认领的键才退回通用工具行）。
  const card = seatOf(seats, 'tool.call.toolview')
  assert.equal(card.registration.key, 'wait_subagent')
  assert.equal(card.registration.order, 10)
  assert.equal(card.registration.locale, 'eng-panel')
  assert.equal(Object.hasOwn(card.registration, 'id'), false)
  // 组件身份必须钉死：只断言"是个函数"的话，注册成别的组件也照样绿。
  assert.equal(card.component, client.__test.WaitSubagentCard)

  assert.deepEqual(effects, ['eng-panel: dictionaries'])
})

test('apply：slots 缺失或座位注册抛错时只记日志，不抛', () => {
  const logs = []
  const original = console.warn
  console.warn = (...args) => { logs.push(args) }
  try {
    assert.doesNotThrow(() => client.apply(makeCtx({ withSlots: false }).ctx))
    assert.doesNotThrow(() => client.apply(makeCtx({ registerThrows: true }).ctx))
  } finally {
    console.warn = original
  }
  assert.equal(logs.length >= 1, true)
})

test('locale：座位与词典同 ns，zh/en 键集一致且覆盖全部词条', () => {
  // 座位注册的 locale 必须与 apply 的 register(NS, ...) 同 ns，否则文案退回原始 key。
  const { ctx, seats } = makeCtx()
  client.apply(ctx)
  assert.equal(seats.length, 2)
  for (const seat of seats) assert.equal(seat.registration.locale, 'eng-panel')

  // 硬编码键表：新增文案漏了英文（缺 key 会直接显示原始 key）这里变红。
  assert.deepEqual(Object.keys(zh).sort(), [
    'description', 'guardHint', 'guardLabel', 'loadFailed', 'loading', 'retry', 'save', 'saveFailed',
    'saved', 'saving', 'tab', 'title',
    'treeAgeHours', 'treeAgeMinutes', 'treeAgeSeconds', 'treeInactive', 'treeLastActive',
    'treeLastTool', 'treeLiveUnavailable', 'treeLoading', 'treeReadFailed', 'treeRunning',
    'waitMore', 'waitResult', 'waitTitleRunning', 'waitTitleSettled',
  ])
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`)
  }

  // 插值词条必须保留 {n} 占位符，否则档位数字/条数无处可填。
  for (const key of ['treeAgeSeconds', 'treeAgeMinutes', 'treeAgeHours', 'waitTitleRunning', 'waitMore']) {
    assert.equal(zh[key].includes('{n}'), true, `zh.${key}`)
    assert.equal(en[key].includes('{n}'), true, `en.${key}`)
  }
})

test('locale：每个词条都在源码里被引用（没有死键）', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  // 词条在源码里以 'key' 或 `key` 两种字面量出现（含模板字符串里带 * 后缀的分支）；
  // 只定义不引用的是死键，改错了 key 名也会在这里暴露。
  for (const key of [...Object.keys(zh), ...Object.keys(en)]) {
    assert.equal(source.includes(`'${key}'`) || source.includes(`\`${key}\``), true, `${key} defined but never referenced in src/client.js`)
  }
})

test('package.json：dsh.client.inject 声明了座位依赖的客户端包', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const inject = manifest.dsh?.client?.inject
  assert.equal(Array.isArray(inject), true)
  assert.equal(manifest.dsh.client.platform, 'web')
  // 这行清单决定浏览器加载哪些 client 半边：缺 session-controller 就没有会话目录
  // （卡里的标签/状态取不到），缺 remotes 就没有 remote.session（实时不可用）。
  for (const name of ['@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-remotes']) {
    assert.equal(inject.includes(name), true, `dsh.client.inject missing ${name}`)
  }
  // 插件声明的服务与这行清单成对：清单加载模块，inject 声明依赖，少一边就是半个座位。
  assert.deepEqual(client.inject, ['slots', 'locale', 'remote', 'remote.session'])
})

test('foldEvents：助手文本与工具名折叠成最后一行/最后工具/最后活动时间', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1000, data: {} },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2000,
      data: {
        message: {
          content: [
            { type: 'text', text: '先读 spec。\n' },
            { type: 'text', text: '再写代码。' },
            { type: 'tool_use', text: 'ignored' },
          ],
        },
      },
    },
    { type: 'tool/call', seq: 3, time: 3000, data: { name: 'ripgrep' } },
    { type: 'tool/result', seq: 4, time: 3500, data: { ok: true } },
    { type: 'assistant/message', seq: 5, time: 4000, data: { message: { content: [{ type: 'text', text: '完成。' }] } } },
  ]
  assert.deepEqual(client.__test.foldEvents(events), {
    lastText: '完成。',
    lastTool: 'ripgrep',
    lastTime: 4000,
  })
})

test('foldEvents：接受 snapshot 的记录信封，并接着上一次的状态累加', () => {
  const first = client.__test.foldEvents([
    { type: 'event', event: { type: 'tool/call', seq: 1, time: 10, data: { name: 'rg' } } },
  ])
  assert.deepEqual(first, { lastText: undefined, lastTool: 'rg', lastTime: 10 })

  const second = client.__test.foldEvents([
    { type: 'event', event: { type: 'assistant/message', seq: 2, time: 20, data: { message: { content: [{ type: 'text', text: 'ok' }] } } } },
  ], first)
  assert.deepEqual(second, { lastText: 'ok', lastTool: 'rg', lastTime: 20 })
})

test('foldEvents：user/message 是回合边界，清空上一轮的最后一行/最后工具', () => {
  // fork 种子前缀：父会话的最后一行与最后一个工具先到达，然后是子代理自己的用户
  // 输入。不重置的话，子代理还没产出时卡片显示的是父会话的内容。
  const seeded = client.__test.foldEvents([
    { type: 'tool/call', seq: 1, time: 10, data: { name: 'parent-tool' } },
    { type: 'assistant/message', seq: 2, time: 20, data: { message: { content: [{ type: 'text', text: '父会话的最后一行' }] } } },
    { type: 'user/message', seq: 3, time: 30, data: { message: { content: [{ type: 'text', text: '子代理的指令' }] } } },
  ])
  assert.deepEqual(seeded, { lastText: undefined, lastTool: undefined, lastTime: 30 })

  // continuable 子代理被再次唤醒：新输入之后不得继续显示上一轮的旧回复。
  const revived = client.__test.foldEvents([{ type: 'user/message', seq: 4, time: 40, data: {} }], seeded)
  assert.deepEqual(revived, { lastText: undefined, lastTool: undefined, lastTime: 40 })

  // 重置只推进时间，随后到来的助手输出照常折叠。
  const after = client.__test.foldEvents(
    [{ type: 'assistant/message', seq: 5, time: 50, data: { message: { content: [{ type: 'text', text: '新一轮' }] } } }],
    revived,
  )
  assert.deepEqual(after, { lastText: '新一轮', lastTool: undefined, lastTime: 50 })

  // time 不是有限数值时不覆盖上一次的活动时间。
  assert.deepEqual(
    client.__test.foldEvents([{ type: 'user/message', time: 'later', data: {} }], after),
    { lastText: undefined, lastTool: undefined, lastTime: 50 },
  )
})

test('foldEvents：畸形 data 一律跳过，不抛', () => {
  const malformed = [
    null,
    undefined,
    42,
    'nope',
    [],
    { type: 'event', event: null },
    { type: 'assistant/message', time: 9, data: null },
    { type: 'assistant/message', time: 9, data: 'text' },
    { type: 'assistant/message', time: 9, data: {} },
    { type: 'assistant/message', time: 9, data: { message: 5 } },
    { type: 'assistant/message', time: 9, data: { message: { content: 'nope' } } },
    {
      type: 'assistant/message',
      time: 9,
      data: { message: { content: [null, 3, { type: 'text' }, { type: 'text', text: 42 }, { type: 'text', text: '   ' }] } },
    },
    { type: 'tool/call', time: 9, data: { name: 42 } },
    { type: 'tool/call', time: 9, data: { name: '' } },
    { type: 'assistant/message', time: 'later', data: { message: { content: [{ type: 'text', text: 'keep me' }] } } },
  ]

  let state
  assert.doesNotThrow(() => { state = client.__test.foldEvents(malformed) })
  // 非数值 time 不覆盖上一次的活动时间。
  assert.deepEqual(state, { lastText: 'keep me', lastTool: undefined, lastTime: undefined })
  assert.deepEqual(client.__test.foldEvents(undefined), { lastText: undefined, lastTool: undefined, lastTime: undefined })
})

test('foldEvents：最后一行压平换行并截断到 120 字符', () => {
  const long = 'x'.repeat(200)
  const state = client.__test.foldEvents([
    { type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'text', text: `a\n\nb   c\n${long}` }] } } },
  ])
  assert.equal(state.lastText.startsWith('a b c '), true)
  assert.equal(state.lastText.length, 120)
  assert.equal(state.lastText.endsWith('…'), true)
})

test('formatAge：秒/分钟/小时三档；边界与非法输入', () => {
  const { formatAge } = client.__test
  assert.deepEqual(formatAge(0), { unit: 'seconds', value: 0 })
  assert.deepEqual(formatAge(3_400), { unit: 'seconds', value: 3 })
  assert.deepEqual(formatAge(89_999), { unit: 'seconds', value: 89 })
  assert.deepEqual(formatAge(90_000), { unit: 'minutes', value: 1 })
  // 边界：59:59 还是分钟，60:00 进小时档。
  assert.deepEqual(formatAge(3_599_999), { unit: 'minutes', value: 59 })
  assert.deepEqual(formatAge(3_600_000), { unit: 'hours', value: 1 })
  assert.deepEqual(formatAge(3_600_000 + 59_999), { unit: 'hours', value: 1 })
  assert.deepEqual(formatAge(2 * 3_600_000), { unit: 'hours', value: 2 })
  assert.deepEqual(formatAge(-5), { unit: 'seconds', value: 0 })
  assert.deepEqual(formatAge(Number.NaN), { unit: 'seconds', value: 0 })
  assert.deepEqual(formatAge(undefined), { unit: 'seconds', value: 0 })
})

test('waitedIds：解析名单、去重保序，并挡住畸形参数与超长名单', () => {
  const { waitedIds } = client.__test

  assert.deepEqual(waitedIds(JSON.stringify({ subagent_id: ['a', 'b'] })), { ids: ['a', 'b'], truncated: 0 })
  // 工具自身也去重保序（new Set），卡与它显示同一份名单。
  assert.deepEqual(waitedIds(JSON.stringify({ subagent_id: ['b', 'a', 'b'] })), { ids: ['b', 'a'], truncated: 0 })
  // 非字符串项/空串跳过，字符串项保留。
  assert.deepEqual(waitedIds(JSON.stringify({ subagent_id: ['a', 3, null, '', {}, 'b'] })), { ids: ['a', 'b'], truncated: 0 })

  // 非数组、缺字段、非对象根、畸形 JSON、非字符串参数：一律空名单（由卡退回朴素行）。
  const malformed = [
    JSON.stringify({ subagent_id: 'a' }),
    JSON.stringify({ timeout_ms: 1000 }),
    JSON.stringify({ subagent_id: {} }),
    '{"subagent_id": ["a"',
    'null',
    '"a"',
    '42',
    '[]',
    '',
    undefined,
    null,
  ]
  for (const raw of malformed) assert.deepEqual(waitedIds(raw), { ids: [], truncated: 0 }, String(raw))

  // 上限：超出的条数如实报出，不假装名单只有 LIMIT 条。
  const many = Array.from({ length: 10 }, (_, index) => `id-${index}`)
  const capped = waitedIds(JSON.stringify({ subagent_id: many }))
  assert.deepEqual(capped.ids, many.slice(0, 8))
  assert.equal(capped.truncated, 2)
})

test('followRequest：子代理地址带 kind 判别标签，且不传非法字段', () => {
  const { followRequest } = client.__test
  const request = followRequest('root', 'child-1', 'continuable')
  assert.deepEqual(request, {
    address: {
      kind: 'subagent',
      parentSessionId: 'root',
      childSessionId: 'child-1',
      mode: 'continuable',
    },
    maxMessages: 4,
  })
  // `assistantStream` 的类型是字面量 true（省略 = 不要 token 级增量，传 false 会被拒收）。
  assert.equal(Object.hasOwn(request, 'assistantStream'), false)
})

test('subscriptionDiff：集合变化只影响变化项，未变的流原样保留', () => {
  const { subscriptionDiff, targetKey } = client.__test
  const targetA = { parentSessionId: 'root', childSessionId: 'a', mode: 'one-shot' }
  const targetB = { parentSessionId: 'root', childSessionId: 'b', mode: 'continuable' }
  const targetC = { parentSessionId: 'root', childSessionId: 'c', mode: 'one-shot' }
  const keyA = targetKey(targetA)
  const keyB = targetKey(targetB)
  const keyC = targetKey(targetC)

  // 初次：全部开流，不 stop 任何东西。
  assert.deepEqual(subscriptionDiff([], [targetA, targetB]), {
    stop: [],
    start: [{ key: keyA, target: targetA }, { key: keyB, target: targetB }],
  })
  // 稳态：目录里其它 id 的状态翻转导致的重复执行不重开任何一路。
  assert.deepEqual(subscriptionDiff([keyA, keyB], [targetB, targetA]), { stop: [], start: [] })
  // 只增：新增 c 只开 c，a/b 不动。
  assert.deepEqual(subscriptionDiff([keyA, keyB], [targetA, targetB, targetC]), {
    stop: [],
    start: [{ key: keyC, target: targetC }],
  })
  // 只减：a 停止只 abort a，b 不动。
  assert.deepEqual(subscriptionDiff([keyA, keyB], [targetB]), { stop: [keyA], start: [] })
  // 同 id 不同 mode 是不同地址（换 mode 必须重开）。
  const other = { parentSessionId: 'root', childSessionId: 'a', mode: 'continuable' }
  assert.deepEqual(subscriptionDiff([keyA], [other]), { stop: [keyA], start: [{ key: targetKey(other), target: other }] })
  // 重复目标只开一次；畸形输入不抛。
  assert.equal(subscriptionDiff([], [targetA, targetA]).start.length, 1)
  assert.deepEqual(subscriptionDiff(undefined, undefined), { stop: [], start: [] })
  assert.deepEqual(subscriptionDiff([keyA], [null, 3, 'nope']), { stop: [keyA], start: [] })
  // stop 只列真正消失的 key，顺序按 active 集合稳定。
  assert.deepEqual(subscriptionDiff([keyA, keyB, keyC], [targetC]).stop, [keyA, keyB])
  assert.deepEqual(subscriptionDiff([keyA, keyB, keyC], [targetB, targetC]), { stop: [keyA], start: [] })
})

test('targetRecords：snapshot 取 records、event 取单条，其他帧不给内容', () => {
  const { targetRecords } = client.__test
  const records = [{ type: 'event', event: { type: 'tool/call', time: 1, data: { name: 'rg' } } }]
  assert.equal(targetRecords({ type: 'snapshot', records }), records)
  const event = { type: 'event', event: { type: 'tool/call', time: 2, data: { name: 'ls' } } }
  assert.deepEqual(targetRecords(event), [event])
  assert.equal(targetRecords({ type: 'snapshot' }), undefined)
  assert.equal(targetRecords({ type: 'assistant-stream', frame: {} }), undefined)
  assert.equal(targetRecords(null), undefined)
  assert.equal(targetRecords('nope'), undefined)
})

// ---------------------------------------------------------------- 组件层

/**
 * 最小 hooks 运行时。要点：
 * - 函数组件就地渲染：每个组件从 nextFree 起占一段连续槽位，父子不串。
 * - effect 在提交阶段按依赖数组的 Object.is 比较决定是否跳过。
 * - 同一槽位换 effect 时先跑旧 cleanup 再登记新的（否则丢失句柄，例如展示时钟）。
 * - 每个用例一份运行时，用例结束统一卸载，不留活流与定时器。
 */
function makeReact() {
  const slots = []
  const cleanups = new Map()
  const drivers = new Set()
  let pending = []
  let dirty = false
  let index = 0
  let target = null
  let tree = null
  // 每个组件函数一段固定槽位：同一组件跨渲染不换段，父子不共用下标。基准值只增
  // 不减（同一用例里可能出现多个组件函数，不能都从 0 起）。
  const SLOT_STRIDE = 32
  const slotBase = new Map()
  let slotNext = 0

  const sameDeps = (previous, next) => previous !== undefined
    && next !== undefined
    && previous.length === next.length
    && previous.every((value, at) => Object.is(value, next[at]))

  const normalize = (node, outer = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) {
      const rendered = []
      for (const child of node) {
        const savedIndex = index
        rendered.push(normalize(child, outer))
        index = savedIndex
      }
      return rendered
    }
    if (!('props' in node)) return node
    // 函数组件就地渲染：每个组件函数固定占一段槽位（按函数身份分配，跨渲染与
    // 渲染顺序都稳定），子组件不会拿到父组件用过的下标。
    if (typeof node.type === 'function') {
      if (!slotBase.has(node.type)) slotBase.set(node.type, slotNext++)
      const savedIndex = index
      const start = slotBase.get(node.type) * SLOT_STRIDE
      index = start
      const rendered = node.type(node.props)
      const ownIndex = index
      const queue = pending.splice(0)
      pending.push(...queue.filter((entry) => entry.at < start || entry.at >= ownIndex))
      outer.push(...queue.filter((entry) => entry.at >= start && entry.at < ownIndex))
      index = savedIndex
      return normalize(rendered, outer)
    }
    return { ...node, props: { ...node.props, children: normalize(node.props.children, outer) } }
  }

  const performRender = () => {
    index = 0
    pending = []
    const rootQueue = []
    tree = normalize(target(), rootQueue)  // 根组件也走函数分支，槽位段记账一致
    pending.push(...rootQueue)
  }

  const runEffects = async () => {
    for (let guard = 0; guard < 100; guard += 1) {
      const queue = pending
      pending = []
      for (const entry of queue) {
        cleanups.get(entry.at)?.()
        const result = entry.callback()
        if (typeof result === 'function') cleanups.set(entry.at, result)
        else cleanups.delete(entry.at)
      }
      if (!dirty) return
      dirty = false
      performRender()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('component did not settle')
  }

  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }),
    useRef: (initial) => {
      const at = index++
      if (slots[at] === undefined) slots[at] = { current: initial }
      return slots[at]
    },
    useState: (initial) => {
      const at = index++
      if (slots[at] === undefined) slots[at] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[at]
      const set = (update) => {
        // 无条件标脏：effect 里同步 setState（例如 follow 同步抛错）也要换来一次重渲染。
        slot.value = typeof update === 'function' ? update(slot.value) : update
        dirty = true
      }
      return [slot.value, set]
    },
    useEffect: (callback, deps) => {
      const at = index++
      const next = deps === undefined ? undefined : [...deps]
      const previous = slots[at]
      const skip = previous !== undefined && sameDeps(previous.deps, next)
      slots[at] = { deps: next }
      if (skip) return
      pending.push({ at, callback })
    },
  }

  /** 用给定 props 挂载组件并提交；返回驱动（tree / flush / rerender / unmount）。 */
  const mount = async (Component, props) => {
    // 同一运行时可以多次挂载：先卸掉上一次，否则下面的清理会覆盖它的 cleanup
    // 句柄——展示时钟的 interval 就此泄漏，node --test 结束后进程不再退出。
    for (const previous of [...drivers]) await previous.unmount()
    const driver = {
      get tree() { return tree },
      /** 跑完被 setState 标脏的渲染与 effect（模拟 React 的异步提交）。 */
      flush: async () => { await runEffects() },
      /** 换 props 重渲染（模拟工具块从运行中变成已结算）；仍返回驱动本身。 */
      rerender: async (nextProps) => {
        target = () => ({ type: Component, props: nextProps })
        performRender()
        await runEffects()
        return driver
      },
      /** 卸载：逆序跑每个 effect 的 cleanup。 */
      unmount: async () => {
        for (const cleanup of [...cleanups.values()].reverse()) cleanup()
        cleanups.clear()
        pending = []
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
    }
    target = () => ({ type: Component, props })
    slots.length = 0
    slotBase.clear()
    slotNext = 0
    cleanups.clear()
    pending = []
    dirty = false
    performRender()
    await runEffects()
    drivers.add(driver)
    return driver
  }

  /** 卸载全部已挂载组件并丢弃状态：用例结束不留活流与定时器。 */
  const resetAll = async () => {
    for (const driver of drivers) await driver.unmount()
    drivers.clear()
    slots.length = 0
    cleanups.clear()
    pending = []
    dirty = false
  }

  return { hooks, mount, resetAll }
}

/**
 * 把用例的 hooks 运行时装到模块级委托上，并登记用例结束后的卸载。
 * @param t - node:test 的 TestContext。
 * @returns 与 makeReact 同形。
 */
function useReactRuntime(t) {
  const made = makeReact()
  runtime = made.hooks
  t.after(async () => {
    await made.resetAll()
    runtime = inertHooks()
  })
  return made
}

/** apply 一个只提供给定服务的 fake ctx（座位运行时经 ctx.get 读服务）。 */
function applyWith(services) {
  client.apply({
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (factory) => factory(),
    slots: { inject: () => {}, register: () => () => {} },
    get: (name) => services[name],
  })
}

/**
 * 假 follow：每一路是一个"手动泵"的 async generator。帧由测试经 push 注入，
 * 等待期间只挂 abort 监听器（没有定时器）——卸载/停止必须真的 abort 这一路，
 * 否则残留的 promise 会把测试进程的 event loop 吊住。
 */
function makeRemote({ failWith } = {}) {
  const calls = []
  const follow = (request, signal) => {
    const call = { request, signal, frames: [], wake: null, aborted: false }
    calls.push(call)
    return (async function* stream() {
      if (failWith !== undefined) throw failWith
      while (!signal.aborted) {
        if (call.frames.length > 0) {
          yield call.frames.shift()
          continue
        }
        await new Promise((resolve) => {
          call.wake = resolve
          signal.addEventListener('abort', () => { call.aborted = true; resolve() }, { once: true })
        })
      }
    })()
  }
  /** 给第 at 路推一帧，并等微任务让组件把状态落下去。 */
  const push = async (at, frame) => {
    const call = calls[at]
    assert.notEqual(call, undefined, `no follow call at ${at}`)
    call.frames.push(frame)
    call.wake?.()
    call.wake = null
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { remote: { follow }, calls, push }
}

/** 递归摊平元素树里的文本。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node === 'object' && 'props' in node) textOf(node.props.children, out)
  return out
}

/** 递归找第一个满足谓词的元素。 */
function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!('props' in node)) return undefined
  if (predicate(node)) return node
  return findElement(node.props.children, predicate)
}

/** 单个目录子条目（SubagentListEntry 的 child 分支）。 */
function child(id, { activity = 'running', mode = 'continuable', label } = {}) {
  return { kind: 'child', id, activity, mode, hasChildren: false, ...(label === undefined ? {} : { label }) }
}

/** 本会话那一层目录（subagentsByParent 的一条）。 */
function catalogWith(entries) {
  return { root: { state: 'ready', entries } }
}

/** 运行中的工具块：RunningToolCall 没有 kind 字段，参数在 argsRaw。 */
function runningBlock(ids, { argsRaw } = {}) {
  return {
    callId: 'call-1',
    name: 'wait_subagent',
    argsRaw: argsRaw ?? JSON.stringify({ subagent_id: ids }),
    turn: 1,
    step: 1,
    time: 1,
    subCalls: [],
  }
}

/** 已结算的工具块：ToolResultNode，参数在 call?.argsRaw（窗口截断时 call 为 null）。 */
function settledBlock({ ids = [], result, isError = false, truncated = false } = {}) {
  return {
    kind: 'tool-result',
    seq: 2,
    time: 2,
    callId: 'call-1',
    call: truncated ? null : { name: 'wait_subagent', argsRaw: JSON.stringify({ subagent_id: ids }) },
    content: result === undefined ? [] : [{ type: 'text', text: result }],
    isError,
    subCalls: [],
  }
}

/**
 * 卡片 props：默认走真实词典的中文分支（与 __test.zh 同源），目录选择器是一个
 * 普通函数（组件只在渲染期调用它，与真实 hook 的调用位点同形）。
 */
function cardProps({ block, catalog, sessionId = 'root', toolName = 'wait_subagent', useSessions } = {}) {
  return {
    callId: block.callId ?? 'call-1',
    toolName,
    block,
    sessionId,
    useSessions: useSessions ?? ((selector) => selector({ subagentsByParent: catalog ?? {} })),
    t: (key, params) => {
      const template = zh[key] ?? key
      return params === undefined ? template : template.replace(/\{n\}/g, String(params.n))
    },
  }
}

/** 每行"最后活动 N <秒/分钟/小时>前"的形态（数字由展示时钟决定）。 */
const AGE_LINE = new RegExp(`^${zh.treeLastActive} \\d+ (秒|分钟|小时)前$`)

/**
 * 挂载展开体。折叠/展开由 harness 的通用行（`ToolRow` 的 `{open && children}`）
 * 负责，所以实时行的断言直接打在 `WaitSubagentBody` 上；折叠态本身由下面的
 * 适配器用例钉。
 */
async function mountCardOpen(mount, props) {
  return mount(client.__test.WaitSubagentBody, { ...props, text: props.t, standalone: false })
}

test('卡片：折叠行交给 harness 的通用行——展开体作为 bodyContent 传下去', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote, calls } = makeRemote()
  applyWith({ 'remote.session': remote })

  const catalog = catalogWith([child('a'), child('b')])
  const view = await mount(client.__test.WaitSubagentCard, cardProps({ block: runningBlock(['a', 'b']), catalog }))
  const row = findElement(view.tree, (node) => node.props?.['data-generic-tool-card'] !== undefined)
  assert.notEqual(row, undefined, 'the adapter renders the harness generic row (never its own chrome)')
  assert.equal(row.props['data-generic-tool-card'], 'wait_subagent', 'the row keeps the wire tool name')
  assert.equal(row.props['data-generic-body'], true, 'the live body travels as bodyContent')
  assert.equal(row.props['data-generic-t'], 'function', 'the conversation translator rides along for the row labels')
  // 展开体只在通用行展开时才挂载（ToolRow 的 {open && children}），所以这里尚未开流。
  assert.equal(calls.length, 0, 'nothing subscribes until the harness expands the row')
})

test('卡片：没有通用行导出时降级——摘要与结果仍然可见', async (t) => {
  const { mount } = useReactRuntime(t)
  applyWith({ 'remote.session': {} })

  const running = await mount(client.__test.WaitSubagentBody, {
    ...cardProps({ block: runningBlock(['a', 'b']) }),
    text: (key, params) => (params === undefined ? (zh[key] ?? key) : (zh[key] ?? key).replace(/\{n\}/g, String(params.n))),
    standalone: true,
  })
  assert.equal(textOf(running.tree).join('\n').includes(zh.waitTitleRunning.replace('{n}', '2')), true, 'the fallback renders its own summary line')

  const settled = await mount(client.__test.WaitSubagentBody, {
    ...cardProps({ block: settledBlock({ ids: ['a'], result: 'subagent a done' }) }),
    text: (key, params) => (params === undefined ? (zh[key] ?? key) : (zh[key] ?? key).replace(/\{n\}/g, String(params.n))),
    standalone: true,
  })
  const lines = textOf(settled.tree).join('\n')
  assert.equal(lines.includes(zh.waitTitleSettled.replace('{n}', '1')), true, 'the fallback states the settled summary')
  assert.equal(lines.includes('subagent a done'), true, 'the fallback shows the result itself (no harness OUTPUT section)')
})

test('卡片：运行中为每个 id 开一路流（mode 取目录，查不到按 continuable），推帧落到对应行', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote, calls, push } = makeRemote()
  applyWith({ 'remote.session': remote })

  const catalog = catalogWith([
    child('a', { mode: 'one-shot', label: 'A' }),
    { kind: 'diagnostic', id: 'b', reason: 'corrupt' },
  ])
  const view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a', 'b']), catalog }))

  assert.equal(calls.length, 2, 'each waited id gets its own stream')
  assert.deepEqual(
    calls.map((call) => [call.request.address.parentSessionId, call.request.address.childSessionId, call.request.address.mode, call.request.maxMessages]),
    [['root', 'a', 'one-shot', 4], ['root', 'b', 'continuable', 4]],
  )
  assert.equal(calls.every((call) => call.signal.aborted === false), true)

  const initial = textOf(view.tree)
  assert.equal(initial.join('\n').includes('A'), true, 'label comes from the catalog')
  assert.equal(initial.join('\n').includes('b'), true, 'a diagnostic entry is not a row, so the id stands in for it')
  assert.equal(initial.filter((line) => line === zh.treeLoading).length, 2, 'both rows wait for their first frame')

  // 帧到达 → 该 id 的最后工具/最后一行落到该行，时间走起来。
  await push(0, { type: 'event', event: { type: 'tool/call', seq: 1, time: Date.now(), data: { name: 'rg' } } })
  await push(0, { type: 'event', event: { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text: '正在读 spec' }] } } } })
  // 真实流的第一帧是窗口化开场快照（records 是 { type: 'event', event } 信封），
  // 折叠路径必须同时吃这两种帧。
  await push(1, {
    type: 'snapshot',
    header: {},
    cursor: 2,
    records: [
      { type: 'event', event: { type: 'tool/call', seq: 1, time: Date.now(), data: { name: 'ls' } } },
      { type: 'event', event: { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text: '开场快照' }] } } } },
    ],
    hasMore: false,
  })
  await view.flush()
  const lines = textOf(view.tree)
  assert.equal(lines.includes(`${zh.treeLastTool} rg · 正在读 spec`), true, 'folded tool + last line')
  assert.equal(lines.includes(`${zh.treeLastTool} ls · 开场快照`), true, 'an opening snapshot folds like live frames')
  assert.equal((lines.join('\n').match(/最后活动 \d+ (秒|分钟|小时)前/g) ?? []).length, 2, 'last-active age is rendered per row')
  assert.equal(lines.includes(zh.treeLoading), false, 'both rows left their loading state')

  // 卸载：所有活流 abort。
  await view.unmount()
  assert.equal(calls.every((call) => call.aborted === true), true, 'cleanup aborts every stream')
})

test('卡片：状态只认目录快照，快照里没有这个 id 就不声称状态', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote } = makeRemote()
  applyWith({ 'remote.session': remote })

  // b 的目录条目已经翻成 inactive（快照说了算，即使它那一路流还开着）。
  const catalog = catalogWith([child('a', { label: 'A' }), child('b', { activity: 'inactive', label: 'B' })])
  const view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a', 'b']), catalog }))
  const lines = textOf(view.tree)
  const joinedFirst = lines.join('\n')
  assert.equal(joinedFirst.includes('A'), true)
  assert.equal((joinedFirst.match(new RegExp(zh.treeRunning, 'g')) ?? []).length, 1, 'the catalog-running row claims running')
  assert.equal((joinedFirst.match(new RegExp(zh.treeInactive, 'g')) ?? []).length, 1, 'the snapshot wins over the open stream')
  assert.equal(lines.some((line) => line.startsWith(zh.treeLastTool)), false, 'nothing folded yet')
  await view.unmount()

  // 目录里查不到这个 id：只留中性圆点与 id，不替目录猜 running/inactive。
  const unknown = await mountCardOpen(mount, cardProps({
    block: runningBlock(['a', 'b']),
    catalog: catalogWith([child('a', { activity: 'inactive', label: 'A' })]),
  }))
  const unknownLines = textOf(unknown.tree)
  assert.equal(unknownLines.includes('b'), true, 'the id still renders')
  const joined = unknownLines.join('\n')
  assert.equal(joined.includes(zh.treeRunning), false, 'an open stream is not evidence that the child is running')
  assert.equal(joined.includes(zh.treeInactive), true, 'the id the catalog knows about claims its status')
  assert.equal(unknownLines.includes(zh.treeLoading), true, "the unknown id's stream is still waiting for its first frame")
})

test('卡片：工具结算即 abort 全部流、保留结束前的信息、显示返回文本、不再开新流', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote, calls, push } = makeRemote()
  applyWith({ 'remote.session': remote })

  const catalog = catalogWith([child('a', { label: 'A' })])
  const result = 'subagent a done (completed); its closing message follows as the settlement notice.'
  let view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a']), catalog }))
  await push(0, { type: 'event', event: { type: 'assistant/message', seq: 1, time: Date.now(), data: { message: { content: [{ type: 'text', text: '收尾中' }] } } } })
  await view.flush()
  assert.equal(textOf(view.tree).includes('收尾中'), true)

  view = await view.rerender(cardProps({ block: settledBlock({ ids: ['a'], result }), catalog }))
  assert.equal(calls[0].aborted, true, 'settling releases the stream')
  assert.equal(calls.length, 1, 'settling opens nothing new')
  const lines = textOf(view.tree)
  assert.equal(lines.join('\n').includes('收尾中'), false, 'settling hands the body back to the standard Output card')

  // 目录推送导致的重复渲染也不重开任何一路。
  await view.rerender(cardProps({ block: settledBlock({ ids: ['a'], result }), catalog: catalogWith([child('a', { label: 'A' })]) }))
  assert.equal(calls.length, 1, 'no stream is reopened after settlement')
})

test('卡片：结算后才挂载的历史卡不回放任何流，只显示返回文本', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote, calls } = makeRemote()
  applyWith({ 'remote.session': remote })

  const result = 'timed out waiting for subagent yyy; it is still running.'
  const view = await mountCardOpen(mount, cardProps({
    block: settledBlock({ ids: ['yyy'], result }),
    catalog: catalogWith([child('yyy', { label: 'Y' })]),
  }))
  assert.equal(calls.length, 0, 'a settled card never opens a stream')
  const lines = textOf(view.tree)
  assert.equal(lines.join('\n').includes('Y'), false, 'a settled card renders no live body at all')
})

test('卡片：参数畸形/名单为空时退回朴素行，且不开任何流', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote, calls } = makeRemote()
  applyWith({ 'remote.session': remote })

  // 场景一：参数是截断的 JSON（还在流式写入，或调用头被窗口截断）。
  const broken = await mountCardOpen(mount, cardProps({ block: runningBlock([], { argsRaw: '{"subagent_id": ["a"' }) }))
  const brokenLines = textOf(broken.tree)
  assert.equal(brokenLines.includes('{"subagent_id": ["a"'), true, 'raw args are shown, clamped')
  assert.equal(calls.length, 0, 'malformed args open no stream')
  await broken.unmount()

  // 场景二：subagent_id 是空数组（schema 会拒，但历史日志里可能存在）。
  const empty = await mountCardOpen(mount, cardProps({ block: runningBlock([]) }))
  const emptyLines = textOf(empty.tree)
  assert.equal(emptyLines.includes('{"subagent_id":[]}'), true)
  assert.equal(calls.length, 0, 'an empty list opens no stream')
  await empty.unmount()

  // 场景三：已结算但调用头落在窗口外（call 为 null）——参数拿不到，结果文本仍在。
  const truncated = await mountCardOpen(mount, cardProps({ block: settledBlock({ result: 'unknown subagent "z".', truncated: true }) }))
  const truncatedLines = textOf(truncated.tree)
  assert.equal(calls.length, 0)
})

test('卡片：超过跟随上限的 id 只开 LIMIT 路流，并在卡上说明还有几条未展示', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote, calls } = makeRemote()
  applyWith({ 'remote.session': remote })

  const ids = Array.from({ length: 10 }, (_, index) => `id-${index}`)
  const view = await mountCardOpen(mount, cardProps({ block: runningBlock(ids) }))
  assert.equal(calls.length, 8, 'the stream fan-out is capped')
  assert.deepEqual(calls.map((call) => call.request.address.childSessionId), ids.slice(0, 8))
  const lines = textOf(view.tree).join('\n')
  assert.equal(lines.includes('另有 2 个未展示'), true, 'the cap is stated, not hidden')
})

test('卡片：某一路 follow 失败只标该 id 读取失败，其余流不受影响', async (t) => {
  const { mount } = useReactRuntime(t)
  const calls = []
  const remote = {
    follow: (request, signal) => {
      calls.push({ request, signal, aborted: false })
      if (request.address.childSessionId === 'a') {
        // 同步抛错（网关拒收同形）：也必须折叠成这一路的读取失败。
        throw new Error('gateway refused')
      }
      signal.addEventListener('abort', () => { calls[1].aborted = true })
      return (async function* idle() {
        // 同步登记监听器后立刻补一次检查，避免"abort 先于登记"造成永久挂起。
        while (!signal.aborted) {
          await new Promise((resolve) => {
            signal.addEventListener('abort', resolve, { once: true })
            if (signal.aborted) resolve()
          })
        }
      })()
    },
  }
  applyWith({ 'remote.session': remote })

  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args) }
  try {
    const view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a', 'b']) }))
    // follow 同步抛错发生在 effect 里，错误路径的 setState 也要提交一轮才可见。
    await view.flush()
    const lines = textOf(view.tree)
    assert.equal(lines.includes(zh.treeReadFailed), true, 'failed id shows the read-failed copy')
    assert.equal(lines.includes(zh.treeLoading), true, 'the other id is still waiting for its first frame')
    assert.equal(lines.filter((line) => line === zh.treeReadFailed).length, 1, 'failure stays local to that id')
    assert.equal(lines.includes(zh.treeLiveUnavailable), false, 'a failed stream is not an unavailable service')
    assert.equal(calls.length, 2, 'the other id still has its stream')
    assert.equal(calls[1].aborted, false)
    assert.equal(warnings.some((args) => String(args[0]).includes('follow a')), true)
  } finally {
    console.warn = original
  }
})

test('卡片：follow 不可用时每行显示实时不可用；已结算的卡不声称实时不可用', async (t) => {
  const { mount } = useReactRuntime(t)
  // 场景一：remote.session 整个缺席（包清单没注入 remotes 半边）。
  applyWith({})
  const view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a', 'b']) }))
  const lines = textOf(view.tree)
  assert.equal(lines.filter((line) => line === zh.treeLiveUnavailable).length, 2, 'each row states it')
  assert.equal(lines.includes(zh.treeLoading), false)
  await view.unmount()

  // 场景二：remote.session 存在但没有 follow（网关拒绝这一路能力）。
  const second = useReactRuntime(t)
  applyWith({ 'remote.session': {} })
  const noFollow = await mountCardOpen(second.mount, cardProps({ block: runningBlock(['a']) }))
  assert.equal(textOf(noFollow.tree).includes(zh.treeLiveUnavailable), true)

  // 场景三：已结算的卡本来就不订阅，不该说"实时不可用"。
  const settled = await mountCardOpen(second.mount, cardProps({ block: settledBlock({ ids: ['a'], result: 'done' }) }))
  assert.equal(textOf(settled.tree).includes(zh.treeLiveUnavailable), false)
})

test('卡片：结算先于第一帧到达时不留下永久「加载中」', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote } = makeRemote()
  applyWith({ 'remote.session': remote })

  let view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a']) }))
  assert.equal(textOf(view.tree).includes(zh.treeLoading), true, 'the running row waits for its first frame')

  // 工具在首帧到达前就结算（对早已完成的子代理是常见路径）：pending 标记还在，但
  // 已经没有活流会改写它——结算态继续显示"加载中"就是永久谎报。
  view = await view.rerender(cardProps({ block: settledBlock({ ids: ['a'], result: 'subagent a done' }) }))
  const lines = textOf(view.tree)
  assert.equal(lines.includes(zh.treeLoading), false, 'a settled row never keeps the loading copy')
})

test('卡片：展示时钟只在有"最后活动"可走动时存在，一个不多', async (t) => {
  const { mount } = useReactRuntime(t)
  const created = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => { created.push(args); return realSetInterval(...args) }
  const clockCount = () => created.filter(([, delay]) => delay === 1000).length
  try {
    const { remote, push } = makeRemote()
    applyWith({ 'remote.session': remote })

    // 参数畸形的朴素行：没有可走动的时间戳，不建定时器。
    const fallback = await mountCardOpen(mount, cardProps({ block: runningBlock([]) }))
    assert.equal(clockCount(), 0, 'a plain row has nothing to age')
    await fallback.unmount()

    // 运行中的卡：第一帧之前没有时间戳，不建；帧到达后建一个。
    const view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a']) }))
    assert.equal(clockCount(), 0)
    await push(0, { type: 'event', event: { type: 'assistant/message', seq: 1, time: Date.now(), data: { message: { content: [{ type: 'text', text: '跑起来了' }] } } } })
    await view.flush()
    assert.equal(clockCount(), 1, 'exactly one display clock')
    await view.unmount()
  } finally {
    globalThis.setInterval = realSetInterval
  }
})

test('卡片：流干净收尾即从订阅表释放，下一轮目标变化重新订阅', async (t) => {
  const { mount } = useReactRuntime(t)
  const subscribed = []
  // a 的流立刻干净收尾（服务端关掉这一路）；b 的流保持开启（挂住的 promise 不持有
  // 任何定时器，进程仍会退出）。
  const remote = {
    follow: (request) => {
      const id = request.address.childSessionId
      subscribed.push(id)
      return (async function* stream() {
        if (id === 'a') return
        await new Promise(() => {})
        yield undefined
      })()
    },
  }
  applyWith({ 'remote.session': remote })

  const view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a', 'b']) }))
  assert.deepEqual(subscribed, ['a', 'b'], 'both waited ids opened a stream')
  await view.flush()
  const lines = textOf(view.tree)
  assert.equal(lines.includes('a'), true, 'the row stays after its stream ended')
  assert.equal(lines.filter((line) => line === zh.treeLoading).length, 1, 'only the still-open stream waits for a frame')

  // 目标清单变化（目录给出了 b 的真实 mode）→ 重跑差分：a 那一路已经被释放，
  // 因此重新订阅；b 换了 mode 也必须重开。
  await view.rerender(cardProps({
    block: runningBlock(['a', 'b']),
    catalog: catalogWith([child('b', { mode: 'one-shot', label: 'B' })]),
  }))
  assert.equal(subscribed.filter((id) => id === 'a').length, 2, 'the released stream is re-subscribed by the next diff')
  assert.equal(subscribed.filter((id) => id === 'b').length, 2, 'the mode flip re-opens that target')
})

test('卡片：座位没给 sessionId 时不订阅任何流（契约被破坏也只剩静态行）', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote, calls } = makeRemote()
  applyWith({ 'remote.session': remote })

  // session 作用域的座位一定给 sessionId；给了异常值也不该退化成"用 undefined
  // 当父会话 id 去订阅"。
  const view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a']), sessionId: null }))
  assert.equal(calls.length, 0, 'no parent session id, no stream')
  const lines = textOf(view.tree)
  assert.equal(lines.includes('a'), true)
})

test('卡片：取 follow 属性抛错时只记日志，不开流也不让异常逃出座位', async (t) => {
  const { mount } = useReactRuntime(t)
  // 反射代理在没有注入的服务上取属性会抛：座位必须把它折成"实时不可用"，
  // 而不是让异常逃出 effect（框架的错误边界会摘掉整个座位）。
  const throwing = { get follow() { throw new Error('inject missing') } }
  applyWith({ 'remote.session': throwing })

  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args) }
  try {
    // mount 本身不 reject 就是断言：effect 里的属性访问异常没有逃出去。
    const view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a']) }))
    const lines = textOf(view.tree)
    assert.equal(lines.includes(zh.treeLiveUnavailable), true, 'a rejecting property access reads as live-unavailable')
    assert.equal(warnings.filter((args) => String(args[0]).includes('remote.session')).length >= 1, true, 'the rejected property access is logged')
  } finally {
    console.warn = original
  }
})

test('卡片：useSessions 抛错时按 id 渲染并记日志，不把异常甩给错误边界', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote } = makeRemote()
  applyWith({ 'remote.session': remote })

  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args) }
  try {
    const view = await mountCardOpen(mount, cardProps({
      block: runningBlock(['a']),
      useSessions: () => { throw new Error('store exploded') },
    }))
    // 目录不可用只意味着标签/状态查不到：行仍按 id 渲染，信息仍由流驱动。
    assert.equal(textOf(view.tree).includes('a'), true)
    assert.equal(warnings.some((args) => String(args[0]).includes('catalog selector')), true)
  } finally {
    console.warn = original
  }
})

test('卡片：被 abort 的旧流迟到帧不得改写状态（所有权守卫）', async (t) => {
  const { mount } = useReactRuntime(t)
  const late = []
  const remote = {
    follow: (request, signal) => {
      const id = request.address.childSessionId
      return (async function* stream() {
        if (id !== 'a') { await new Promise(() => {}); return }
        yield { type: 'event', event: { type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'text', text: 'FRESH' }] } } } }
        // 等到被 abort（工具结算）之后，仍然吐一帧迟到内容。
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        late.push('delivered')
        yield { type: 'event', event: { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'STALE' }] } } } }
      })()
    },
  }
  applyWith({ 'remote.session': remote })

  let view = await mountCardOpen(mount, cardProps({ block: runningBlock(['a', 'b']) }))
  assert.equal(textOf(view.tree).includes('FRESH'), true, 'the live frame lands on the row')

  // 目录把 a 的 mode 翻成 continuable → 目标 key 变化，组件 abort 旧的这一路；
  // 旧 generator 随后交付的迟到帧必须被丢弃（子会话 id 不变，守卫失效就会串味）。
  view = await view.rerender(cardProps({ block: runningBlock(['a', 'b']), catalog: catalogWith([child('a', { mode: 'one-shot' }), child('b')]) }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(late.length, 1, 'the stale frame really was produced after the abort')
  // 必须再提交一轮：没有这一步，守卫失效也不会有任何可见差异，断言等于空转。
  await view.flush()
  assert.equal(textOf(view.tree).includes('STALE'), false, 'ownership guard drops the late frame')
  assert.equal(textOf(view.tree).includes('FRESH'), true, 'the surviving stream keeps its folded info')
})

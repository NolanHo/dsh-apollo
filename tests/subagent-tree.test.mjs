/**
 * 浏览器半边（src/client.js）的 node 单测。分两层：
 *
 * 1. 装载层：fake `window.__ModuleLoader__` + fake `require('react')`（模块体只
 *    注册工厂，与真实浏览器加载同构），断言注册契约、locale 词典与包清单注入。
 * 2. 组件层：最小 hooks 运行时（useState/useEffect/useRef，见 makeReact）驱动真实
 *    组件，断言 effect 的行为——流差分、失败标记、abort 清理、展开层声明差分。
 *    这些只在 effect 里发生，纯函数测不到。
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
/** 当前用例共享的 hooks 运行时实例（见 useReactRuntime）。 */
let installed
const react = {
  createElement: (...args) => runtime.createElement(...args),
  useEffect: (...args) => runtime.useEffect(...args),
  useRef: (...args) => runtime.useRef(...args),
  useState: (...args) => runtime.useState(...args),
}

const client = definition.factory((name) => {
  assert.equal(name, 'react')
  return react
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
  assert.deepEqual(client.inject, ['slots', 'locale', 'sessions', 'remote', 'remote.session'])
  assert.deepEqual(Object.keys(client.__test).sort(), [
    'SubagentTreePanel', 'SubagentTreeSeat', 'en', 'foldEvents', 'followRequest', 'formatAge',
    'subscriptionDiff', 'targetKey', 'targetRecords', 'treeRows', 'zh',
  ])
})

test('apply：保留设置页标签，并新增标题栏子代理树座位', () => {
  const { ctx, injected, seats, effects } = makeCtx()
  client.apply(ctx)

  assert.deepEqual(injected, ['settings.plugins.tab', 'conversation.session.header.actions'])

  const settings = seatOf(seats, 'settings.plugins.tab')
  assert.equal(settings.registration.id, 'eng')
  assert.equal(settings.registration.order, 30)
  assert.equal(settings.registration.locale, 'eng-panel')
  assert.equal(typeof settings.component, 'function')

  const tree = seatOf(seats, 'conversation.session.header.actions')
  assert.equal(tree.registration.id, 'eng-subagent-tree')
  assert.equal(tree.registration.order, 40)
  assert.equal(tree.registration.locale, 'eng-panel')
  assert.deepEqual(tree.registration.inject(), {})
  assert.equal(typeof tree.component, 'function')

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
    'treeAgeHours', 'treeAgeMinutes', 'treeAgeSeconds', 'treeButton', 'treeCatalogUnavailable',
    'treeClose', 'treeCollapse', 'treeEmpty', 'treeExpand', 'treeInactive', 'treeLastActive',
    'treeLastTool', 'treeLiveUnavailable', 'treeLoadFailed', 'treeLoading', 'treeReadFailed',
    'treeRunning', 'treeTitle',
  ])
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`)
  }

  // 插值词条必须保留 {n} 占位符，否则档位数字无处可填。
  for (const key of ['treeAgeSeconds', 'treeAgeMinutes', 'treeAgeHours']) {
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
  // 这行清单决定浏览器加载哪些 client 半边：缺 session-controller 就没有
  // sessions 服务（目录不可用），缺 remotes 就没有 remote.session（实时不可用）。
  for (const name of ['@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-remotes']) {
    assert.equal(inject.includes(name), true, `dsh.client.inject missing ${name}`)
  }
  // 座位自身的 inject 必须与之对齐：声明了服务却没有对应包 = 座位拿不到服务。
  assert.deepEqual(client.inject, ['slots', 'locale', 'sessions', 'remote', 'remote.session'])
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
  // 输入。不重置的话，子代理还没产出时面板显示的是父会话的内容。
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

const catalog = {
  root: {
    state: 'ready',
    entries: [
      { kind: 'child', id: 'a', activity: 'running', hasChildren: true, mode: 'continuable', label: 'A' },
      { kind: 'child', id: 'b', activity: 'inactive', hasChildren: false, mode: 'one-shot' },
      { kind: 'diagnostic', id: 'c', reason: 'corrupt' },
    ],
  },
  a: {
    state: 'ready',
    entries: [{ kind: 'child', id: 'a1', activity: 'running', hasChildren: false, mode: 'one-shot', label: 'A1' }],
  },
}

test('treeRows：深度优先摊平，未展开的节点不渲染下一层', () => {
  const collapsed = client.__test.treeRows(catalog, 'root', new Set())
  assert.deepEqual(collapsed.map((row) => [row.id, row.depth]), [['a', 0], ['b', 0]])
  assert.deepEqual(collapsed[0], {
    id: 'a',
    parentSessionId: 'root',
    mode: 'continuable',
    label: 'A',
    activity: 'running',
    hasChildren: true,
    depth: 0,
  })
  assert.equal(collapsed[1].label, undefined)
  assert.equal(collapsed[1].mode, 'one-shot')

  const expanded = client.__test.treeRows(catalog, 'root', ['a'])
  assert.deepEqual(expanded.map((row) => [row.id, row.depth]), [['a', 0], ['a1', 1], ['b', 0]])
  assert.equal(expanded[1].parentSessionId, 'a')
})

test('treeRows：畸形目录不抛，损坏的自环不递归失控', () => {
  const { treeRows } = client.__test
  assert.deepEqual(treeRows(undefined, 'root', []), [])
  assert.deepEqual(treeRows(null, 'root', []), [])
  assert.deepEqual(treeRows({ root: { entries: 'nope' } }, 'root', []), [])
  assert.deepEqual(treeRows({ root: { entries: [null, 3, { kind: 'child' }, { kind: 'child', id: '' }] } }, 'root', []), [])

  const cyclic = {
    root: { entries: [{ kind: 'child', id: 'root', activity: 'running', hasChildren: true, mode: 'one-shot' }] },
  }
  assert.deepEqual(treeRows(cyclic, 'root', ['root']).map((row) => row.id), ['root'])
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
  // 稳态：目录里其它节点 activity 翻转导致的重复执行不重开任何一路。
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
  // 不减（同一用例里座位与它嵌的面板是两个函数，不能都从 0 起）。
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
      /** 换 props 重渲染（模拟 store 推送后父组件重渲染）；仍返回驱动本身。 */
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

/** fake sessions 服务：记录 declare/refresh/open 调用。 */
function makeSessions(calls = []) {
  return {
    setSubagentCatalogOpen: (parentSessionId, open) => { calls.push(['declare', parentSessionId, open]) },
    refreshSubagents: (parentSessionId) => { calls.push(['refresh', parentSessionId]); return Promise.resolve() },
    openSubagent: (address) => { calls.push(['open', address.childSessionId]) },
  }
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

/** 收集所有满足谓词的元素（顺序即遍历顺序）。 */
function findAllElements(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAllElements(child, predicate, out)
    return out
  }
  if (!('props' in node)) return out
  if (predicate(node)) out.push(node)
  findAllElements(node.props.children, predicate, out)
  return out
}

/** 面板 props：默认走真实词典的中文分支（与 __test.zh 同源）。 */
function panelProps({ tree = {}, catalogUnavailable = false, sessionId = 'root' } = {}) {
  return {
    sessionId,
    catalog: tree,
    catalogUnavailable,
    text: (key, params) => {
      const template = zh[key] ?? key
      return params === undefined ? template : template.replace(/\{n\}/g, String(params.n))
    },
    onClose: () => {},
  }
}

/** 每次都新建引用：模拟 store 推送产生的新快照对象。 */
function twoRunningCatalog({ a = 'running', b = 'running', extra = [] } = {}) {
  return {
    root: {
      state: 'ready',
      entries: [
        { kind: 'child', id: 'a', activity: a, hasChildren: true, mode: 'one-shot', label: 'A' },
        { kind: 'child', id: 'b', activity: b, hasChildren: false, mode: 'continuable', label: 'B' },
        ...extra,
      ],
    },
  }
}

test('组件：只对 running 节点开流，节点停转只 abort 那一路', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote, calls, push } = makeRemote()
  applyWith({ sessions: makeSessions(), 'remote.session': remote })

  const view = await mount(client.__test.SubagentTreePanel, panelProps({ tree: twoRunningCatalog() }))
  assert.equal(calls.length, 2, 'each running node gets its own stream')
  assert.deepEqual(
    calls.map((call) => [call.request.address.childSessionId, call.request.address.mode, call.request.maxMessages]),
    [['a', 'one-shot', 4], ['b', 'continuable', 4]],
  )
  assert.equal(calls.every((call) => call.signal.aborted === false), true)

  // 帧到达 → 该节点的最后工具/最后一行落到渲染里。
  await push(0, { type: 'event', event: { type: 'tool/call', seq: 1, time: Date.now(), data: { name: 'rg' } } })
  await push(0, { type: 'event', event: { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text: '正在读 spec' }] } } } })
  await view.flush()
  const lines = textOf(view.tree)
  assert.equal(lines.includes(`${zh.treeLastTool} rg · 正在读 spec`), true, 'folded tool + last line')

  // a 停转（目录推送翻转 activity）：只 abort a 那一路，b 原样保留。
  await view.rerender(panelProps({ tree: twoRunningCatalog({ a: 'inactive' }) }))
  assert.equal(calls.length, 2, 'no stream was reopened')
  assert.equal(calls[0].aborted, true, 'stopped node aborted')
  assert.equal(calls[1].aborted, false, 'untouched node kept its stream')

  // 与流无关的目录变化（多一个 inactive 节点）不重开任何一路。
  const before = calls.length
  await view.rerender(panelProps({
    tree: twoRunningCatalog({
      a: 'inactive',
      extra: [{ kind: 'child', id: 'c', activity: 'inactive', hasChildren: false, mode: 'one-shot' }],
    }),
  }))
  assert.equal(calls.length, before)

  // 卸载：所有活流 abort。
  await view.unmount()
  assert.equal(calls.every((call) => call.aborted === true), true, 'cleanup aborts every stream')
})

test('组件：某一路 follow 失败只标该节点读取失败，其余流不受影响', async (t) => {
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
  applyWith({ sessions: makeSessions(), 'remote.session': remote })

  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args) }
  try {
    const view = await mount(client.__test.SubagentTreePanel, panelProps({ tree: twoRunningCatalog() }))
    // follow 同步抛错发生在 effect 里，错误路径的 setState 也要提交一轮才可见。
    await view.flush()
    const lines = textOf(view.tree)
    assert.equal(lines.includes(zh.treeReadFailed), true, 'failed node shows the read-failed copy')
    assert.equal(lines.includes(zh.treeLoading), true, 'the other node is still waiting for its first frame')
    assert.equal(lines.filter((line) => line === zh.treeReadFailed).length, 1, 'failure stays local to that node')
    assert.equal(lines.includes(zh.treeLiveUnavailable), false, 'a failed stream is not an unavailable service')
    assert.equal(calls.length, 2, 'the other node still has its stream')
    assert.equal(calls[1].aborted, false)
    assert.equal(warnings.some((args) => String(args[0]).includes('follow a')), true)
  } finally {
    console.warn = original
  }
})

test('组件：follow 不可用时 running 行显示实时不可用，留白不冒充"还没有事件"', async (t) => {
  const { mount } = useReactRuntime(t)
  // 场景一：remote.session 整个缺席（包清单没注入 remotes 半边）。
  applyWith({ sessions: makeSessions() })
  const view = await mount(client.__test.SubagentTreePanel, panelProps({ tree: twoRunningCatalog() }))
  const lines = textOf(view.tree)
  assert.equal(lines.filter((line) => line === zh.treeLiveUnavailable).length, 2, 'each running row states it')
  assert.equal(lines.includes(zh.treeEmpty), false)

  // 场景二：remote.session 存在但没有 follow（网关拒绝这一路能力）。
  const second = useReactRuntime(t)
  applyWith({ sessions: makeSessions(), 'remote.session': {} })
  const noFollow = await second.mount(client.__test.SubagentTreePanel, panelProps({ tree: twoRunningCatalog() }))
  assert.equal(textOf(noFollow.tree).includes(zh.treeLiveUnavailable), true)
})

test('组件：展开层的 state 决定该层子节点显示读取失败/加载中，不等根层', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote } = makeRemote()
  applyWith({ sessions: makeSessions(), 'remote.session': remote })

  const tree = {
    root: {
      state: 'ready',
      entries: [{ kind: 'child', id: 'a', activity: 'inactive', hasChildren: true, mode: 'one-shot', label: 'A' }],
    },
    a: { state: 'error', entries: [] },
  }
  let view = await mount(client.__test.SubagentTreePanel, panelProps({ tree }))
  const toggle = findElement(view.tree, (node) => node.type === 'button' && node.props.title === zh.treeExpand)
  assert.notEqual(toggle, undefined)
  toggle.props.onClick()
  view = await view.rerender(panelProps({ tree: { ...tree, a: { state: 'error', entries: [] } } }))
  assert.equal(textOf(view.tree).includes(zh.treeLoadFailed), true, 'deep level error is rendered for that level')
  assert.equal(textOf(view.tree).includes(zh.treeEmpty), false, 'the root is ready, so the empty copy is wrong')

  view = await view.rerender(panelProps({ tree: { ...tree, a: { state: 'loading', entries: [] } } }))
  assert.equal(textOf(view.tree).includes(zh.treeLoading), true, 'deep level loading is visible too')
})

test('组件：展开声明按差分，根层只由面板 effect 声明一次', async (t) => {
  const { mount } = useReactRuntime(t)
  const { remote } = makeRemote()
  const calls = []
  applyWith({ sessions: makeSessions(calls), 'remote.session': remote })

  // a 与 c 都可展开：展开第二个层时不得释放/重声明第一个（差分的记忆必须跨
  // 依赖变化存活——把释放写回普通 effect 的 cleanup 会让这里重新声明 a）。
  const catalog = () => twoRunningCatalog({
    extra: [{ kind: 'child', id: 'c', activity: 'inactive', hasChildren: true, mode: 'one-shot', label: 'C' }],
  })
  let view = await mount(client.__test.SubagentTreePanel, panelProps({ tree: catalog() }))
  // 面板打开即声明根层一次（且只此一次）。
  assert.deepEqual(calls.filter((call) => call[0] === 'declare'), [['declare', 'root', true]])
  assert.deepEqual(calls.filter((call) => call[0] === 'refresh'), [['refresh', 'root']])

  // 展开 a：只声明 a 并拉一次 a，不重声明根层、不释放东西。
  const isToggle = (node) => node.type === 'button' && (node.props.title === zh.treeExpand || node.props.title === zh.treeCollapse)
  const toggles = findAllElements(view.tree, isToggle)
  assert.equal(toggles.length, 2, 'a and c render expand toggles')
  toggles[0].props.onClick()
  view = await view.rerender(panelProps({ tree: catalog() }))
  assert.deepEqual(calls.filter((call) => call[0] === 'declare' && call[1] === 'a'), [['declare', 'a', true]])
  assert.deepEqual(calls.filter((call) => call[0] === 'refresh' && call[1] === 'a'), [['refresh', 'a']])
  assert.deepEqual(calls.filter((call) => call[2] === false), [], 'expanding releases nothing')

  // 再展开 c：a 必须原样保留（不释放、不重声明、不重拉）。
  const second = findAllElements(view.tree, isToggle)
  assert.equal(second.length, 2, 'both rows still expose their toggle')
  second[1].props.onClick()
  view = await view.rerender(panelProps({ tree: catalog() }))
  assert.deepEqual(calls.filter((call) => call[0] === 'declare' && call[1] === 'c'), [['declare', 'c', true]])
  assert.deepEqual(calls.filter((call) => call[2] === false), [], 'expanding c releases nothing')
  assert.equal(calls.filter((call) => call[0] === 'declare' && call[1] === 'a').length, 1, 'a is not re-declared')
  assert.equal(calls.filter((call) => call[0] === 'refresh' && call[1] === 'a').length, 1, 'a is not re-fetched')

  // 目录推送导致的重渲染不重复声明已声明的层。
  await view.rerender(panelProps({ tree: catalog() }))
  assert.equal(calls.filter((call) => call[0] === 'declare' && call[1] === 'a').length, 1, 'no duplicate declaration')
  assert.equal(calls.filter((call) => call[0] === 'declare' && call[1] === 'root').length, 1, 'root declared exactly once')

  // 卸载：收起已声明的展开层，根层的释放也只有一次。
  await view.unmount()
  assert.equal(calls.filter((call) => call[0] === 'declare' && call[1] === 'root' && call[2] === false).length, 1)
  assert.equal(calls.filter((call) => call[0] === 'declare' && call[1] === 'a' && call[2] === false).length, 1)
  assert.equal(calls.filter((call) => call[0] === 'declare' && call[1] === 'c' && call[2] === false).length, 1)
})

test('组件：流自然收尾即释放订阅，下一次目录推送重新订阅', async (t) => {
  const { mount } = useReactRuntime(t)
  const subscribed = []
  // a 的流立刻自然收尾（子代理结束）；b 的流保持开启（挂住的 promise 不持有
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
  applyWith({ sessions: makeSessions(), 'remote.session': remote })

  const view = await mount(client.__test.SubagentTreePanel, panelProps({ tree: twoRunningCatalog() }))
  assert.deepEqual(subscribed, ['a', 'b'], 'both running nodes opened a stream')
  // a 已经收尾：只有它那一路被从订阅表里删掉，下一轮目录推送才会重新订阅它。
  await view.rerender(panelProps({ tree: twoRunningCatalog() }))
  assert.equal(subscribed.filter((id) => id === 'a').length, 2, 'a is re-subscribed after its stream ended')
  assert.equal(subscribed.filter((id) => id === 'b').length, 1, 'b keeps its single live stream')
})

test('组件：被 abort 的旧流迟到帧不得改写状态（所有权守卫）', async (t) => {
  const { mount } = useReactRuntime(t)
  const late = []
  const remote = {
    follow: (request, signal) => {
      const id = request.address.childSessionId
      return (async function* stream() {
        if (id !== 'a') { await new Promise(() => {}); return }
        yield { type: 'event', event: { type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'text', text: 'FRESH' }] } } } }
        // 等到被 abort（a 停转）之后，仍然吐一帧迟到内容。
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        late.push('delivered')
        yield { type: 'event', event: { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'STALE' }] } } } }
      })()
    },
  }
  applyWith({ sessions: makeSessions(), 'remote.session': remote })

  let view = await mount(client.__test.SubagentTreePanel, panelProps({ tree: twoRunningCatalog() }))
  assert.equal(textOf(view.tree).includes('FRESH'), true, 'the live frame lands on the row')

  // a 停转 → 组件 abort 这一路；旧 generator 随后交付的迟到帧必须被丢弃。
  view = await view.rerender(panelProps({ tree: twoRunningCatalog({ a: 'inactive' }) }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(late.length, 1, 'the stale frame really was produced after the abort')
  // 必须再提交一轮：没有这一步，守卫失效也不会有任何可见差异，断言等于空转。
  await view.flush()
  assert.equal(textOf(view.tree).includes('STALE'), false, 'ownership guard drops the late frame')
})

test('座位：useSessions 抛错/缺席时显示目录不可用，不冒充暂无子代理', async (t) => {
  const { mount } = useReactRuntime(t)
  applyWith({})

  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args) }
  try {
    const throwing = { sessionId: 'root', useSessions: () => { throw new Error('store exploded') }, t: (key) => zh[key] ?? key }
    let view = await mount(client.__test.SubagentTreeSeat, throwing)
    assert.equal(textOf(view.tree).includes(zh.treeButton), true, 'the button still renders')

    const button = findElement(view.tree, (node) => node.type === 'button' && node.props.title === zh.treeTitle)
    assert.notEqual(button, undefined)
    button.props.onClick()
    view = await view.rerender(throwing)
    const lines = textOf(view.tree)
    assert.equal(lines.includes(zh.treeCatalogUnavailable), true)
    assert.equal(lines.includes(zh.treeEmpty), false, 'unavailable catalog must not read as empty')
    assert.equal(warnings.length >= 1, true, 'the selector failure is logged')
  } finally {
    console.warn = original
  }

  // props.useSessions 缺席同样算目录不可用，且不抛。
  const seatProps = { sessionId: 'root', t: (key) => zh[key] ?? key }
  const view = await mount(client.__test.SubagentTreeSeat, seatProps)
  const open = findElement(view.tree, (node) => node.type === 'button' && node.props.title === zh.treeTitle)
  open.props.onClick()
  await view.rerender(seatProps)
  assert.equal(textOf(view.tree).includes(zh.treeCatalogUnavailable), true)
})

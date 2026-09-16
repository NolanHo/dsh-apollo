/**
 * wait-subagent 单元测试：数组入参契约、正常等待、已完成快路径、刚派发未启动
 * 的宽限等待、宽限超时、用户超时、错误收场、非直接子代理 fail-fast、单 id 等待、
 * 多 id first-completion（任一结算即返回 + still running 指引 + 二次调用续等）、
 * 同 tick 批量完成、10 分钟硬上限与 clamp、去重、不动父代理 inbox。
 * 以 fake ctx 直接驱动 apply 注册的 subagent/end 监听器与 wait_subagent 工具。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject } from '../presets/eng/plugins/wait-subagent/index.js'

/** 构造 fake ctx：捕获事件处理器与注册的工具，注入可控行的 agents/subagents。 */
function makeCtx({ children = [] } = {}) {
  const handlers = new Map()
  const agentStatus = new Map()
  let tool
  const ctx = {
    handlers,
    agentStatus,
    on: (event, fn) => handlers.set(event, fn),
    subagents: { listChildren: async () => children },
    agents: { get: (id) => agentStatus.get(id) },
    tools: { register: (definition) => { tool = definition } },
  }
  apply(ctx)
  ctx.getTool = () => tool
  return ctx
}

/** 每个用例独立的 exec（parent agent 可携带 inbox）。 */
function makeExec(inbox) {
  return { agent: { id: 'parent-1', inbox } }
}

/** 可控的 AbortSignal 替身：只关心 abort 监听的注册/解绑账目。 */
function makeSignal() {
  const listeners = new Set()
  return {
    aborted: false,
    listeners,
    addEventListener: (event, fn) => {
      if (event === 'abort') listeners.add(fn)
    },
    removeEventListener: (event, fn) => {
      if (event === 'abort') listeners.delete(fn)
    },
    abort: () => {
      for (const fn of [...listeners]) fn()
    },
  }
}

/** 让 execute 走过首个 await（listChildren），到达等待注册点。 */
async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** 触发一次 subagent/end。 */
function fireEnd(ctx, info) {
  const handler = ctx.handlers.get('subagent/end')
  assert.equal(typeof handler, 'function', 'apply 应注册 subagent/end 监听器')
  handler(info)
}

const DONE = (id, stop = 'completed') =>
  `subagent ${id} done (${stop}); its closing message follows as the settlement notice.`

/** first-completion 提前返回时的收尾行：列出仍在跑的 id。 */
const STILL = (...ids) =>
  `still running: ${ids.join(', ')} — call wait_subagent again with them to wait for the next one; you will also be notified when each finishes.`

test('插件契约：name / inject / 工具注册（subagent_id 为数组）', () => {
  assert.equal(name, 'tool-wait-subagent')
  assert.deepEqual(inject, ['tools', 'subagents', 'agents'])
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  const tool = ctx.getTool()
  assert.equal(tool.name, 'wait_subagent')
  assert.deepEqual(tool.parameters.required, ['subagent_id'])
  assert.equal(tool.parameters.properties.subagent_id.type, 'array')
  assert.equal(tool.parameters.properties.subagent_id.items.type, 'string')
  assert.equal(tool.parameters.properties.subagent_id.minItems, 1)
  assert.equal(tool.isConcurrencySafe(), true)
})

test('运行中的子代理完成 → 返回短 done 行，不含子代理消息内容', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '扫描完成：3 个入口', stopReason: 'completed' })
  const out = await pending
  assert.equal(out, DONE('child-1'))
  // 内容交还框架 settlement notice，工具结果本身不携带。
  assert.ok(!out.includes('扫描完成'))
})

test('非直接子代理 → unknown 提示，不等待', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  const out = await ctx.getTool().execute({ subagent_id: ['stranger'] }, makeExec())
  assert.match(out, /unknown subagent "stranger"/)
})

test('批量含非直接子代理 → 列出全部未知 id，立即 fail-fast 不等待', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  // stranger 与 ghost 都不是直接子代理：直接返回，child-1 不被等待
  //（返回发生在任何 fireEnd 之前）。
  const out = await ctx.getTool().execute({ subagent_id: ['child-1', 'stranger', 'ghost'] }, makeExec())
  assert.match(out, /unknown subagent "stranger", "ghost"/)
  assert.ok(!out.includes('child-1 done'))
})

test('本轮早已完成的子代理（idle + 已有 settlement）→ 立即返回 done 行', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: [{ type: 'text', text: '早前已完成' }], stopReason: 'completed' })
  ctx.agentStatus.set('child-1', { status: 'idle' })
  const out = await ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  assert.equal(out, DONE('child-1'))
})

test('刚派发、尚未启动的子代理 → 宽限等待其启动并完成，不再误报 not running（竞态修复）', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  // 尚未注册进 agents（status 视为 ready），也无 settlement —— 旧实现会立刻
  // 返回 "is not running" 导致回合早退；新实现等它启动。
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  await flushMicrotasks()
  ctx.agentStatus.set('child-1', { status: 'running' })
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '竞态场景下的结果', stopReason: 'completed' })
  assert.equal(await pending, DONE('child-1'))
})

test('宽限期内子代理始终未启动 → 返回可重试的 not-started 提示', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  await flushMicrotasks()
  t.mock.timers.tick(31_000)
  const out = await pending
  assert.match(out, /has not started after 30s/)
  assert.match(out, /status: ready/)
  assert.match(out, /wait_subagent again/)
})

test('等待已启动子代理时用户 timeout_ms 到期 → timed out 提示', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'], timeout_ms: 5000 }, makeExec())
  await flushMicrotasks()
  t.mock.timers.tick(5000)
  const out = await pending
  assert.match(out, /timed out waiting for subagent child-1/)
})

test('子代理以 error 收场 → done 行标注 error stopReason，内容仍在框架通知', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: 'Model not found', stopReason: 'error' })
  const out = await pending
  assert.equal(out, DONE('child-1', 'error'))
  assert.ok(!out.includes('Model not found'))
})

test('first-completion：任一 id 结算即返回，不等同批其它 id，并列出 still running', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  ctx.agentStatus.set('child-2', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1', 'child-2'] }, makeExec())
  await flushMicrotasks()
  // child-2 先结算：旧 barrier 语义会继续等 child-1，first-completion 立即返回。
  fireEnd(ctx, { id: 'child-2', lastAssistantMessage: '二号线结果', stopReason: 'completed' })
  const out = await pending
  assert.equal(out, `${DONE('child-2')}\n${STILL('child-1')}`)
})

test('first-completion 后带上剩余 id 再调一次 → 等到它结算，无 still running 行', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  ctx.agentStatus.set('child-2', { status: 'running' })
  const first = ctx.getTool().execute({ subagent_id: ['child-1', 'child-2'] }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '一号结果', stopReason: 'completed' })
  assert.equal(await first, `${DONE('child-1')}\n${STILL('child-2')}`)

  // 第二次调用（调用方按指引带上剩余 id）：child-2 仍在跑，等到它结算。
  const second = ctx.getTool().execute({ subagent_id: ['child-2'] }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-2', lastAssistantMessage: '二号结果', stopReason: 'completed' })
  assert.equal(await second, DONE('child-2'))
})

test('同 tick 批量完成：连续两次 fireEnd → 两行 done，无 still running 行', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  ctx.agentStatus.set('child-2', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1', 'child-2'] }, makeExec())
  await flushMicrotasks()
  // 同一 tick 内先后结算：第二次结算在 execute 的 await 续体之前落地，必须在
  // 同一个结果里报告，不逼调用方再空调一次。
  fireEnd(ctx, { id: 'child-2', lastAssistantMessage: '二号线结果', stopReason: 'completed' })
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '一号结果', stopReason: 'completed' })
  const out = await pending
  assert.equal(out, `${DONE('child-1')}\n${DONE('child-2')}`)
  assert.ok(!out.includes('still running:'))
})

test('一个结算一个仍在跑：settle 即返回，不等到窗口到期（混合收场）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  ctx.agentStatus.set('child-2', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1', 'child-2'], timeout_ms: 5000 }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '快的结果', stopReason: 'completed' })
  const out = await pending
  assert.equal(out, `${DONE('child-1')}\n${STILL('child-2')}`)
  // 提前返回发生在窗口到期之前：没有 timed out 行。
  assert.ok(!out.includes('timed out'))
  // 返回后共享窗口的 timer 已被清理：再推进时钟不再产生任何结果。
  t.mock.timers.tick(5000)
  assert.equal(await pending, out)
})

test('不传 timeout_ms → 10 分钟硬上限：tick 600_000 后全部 timed out', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  ctx.agentStatus.set('child-2', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1', 'child-2'] }, makeExec())
  await flushMicrotasks()
  t.mock.timers.tick(600_000)
  const out = await pending
  const lines = out.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /timed out waiting for subagent child-1/)
  assert.match(lines[1], /timed out waiting for subagent child-2/)
  assert.ok(!out.includes('still running:'))
})

test('clamp：timeout_ms 超过硬上限 → 600_000 即到期（不按 600_500 等）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'], timeout_ms: 600_500 }, makeExec())
  await flushMicrotasks()
  // 未 clamp 的话 600_500 的 timer 还没到期，这里会挂住。
  t.mock.timers.tick(600_000)
  assert.match(await pending, /timed out waiting for subagent child-1/)
})

test('timeout_ms 为 0 / 负数 / 非数字 → 视同不传，沿用 600_000 硬上限', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  for (const value of [0, -1, 'soon']) {
    const ctx = makeCtx({ children: [{ id: 'child-1' }] })
    ctx.agentStatus.set('child-1', { status: 'running' })
    const pending = ctx.getTool().execute({ subagent_id: ['child-1'], timeout_ms: value }, makeExec())
    await flushMicrotasks()
    t.mock.timers.tick(600_000)
    assert.match(await pending, /timed out waiting for subagent child-1/, `timeout_ms=${String(value)}`)
  }
})

test('重复 id 去重：同 id 传两次只出一行', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1', 'child-1'] }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '结果', stopReason: 'completed' })
  assert.equal(await pending, DONE('child-1'))
})

test('收场时不做 inbox 手术：父代理 pending 队列原样保留（内容由框架投递）', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const spliced = []
  // 框架在 subagent/end 之前已把 settlement notice steer 进运行中父代理的
  // next-step（0.1.2-alpha.4 起 report 被 send_message 取代，kind 为
  // agent-message）。wait_subagent 只回 done 行，pending 消息一条都不动。
  const inbox = {
    nextStep: [
      { source: { kind: 'subagent-settled', senderSessionId: 'child-2' } },
      { source: { kind: 'agent-message', senderSessionId: 'child-1' } },
      { source: { kind: 'subagent-settled', senderSessionId: 'child-1' } },
    ],
    nextTurn: [],
    splice: (queue, index, count, items) => {
      spliced.push({ queue, index, count })
      const arr = queue === 'next-step' ? inbox.nextStep : inbox.nextTurn
      arr.splice(index, count, ...(items ?? []))
    },
  }
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec(inbox))
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '结果', stopReason: 'completed' })
  assert.equal(await pending, DONE('child-1'))
  // 零 splice：通知与 mid-run 消息全部留给框架投递。
  assert.deepEqual(spliced, [])
  assert.equal(inbox.nextStep.length, 3)
})

test('first-completion 提前返回即清理：abort 监听解绑，返回后的事件不再影响结果', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  ctx.agentStatus.set('child-2', { status: 'running' })
  const signal = makeSignal()
  const tool = ctx.getTool()
  const pending = tool.execute({ subagent_id: ['child-1', 'child-2'] }, { agent: { id: 'parent-1' }, signal })
  await flushMicrotasks()
  assert.equal(signal.listeners.size, 1, '等待期间应挂上 abort 监听')
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '一号结果', stopReason: 'completed' })
  const out = await pending
  assert.equal(out, `${DONE('child-1')}\n${STILL('child-2')}`)
  // 提前返回后：abort 监听已解绑（未被等到的 id 也不会留下监听）。
  assert.equal(signal.listeners.size, 0)
  // 之后 child-2 自己结算：不再属于这次等待，结果不变。
  fireEnd(ctx, { id: 'child-2', lastAssistantMessage: '二号结果', stopReason: 'completed' })
  assert.equal(await pending, out)
})

test('abort：全部标 aborted → 折叠单行，监听解绑', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  ctx.agentStatus.set('child-2', { status: 'running' })
  const signal = makeSignal()
  const pending = ctx.getTool().execute({ subagent_id: ['child-1', 'child-2'] }, { agent: { id: 'parent-1' }, signal })
  await flushMicrotasks()
  signal.aborted = true
  signal.abort()
  assert.equal(await pending, 'wait for 2 subagents was aborted by user interruption; the children may still be running.')
  assert.equal(signal.listeners.size, 0)
})

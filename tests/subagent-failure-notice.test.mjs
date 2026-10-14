/**
 * subagent-failure-notice 单元测试：失败原因提取、两条捕获路径、投放口径与
 * 静默边界。以 fake ctx 直接驱动 apply 注册的三个监听器。
 *
 * 覆盖的核心契约：框架的 `subagent/end` 只给 stopReason，父代理拿不到失败原因；
 * 本插件必须把子代理会话日志里 `turn/end.reason.error` 的 LlmFailure 作为一条
 * notice 推给直接父代理，且只在 `stopReason === 'error'` 时推。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name } from '../presets/eng/plugins/subagent-failure-notice/index.js'

const RATE_LIMIT = {
  message: '429: {"code":"1317","message":"已达到7天使用上限"}',
  code: 'RATE_LIMIT',
  status: 429,
  requestId: 'req-1317',
}

/** 子代理 Agent 假体：只暴露插件读取的 session.header 与日志。 */
function childAgent(id, parentId, turnEndReason) {
  return {
    id,
    session: {
      header: { id, parentSession: parentId },
      snapshotEvents: () => (turnEndReason === undefined
        ? [{ type: 'turn/start', data: { turn: 1 } }]
        : [
            { type: 'turn/start', data: { turn: 1 } },
            { type: 'turn/end', data: { turn: 1, reason: turnEndReason } },
          ]),
    },
  }
}

/** 父代理假体：记录 followup / steer 收到的消息。 */
function parentAgent(id, status = 'idle') {
  const delivered = { followup: [], steer: [] }
  return {
    id,
    status,
    delivered,
    followup(message) { delivered.followup.push(message) },
    steer(message) { delivered.steer.push(message) },
  }
}

/** 构造 fake ctx：捕获监听器，注入可控的 agents 注册表。 */
function makeCtx(live) {
  const handlers = new Map()
  const warnings = []
  return {
    handlers,
    warnings,
    on: (event, fn) => handlers.set(event, fn),
    agents: { get: (id) => live.get(id) },
    logger: { warn: (text) => warnings.push(text) },
  }
}

/** 文本化一条投放消息的正文与 source。 */
function textOf(message) {
  return message.content.map((block) => block.text).join('\n')
}

test('模块导出 name 与 apply', () => {
  assert.equal(name, 'eng-subagent-failure-notice')
  assert.equal(typeof apply, 'function')
})

test('失败子代理的日志原因被推给空闲父代理', () => {
  const parent = parentAgent('parent')
  const child = childAgent('child', 'parent', { kind: 'error', error: RATE_LIMIT })
  const live = new Map([['child', child], ['parent', parent]])
  const ctx = makeCtx(live)
  apply(ctx)

  ctx.handlers.get('subagent/start')({ id: 'child', runId: 'run', provider: 'spawn' })
  ctx.handlers.get('subagent/end')({ id: 'child', runId: 'run', provider: 'spawn', stopReason: 'error' })

  assert.equal(parent.delivered.followup.length, 1, '空闲父代理走 followup')
  assert.equal(parent.delivered.steer.length, 0)
  const message = parent.delivered.followup[0]
  const text = textOf(message)
  assert.match(text, /Background subagent child failed before it finished\./)
  assert.match(text, /code: RATE_LIMIT/)
  assert.match(text, /status: 429/)
  assert.match(text, /requestId: req-1317/)
  assert.match(text, /已达到7天使用上限/)
  assert.equal(message.source.kind, 'plugin:eng-subagent-failure-notice')
  assert.equal(message.source.form, 'notice')
  assert.match(message.source.summary, /RATE_LIMIT/)
  assert.deepEqual(ctx.warnings, [], '成功投放不应告警')
})

test('运行中的父代理走 steer 而不是 followup', () => {
  const parent = parentAgent('parent', 'running')
  const child = childAgent('child', 'parent', { kind: 'error', error: RATE_LIMIT })
  const live = new Map([['child', child], ['parent', parent]])
  const ctx = makeCtx(live)
  apply(ctx)

  ctx.handlers.get('subagent/start')({ id: 'child' })
  ctx.handlers.get('subagent/end')({ id: 'child', stopReason: 'error' })

  assert.equal(parent.delivered.steer.length, 1)
  assert.equal(parent.delivered.followup.length, 0)
})

test('agent/error 兜底：start 取不到 Agent 时仍能补上原因', () => {
  const parent = parentAgent('parent')
  const child = { ...childAgent('child', 'parent', undefined), id: 'child' }
  // start 时子代理尚未在注册表可见 —— 日志路径不可用。
  const live = new Map([['parent', parent]])
  const ctx = makeCtx(live)
  apply(ctx)

  ctx.handlers.get('subagent/start')({ id: 'child' })
  live.set('child', child)
  ctx.handlers.get('agent/error')({ agent: child, turn: 1, step: 1, error: { failure: RATE_LIMIT } })
  ctx.handlers.get('subagent/end')({ id: 'child', stopReason: 'error' })

  assert.equal(parent.delivered.followup.length, 1)
  assert.match(textOf(parent.delivered.followup[0]), /code: RATE_LIMIT/)
})

test('顶层会话的 agent/error 不记录、不投放', () => {
  const root = { id: 'root', session: { header: { id: 'root' }, snapshotEvents: () => [] } }
  const live = new Map([['root', root]])
  const ctx = makeCtx(live)
  apply(ctx)

  ctx.handlers.get('agent/error')({ agent: root, turn: 1, step: 1, error: new Error('boom') })
  ctx.handlers.get('subagent/end')({ id: 'root', stopReason: 'error' })

  assert.deepEqual(ctx.warnings, [])
})

test('非 error 的结算不推原因通知', () => {
  for (const stopReason of ['completed', 'aborted', 'max-tokens', 'refusal']) {
    const parent = parentAgent('parent')
    const child = childAgent('child', 'parent', { kind: 'error', error: RATE_LIMIT })
    const live = new Map([['child', child], ['parent', parent]])
    const ctx = makeCtx(live)
    apply(ctx)

    ctx.handlers.get('subagent/start')({ id: 'child' })
    ctx.handlers.get('subagent/end')({ id: 'child', stopReason })

    assert.equal(parent.delivered.followup.length, 0, `${stopReason} 不应投放`)
    assert.equal(parent.delivered.steer.length, 0, `${stopReason} 不应投放`)
  }
})

test('父代理已不在注册表时告警而不抛错', () => {
  const child = childAgent('child', 'gone', { kind: 'error', error: RATE_LIMIT })
  const live = new Map([['child', child]])
  const ctx = makeCtx(live)
  apply(ctx)

  ctx.handlers.get('subagent/start')({ id: 'child' })
  assert.doesNotThrow(() => {
    ctx.handlers.get('subagent/end')({ id: 'child', stopReason: 'error' })
  })
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /parent "gone" is not live/)
})

test('失败但无任何原因记录时告警，不投放空通知', () => {
  const parent = parentAgent('parent')
  const child = childAgent('child', 'parent', undefined)
  const live = new Map([['child', child], ['parent', parent]])
  const ctx = makeCtx(live)
  apply(ctx)

  ctx.handlers.get('subagent/start')({ id: 'child' })
  ctx.handlers.get('subagent/end')({ id: 'child', stopReason: 'error' })

  assert.equal(parent.delivered.followup.length, 0)
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /no recorded cause/)
})

test('异常的 reason.error 形状被规整而不抛错', () => {
  const parent = parentAgent('parent')
  const child = childAgent('child', 'parent', { kind: 'error', error: 'plain string cause' })
  const live = new Map([['child', child], ['parent', parent]])
  const ctx = makeCtx(live)
  apply(ctx)

  ctx.handlers.get('subagent/start')({ id: 'child' })
  ctx.handlers.get('subagent/end')({ id: 'child', stopReason: 'error' })

  assert.equal(parent.delivered.followup.length, 1)
  assert.match(textOf(parent.delivered.followup[0]), /plain string cause/)
})

test('超长 provider 报文被截断，不整段灌进父代理上下文', () => {
  const parent = parentAgent('parent')
  const long = 'x'.repeat(5_000)
  const child = childAgent('child', 'parent', { kind: 'error', error: { message: long, code: 'SERVER' } })
  const live = new Map([['child', child], ['parent', parent]])
  const ctx = makeCtx(live)
  apply(ctx)

  ctx.handlers.get('subagent/start')({ id: 'child' })
  ctx.handlers.get('subagent/end')({ id: 'child', stopReason: 'error' })

  const text = textOf(parent.delivered.followup[0])
  assert.ok(text.length < 2_000, `notice 应被截断，实际 ${text.length} 字符`)
  assert.match(text, /chars elided/)
})

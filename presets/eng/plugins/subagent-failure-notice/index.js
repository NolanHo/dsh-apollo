/**
 * `eng-subagent-failure-notice` — 子代理失败原因推送（预设本地插件）。
 *
 * 背景：框架在 continuable 子代理结算时会向父代理推一条 `subagent-settled`
 * 通知，但 `ActivationTerminal` 只携带 `{stopReason, output}`（见
 * packages/subagent/subagent/src/lifecycle.ts 的 ActivationTerminal 定义），
 * 因此父代理只看到 "Background subagent <id> failed before it finished." ——
 * 拿不到失败原因。子代理自己的会话日志里其实完整记着
 * `turn/end.reason.error = {message, code, status, requestId}`（LlmFailure），
 * 只是没有传出来。后果是父代理分不清 provider 额度、鉴权还是网络故障，只能
 * 反复重派同一路由，表现为「一直在失败里打转」。
 *
 * 本插件补上这一段：在子代理存活期间捕获它，结算为 error 时把子代理日志里的
 * 失败事实作为一条 notice 推给直接父代理。它不替代框架的结算通知，而是紧跟
 * 其后补充原因。
 *
 * 两条互相独立的捕获路径（任一可用即可）：
 * 1. `subagent/start` 时从 `ctx.agents` 取到子代理 Agent 引用，`subagent/end`
 *    时读它自己的会话日志（`turn/end` 的 error 原因）。这条路径不依赖
 *    `agent/error` 的 scope 过滤是否覆盖本插件。
 * 2. `agent/error` 事件（payload 携带 `agent` 与原始 error），按子会话 id 记下
 *    失败事实，兼作路径 1 取不到 Agent 时的兜底。
 *
 * 只对 `stopReason === 'error'` 推：aborted / max-tokens / refusal 各有明确
 * 语义，不需要原因补充。
 *
 * 零 bare import（同 wait-subagent / exit-guard 约束）：模块从预设目录加载，
 * Node 的 node_modules 向上查找到不了 harness 安装目录，裸包名 import 会失败。
 * 一切从 context 取。
 */

export const name = 'eng-subagent-failure-notice'

export const inject = ['agents']

/** 一条失败的展示上限，避免把整段 provider 报文灌进父代理上下文。 */
const MAX_MESSAGE_CHARS = 600

/** 把任意抛出物规整成 `{message, code?, status?, requestId?}`。 */
function normalizeThrown(error) {
  // 两种来源形状：`agent/error` 的 payload 是 LlmError（事实挂 `.failure`），
  // 会话日志里的 `turn/end.reason.error` 是已序列化的扁平 LlmFailure。取到事实
  // 对象后按同一套字段读取，避免某一条路径漏掉 requestId 之类的字段。
  const facts = error !== null && typeof error === 'object'
    && error.failure !== null && typeof error.failure === 'object'
    ? error.failure
    : error
  if (facts !== null && typeof facts === 'object'
    && typeof facts.message === 'string' && facts.message !== '') {
    return {
      message: facts.message,
      ...typeof facts.code === 'string' && facts.code !== '' ? { code: facts.code } : {},
      ...typeof facts.status === 'number' ? { status: facts.status } : {},
      ...typeof facts.requestId === 'string' && facts.requestId !== '' ? { requestId: facts.requestId } : {},
    }
  }
  return { message: String(error) }
}

/** 从子代理自己的会话日志尾部取最近一次 `turn/end` 的失败事实。 */
function failureFromLog(agent) {
  if (agent === undefined || agent === null) return undefined
  let events
  try {
    events = agent.session.snapshotEvents()
  } catch {
    return undefined
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'turn/end') continue
    const reason = event.data === undefined ? undefined : event.data.reason
    if (reason === undefined || reason.kind !== 'error') return undefined
    return normalizeThrown(reason.error)
  }
  return undefined
}

/** 截断过长报文，保留头尾以便模型认出 provider 报文形态。 */
function bound(text) {
  if (typeof text !== 'string') return String(text)
  if (text.length <= MAX_MESSAGE_CHARS) return text
  const head = Math.ceil(MAX_MESSAGE_CHARS * 0.7)
  const tail = MAX_MESSAGE_CHARS - head
  return `${text.slice(0, head)}…[${text.length - MAX_MESSAGE_CHARS} chars elided]…${text.slice(-tail)}`
}

/** 构造推给父代理的模型可见 notice 消息。 */
function buildMessage(childId, failure) {
  const lines = [
    `Background subagent ${childId} failed before it finished.`,
    'Its own session log records this cause:',
    ...failure.code === undefined ? [] : [`  - code: ${failure.code}`],
    `  - message: ${bound(failure.message)}`,
    ...failure.status === undefined ? [] : [`  - status: ${failure.status}`],
    ...failure.requestId === undefined ? [] : [`  - requestId: ${failure.requestId}`],
    '',
    'Re-dispatching the same model and route will fail the same way; change the route/model, '
      + 'or report the failure instead of retrying it blindly.',
  ]
  const text = lines.join('\n')
  const summary = failure.code === undefined
    ? `子代理 ${childId} 失败原因：${bound(failure.message)}`
    : `子代理 ${childId} 失败原因：${failure.code}`
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin:eng-subagent-failure-notice',
      form: 'notice',
      summary: summary.length > 200 ? `${summary.slice(0, 199)}…` : summary,
    },
    id: crypto.randomUUID(),
  }
}

export function apply(ctx) {
  /** childId -> { parentId, agent }，子代理存活期间捕获，结算时释放。 */
  const children = new Map()
  /** childId -> 失败事实，来自 `agent/error`，兼作日志路径的兜底。 */
  const failures = new Map()

  ctx.on('subagent/start', (info) => {
    const id = info === undefined || info === null ? undefined : info.id
    if (typeof id !== 'string') return
    const child = ctx.agents.get(id)
    if (child === undefined) return
    const header = child.session === undefined ? undefined : child.session.header
    const parentId = header === undefined ? undefined : header.parentSession
    if (typeof parentId !== 'string') return
    children.set(id, { parentId, agent: child })
  })

  // 兜底路径：子代理回合失败时 agent-loop 会以该 agent 为载体发 agent/error，
  // payload 里既有 agent 也有原始抛出物；顶层会话（无 parentSession）不记。
  ctx.on('agent/error', (payload) => {
    if (payload === undefined || payload === null) return
    const agent = payload.agent
    const id = agent === undefined || agent === null ? undefined : agent.id
    if (typeof id !== 'string') return
    const header = agent.session === undefined ? undefined : agent.session.header
    if (header === undefined || typeof header.parentSession !== 'string') return
    failures.set(id, normalizeThrown(payload.error))
    if (!children.has(id)) children.set(id, { parentId: header.parentSession, agent })
  })

  ctx.on('subagent/end', (info) => {
    const id = info === undefined || info === null ? undefined : info.id
    if (typeof id !== 'string') return
    const record = children.get(id)
    const captured = failures.get(id)
    children.delete(id)
    failures.delete(id)
    if (info.stopReason !== 'error' || record === undefined) return

    const failure = captured ?? failureFromLog(record.agent)
    if (failure === undefined) {
      ctx.logger?.warn?.(
        `eng-subagent-failure-notice: subagent "${id}" failed with no recorded cause; `
        + 'the parent received the framework notice without a reason',
      )
      return
    }
    const parent = ctx.agents.get(record.parentId)
    if (parent === undefined) {
      ctx.logger?.warn?.(
        `eng-subagent-failure-notice: subagent "${id}" failed but its parent "${record.parentId}" `
        + 'is not live; the cause was not delivered',
      )
      return
    }
    try {
      const notice = buildMessage(id, failure)
      // 与框架 notifySettlement 同一投放口径：空闲父代理走 followup（会唤醒），
      // 运行中的父代理走 steer（落在下一步边界）。
      if (parent.status === 'idle') parent.followup(notice)
      else parent.steer(notice)
    } catch (error) {
      ctx.logger?.warn?.(
        `eng-subagent-failure-notice: cause for subagent "${id}" was not delivered: `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  })
}

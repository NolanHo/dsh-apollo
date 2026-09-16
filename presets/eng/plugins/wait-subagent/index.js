/**
 * `wait_subagent` tool — explicit wait for continuable children to settle.
 *
 * Preset-local plugin for the eng preset (resolved relative to this preset's
 * directory). Continuable subagents live in the `subagents` registry, not the
 * `jobs` registry, so the only settlement signal is the scoped `subagent/end`
 * event. The tool takes an ARRAY of durable child ids (`subagent_id`) and
 * watches them concurrently (duplicates deduped, order preserved): it returns
 * as soon as ANY watched id settles — first completion, not a barrier —
 * reporting every child that is done by then as one SHORT line per id (done +
 * stopReason) and naming the ids still running, which the caller passes to
 * another call to wait for the next one. A barrier made the slowest child of
 * the batch decide the wall clock (long-tail tax); first-completion matches how
 * asynchronous scheduling wants to be driven — collect what is ready, re-arm on
 * the rest.
 *
 * The wait is bounded: one shared window over the whole batch (one timer,
 * armed when the batch arms), capped at MAX_WAIT_MS. "Wait forever" is not a
 * scheduling primitive — the caller always gets a result it can act on, either
 * done lines or the ids still running plus a re-call hint.
 *
 * The children's content is none of this tool's business: the subagent manager
 * unconditionally delivers a settlement notice to the parent BEFORE
 * `subagent/end` fires (dispose order: notifySettlement() →
 * observer.settle()), carrying the one-line account and the closing message.
 * A busy parent is steered, so the notice sits in the pending next-step queue
 * and reaches the model right after this tool result — exactly once, per
 * child, by the framework. Earlier designs returned the child's final message
 * here AND spliced the duplicate notice (and any mid-run `report`) out of the
 * parent inbox; that coupled this plugin to `agent.inbox` internals and to
 * the `subagent-report` source kind, which upstream removed in
 * 0.1.2-alpha.4 (bidirectional `send_message` replaced `report`). Returning
 * "done" lines and leaving delivery to the framework has no such coupling.
 * Mid-run messages the child sends (`send_message`, source kind
 * `agent-message`) likewise stay in place.
 *
 * An id that is not a direct child fails the whole call fast — nobody is
 * waited for — keeping the contract the single-id version had. A child
 * dispatched moments ago may not have started its first turn yet: its status
 * is not `running` and no settlement exists. Returning early with a "not
 * running" note there (the pre-grace behavior) ended the turn before the
 * child even started and forced a re-wait on the next turn — session audit
 * 2f5dd618. Instead, not-yet-started children get a startup grace window
 * (START_GRACE_MS) watched by one batch-wide poller: the call keeps waiting
 * while a child spins up, settles, or until the grace expires for every child
 * that never started (only then a retryable informational line).
 *
 * Zero imports on purpose: the module loads from the preset directory, where
 * Node's upward node_modules walk never reaches the harness install, so bare
 * package imports would fail. Everything needed comes from the context.
 */

export const name = 'tool-wait-subagent'

export const inject = ['tools', 'subagents', 'agents']

/** Grace window for a just-dispatched child that has not started running yet. */
const START_GRACE_MS = 30_000

/** Status polling interval while waiting for not-yet-started children. */
const POLL_MS = 250

/** Hard ceiling for one call's wait window, whatever `timeout_ms` asks for. */
const MAX_WAIT_MS = 600_000

export function apply(ctx) {
  /** childId -> { time, info } — latest settlement observed since mount. */
  const settled = new Map()
  /** childId -> callbacks awaiting settlement; each is called at most once. */
  const waiters = new Map()

  ctx.on('subagent/end', (info) => {
    const id = info && info.id
    if (typeof id !== 'string') return
    settled.set(id, { time: Date.now(), info })
    const list = waiters.get(id)
    if (list !== undefined) {
      waiters.delete(id)
      for (const onSettle of [...list]) onSettle(info)
    }
  })

  ctx.tools.register({
    name: 'wait_subagent',
    description: 'Wait for one or more background continuable subagents (spawned by subagent or subagent_fork) to finish their current turn. Pass their durable ids as an array in subagent_id — they are watched concurrently and the call returns as soon as ANY of them settles: the result carries one short line per finished child (done + stop reason) and names the ids still running, so pass those remaining ids to another wait_subagent call to wait for the next one; children that settle together are reported together, and a child\'s closing message arrives as the framework settlement notice immediately after the result that reports it — do not expect it here. One call waits at most 600000ms (pass a smaller timeout_ms to shorten the one shared window over the whole batch); on expiry the result lists the children still running — call wait_subagent again to keep waiting. A just-dispatched child that has not started yet is awaited through a brief startup grace rather than reported as not running. Use it when your next step depends on those results; with independent work remaining, prefer background plus completion notices. Do not pass bash job ids — those use job_output.',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'One or more durable subagent ids returned by the subagent or subagent_fork tool call; every id is watched concurrently and the first settlement ends the call.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Optional maximum wait in milliseconds for this call, capped at 600000; omit to use the 600000 ceiling. One shared window over the whole batch: on expiry the tool returns while some children are still running.',
        },
      },
      required: ['subagent_id'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // Dedupe preserving input order; the schema already enforces a
      // non-empty array, the guard below only covers malformed direct calls.
      const ids = [...new Set(Array.isArray(args.subagent_id) ? args.subagent_id : [])]
      if (ids.length === 0) return 'subagent_id must be a non-empty array of subagent ids.'
      const parent = exec.agent
      if (parent === undefined) throw new Error('wait_subagent requires a calling agent (exec.agent was undefined)')

      // Verify every id is one of this agent's direct children — fail fast,
      // waiting for nobody (the contract the single-id version had).
      let entries
      try {
        entries = await ctx.subagents.listChildren(parent.id, exec.signal)
      } catch (error) {
        return 'listChildren failed: ' + (error && error.message ? error.message : String(error))
      }
      const known = new Set(entries.map((entry) => entry.id))
      const unknown = ids.filter((id) => !known.has(id))
      if (unknown.length > 0) {
        return `unknown subagent ${unknown.map((id) => `"${id}"`).join(', ')}: not a direct child of this agent (list_agents shows your children; only depth-1 children can be awaited).`
      }

      const statusOf = (id) => {
        const agent = ctx.agents.get(id)
        return agent === undefined ? 'ready' : agent.status === 'running' ? 'running' : 'idle'
      }

      /** Settlement line: short done line; content belongs to the framework notice. */
      const doneLine = (id, info) => `subagent ${id} done (${info && info.stopReason ? info.stopReason : 'completed'}); its closing message follows as the settlement notice.`

      const startedAt = Date.now()
      // The window is always bounded: an explicit timeout_ms only ever shortens
      // it past the clamp (0/<0/non-number is treated as "not passed", the
      // parsing habit the previous version had).
      const capMs = typeof args.timeout_ms === 'number' && args.timeout_ms > 0
        ? Math.min(args.timeout_ms, MAX_WAIT_MS)
        : MAX_WAIT_MS

      /**
       * Watch the whole batch on one shared window. Resolves on the FIRST of:
       * an id settles (first-completion), every id reaches a terminal state
       * without a settlement, the window expires, or the call is aborted.
       * `outcomes` holds the per-id classification; an id missing from it was
       * still running when the call returned early — usually a same-tick
       * sibling, absorbed from the plugin-level `settled` map right after.
       */
      const waitBatch = () => new Promise((resolve) => {
        const outcomes = new Map()
        const pending = new Set(ids)
        /** id -> the callback handed to the plugin-level `waiters` list. */
        const registered = new Map()
        let finished = false
        let timer
        let poller

        const onAbort = () => {
          if (finished) return
          for (const id of pending) outcomes.set(id, { kind: 'aborted' })
          pending.clear()
          complete('aborted')
        }

        /** Detach from every shared structure this call hooked into. */
        const release = () => {
          if (timer !== undefined) clearTimeout(timer)
          if (poller !== undefined) clearInterval(poller)
          if (exec.signal !== undefined) exec.signal.removeEventListener('abort', onAbort)
          for (const [id, onSettle] of registered) {
            const list = waiters.get(id)
            if (list === undefined) continue
            const index = list.indexOf(onSettle)
            if (index >= 0) list.splice(index, 1)
            if (list.length === 0) waiters.delete(id)
          }
          registered.clear()
        }

        const complete = (reason) => {
          if (finished) return
          finished = true
          release()
          resolve({ reason, outcomes })
        }

        const record = (id, outcome) => {
          if (finished || !pending.has(id)) return
          pending.delete(id)
          outcomes.set(id, outcome)
          // First-completion: one settled id ends the call. Siblings that
          // settle in the same tick are picked up at assembly time, so a batch
          // that finishes together is reported together.
          if (outcome.kind === 'settled') complete('settled')
          else if (pending.size === 0) complete('none')
        }

        // Fast path: the child is not running and a settlement is already on
        // record — nobody to wait for, and (first-completion) that settlement
        // ends the call just like a live one.
        let preSettled = false
        for (const id of ids) {
          if (statusOf(id) === 'running') continue
          const hit = settled.get(id)
          if (hit === undefined) continue
          preSettled = true
          pending.delete(id)
          outcomes.set(id, { kind: 'settled', info: hit.info })
        }
        if (preSettled) return complete('settled')

        for (const id of pending) {
          const onSettle = (info) => record(id, { kind: 'settled', info })
          registered.set(id, onSettle)
          const list = waiters.get(id) ?? []
          list.push(onSettle)
          waiters.set(id, list)
        }

        if (exec.signal !== undefined) {
          if (exec.signal.aborted) {
            onAbort()
            return
          }
          exec.signal.addEventListener('abort', onAbort, { once: true })
        }

        // All ids share startedAt, so one capMs value is one shared window.
        timer = setTimeout(() => {
          if (finished) return
          for (const id of pending) outcomes.set(id, { kind: 'timedOut' })
          pending.clear()
          complete('timedOut')
        }, capMs)

        // Startup grace, batched into one poller over every pending id: a
        // freshly dispatched child sits between spawn and its first turn
        // (status not `running`, no settlement yet). Keep the wait alive while
        // it spins up; once `running`, only `subagent/end` resolves it. An id
        // that never starts within the grace is recorded as retryable, and the
        // batch returns only once no id can progress any more.
        poller = setInterval(() => {
          if (finished) return
          const now = Date.now()
          for (const id of [...pending]) {
            const hit = settled.get(id)
            if (hit !== undefined && hit.time >= startedAt) {
              record(id, { kind: 'settled', info: hit.info })
              continue
            }
            if (statusOf(id) !== 'running' && now - startedAt >= START_GRACE_MS) {
              record(id, { kind: 'notStarted' })
            }
          }
        }, POLL_MS)

        // Race backstop: a child may have settled between the fast path above
        // and waiter registration. Only a settlement AFTER this wait started
        // counts as a live result.
        for (const id of [...pending]) {
          const hit = settled.get(id)
          if (hit !== undefined && hit.time >= startedAt) record(id, { kind: 'settled', info: hit.info })
        }
      })

      const result = await waitBatch()

      // Absorb same-tick siblings: settlements that landed after the gate
      // resolved but before this continuation ran are already on record, and
      // reporting them here spares the caller a no-op second call.
      for (const id of ids) {
        if (result.outcomes.has(id)) continue
        const hit = settled.get(id)
        if (hit !== undefined && hit.time >= startedAt) result.outcomes.set(id, { kind: 'settled', info: hit.info })
      }

      const outcomes = ids.map((id) => result.outcomes.get(id) ?? { kind: 'stillRunning' })

      // Every waiter shares one abort signal, so an interruption either
      // aborts the whole batch or lands after some children already settled.
      // Collapse the all-aborted case into one line; mixed cases keep
      // per-id lines so the settled ones are not lost.
      if (outcomes.every((outcome) => outcome.kind === 'aborted')) {
        return `wait for ${ids.length} subagent${ids.length === 1 ? '' : 's'} was aborted by user interruption; the children may still be running.`
      }

      const lines = []
      const stillRunning = []
      outcomes.forEach((outcome, index) => {
        const id = ids[index]
        if (outcome.kind === 'stillRunning') {
          stillRunning.push(id)
          return
        }
        if (outcome.kind === 'settled') {
          // Real settlement: short done line; the framework's settlement notice
          // (already delivered to the parent inbox before `subagent/end`)
          // carries the closing message — nothing to consume or deduplicate.
          lines.push(doneLine(id, outcome.info))
          return
        }
        if (outcome.kind === 'timedOut') {
          lines.push(`timed out waiting for subagent ${id}; it is still running. You will be notified when it finishes — you can wait_subagent it again or continue with other work.`)
          return
        }
        if (outcome.kind === 'aborted') {
          lines.push(`wait for subagent ${id} was aborted by user interruption; the child may still be running.`)
          return
        }
        lines.push(`subagent ${id} has not started after ${Math.round(START_GRACE_MS / 1000)}s (status: ${statusOf(id)}). It may still be spinning up — call wait_subagent again, or continue with other work; you will be notified when it finishes.`)
      })

      // Only a first-completion return ('settled') can leave ids running: the
      // timeout line and the not-started line already carry their own re-call
      // guidance, so the summary line belongs to this case alone. ('none' /
      // 'timedOut' / 'aborted' always classify every id.)
      if (stillRunning.length > 0 && result.reason === 'settled') {
        lines.push(`still running: ${stillRunning.join(', ')} — call wait_subagent again with them to wait for the next one; you will also be notified when each finishes.`)
      }
      return lines.join('\n')
    },
  })
}

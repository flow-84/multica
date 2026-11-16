// Catch-up of autopilot slots the server dropped during an outage (MS-3771).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catchUpMissedSlots } from '../src/autopilot-catchup.ts'
import type { AutopilotRun, AutopilotTrigger } from '../src/multica.ts'

const NOW = new Date('2026-11-09T07:20:00Z')

function fake(triggers: AutopilotTrigger[], runs: AutopilotRun[]) {
  const started: { id: string; key: string }[] = []
  const api = {
    activeAutopilots: async () => [{ id: 'ap1', title: 'SEO-Wochenreport', status: 'active' }],
    autopilotTriggers: async () => triggers,
    autopilotRuns: async () => runs,
    triggerAutopilot: async (id: string, key: string) => {
      started.push({ id, key })
      return { id: 'run', created_at: NOW.toISOString(), source: 'manual' }
    },
  }
  return { api, started }
}

const sched = (next: string | null, extra: Partial<AutopilotTrigger> = {}): AutopilotTrigger => ({
  id: 't1',
  kind: 'schedule',
  enabled: true,
  next_run_at: next,
  ...extra,
})

test('a slot dropped during an outage is started once, with a stable idempotency key', async () => {
  const { api, started } = fake([sched('2026-11-09T07:00:00Z')], [{ id: 'r', created_at: '2026-11-02T07:00:05Z', source: 'schedule' }])
  const r = await catchUpMissedSlots(api, NOW, () => {})
  assert.deepEqual(started, [{ id: 'ap1', key: 'catchup:t1:2026-11-09T07:00:00.000Z' }])
  assert.deepEqual(r.started, ['ap1'])
})

test('a slot with a run since then is left alone', async () => {
  const { api, started } = fake([sched('2026-11-09T07:00:00Z')], [{ id: 'r', created_at: '2026-11-09T07:16:00Z', source: 'manual' }])
  await catchUpMissedSlots(api, NOW, () => {})
  assert.equal(started.length, 0)
})

test('within the grace window, after a day, disabled or webhook triggers: nothing starts', async () => {
  for (const t of [
    sched('2026-11-09T07:10:00Z'),
    sched('2026-11-08T07:00:00Z'),
    sched('2026-11-09T07:00:00Z', { enabled: false }),
    sched('2026-11-09T07:00:00Z', { kind: 'webhook' }),
    sched(null),
    sched('2026-11-16T07:00:00Z'),
  ]) {
    const { api, started } = fake([t], [])
    await catchUpMissedSlots(api, NOW, () => {})
    assert.equal(started.length, 0, JSON.stringify(t))
  }
})

test('dry run logs but does not start', async () => {
  const { api, started } = fake([sched('2026-11-09T07:00:00Z')], [])
  const lines: string[] = []
  await catchUpMissedSlots(api, NOW, (m) => lines.push(m), true)
  assert.equal(started.length, 0)
  assert.match(lines[0], /würde nachholen: SEO-Wochenreport/)
})

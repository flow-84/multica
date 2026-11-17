// Catch-up for scheduled autopilots (MS-3771). The server only dispatches a
// cron slot up to five minutes late; when the backend is unreachable across a
// slot (on 09.11.2026 from 01:45 to 07:05 UTC), the slot is dropped and a
// weekly autopilot silently skips a whole week. A dropped slot leaves the
// trigger's next_run_at in the past, because the server only advances it on
// dispatch. This pass finds such triggers and starts the autopilot once.
import type { MulticaApi } from './multica.ts'

/** Wait past the server's own five-minute lateness window before stepping in. */
export const GRACE_MS = 15 * 60_000
/** Only the most recent missed slot counts, like the server's replay window. */
export const MAX_AGE_MS = 24 * 60 * 60_000

type Api = Pick<MulticaApi, 'activeAutopilots' | 'autopilotTriggers' | 'autopilotRuns' | 'triggerAutopilot'>

export interface CatchUpResult {
  checked: number
  started: string[]
}

export async function catchUpMissedSlots(
  api: Api,
  now: Date,
  log: (msg: string) => void,
  dryRun = false,
): Promise<CatchUpResult> {
  const result: CatchUpResult = { checked: 0, started: [] }
  for (const ap of await api.activeAutopilots()) {
    const triggers = await api.autopilotTriggers(ap.id)
    const missed = triggers
      .filter((t) => t.kind === 'schedule' && t.enabled && t.next_run_at)
      .map((t) => ({ t, due: Date.parse(t.next_run_at as string) }))
      .filter(({ due }) => now.getTime() - due > GRACE_MS && now.getTime() - due < MAX_AGE_MS)
      .sort((a, b) => b.due - a.due)[0]
    result.checked++
    if (!missed) continue
    // The server skips a slot on purpose when the autopilot was paused at that
    // time; resuming it later must not fire the skipped slot. A pause or resume
    // bumps updated_at, while the backend outage this pass covers cannot.
    if (Date.parse(ap.updated_at) > missed.due) continue
    // Any run since the slot (scheduled, manual, or an earlier catch-up)
    // means the slot is covered.
    const runs = await api.autopilotRuns(ap.id, 20)
    if (runs.some((r) => Date.parse(r.created_at) >= missed.due)) continue
    const slot = new Date(missed.due).toISOString()
    log(`${dryRun ? 'würde nachholen' : 'nachgeholt'}: ${ap.title} (Slot ${slot})`)
    if (!dryRun) await api.triggerAutopilot(ap.id, `catchup:${missed.t.id}:${slot}`)
    result.started.push(ap.id)
  }
  return result
}

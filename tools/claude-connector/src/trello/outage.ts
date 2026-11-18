// Tracks a stretch in which Multica or Trello gave no response (MS-3997). Under
// heavy load on the Mac every request of a pass times out or is reset for a few
// minutes; the next pass pushes every card again, so nothing is lost. Such a
// stretch is logged as postponed, and only counts as an error ("fehler bei",
// which the Lagebild counts) once it lasts longer than errorAfterMs.

export class Outage {
  private since: number | null = null
  private readonly errorAfterMs: number

  constructor(errorAfterMs: number) {
    this.errorAfterMs = errorAfterMs
  }

  /** Records a request without response at now; error once the stretch is long. */
  failed(now: number): { error: boolean; minutes: number } {
    this.since ??= now
    const ms = now - this.since
    return { error: ms >= this.errorAfterMs, minutes: Math.round(ms / 60_000) }
  }

  /** Minutes the stretch lasted when a full pass succeeded after one, else null. */
  recovered(now: number): number | null {
    if (this.since === null) return null
    const minutes = Math.round((now - this.since) / 60_000)
    this.since = null
    return minutes
  }
}

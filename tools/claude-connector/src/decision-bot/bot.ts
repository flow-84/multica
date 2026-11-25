// Decision bot @multicafl0wbot (MS-4379): every open decision card of every active
// Multica project reaches fl0w as one Telegram message with buttons; the answer goes
// back to the card as a comment by fl0w, then the card's next step is triggered.
//
// Flow per question (states in store.ts):
//   scan()     reads the open cards, adds new questions, closes ones the card no longer asks
//   sendDue()  sends new and due postponed questions
//   handle()   buttons and texts from fl0w; every other chat is ignored
//   flush()    after the grace period the answer (with any Bemerkung) goes to the card
import type { Comment, Issue, Project } from '../multica.ts'
import { INACTIVE_PROJECT_STATUSES, OPEN_STATUSES, extractQuestion, externalQuestion, isCandidate, type Question } from './detect.ts'
import { readRouting, type Routing } from './routing.ts'
import { ACTIVE, type Row, type Store } from './store.ts'
import type { Target, Tg, TgMessage, TgUpdate } from './telegram.ts'
import {
  type Answer,
  type AskedQuestion,
  HELP_TEXT,
  NONE_OPEN_TEXT,
  answerHead,
  answerLine,
  berlin,
  commentText,
  confirmKeyboard,
  confirmText,
  header,
  nachtragText,
  parseTextAnswer,
  questionKeyboard,
  questionText,
  tomorrowNine,
} from './texts.ts'

/** The part of the Multica API the bot uses (MulticaApi implements it). */
export interface Board {
  projects(): Promise<Project[]>
  listIssues(q: { statuses?: string[]; limit: number; offset?: number }): Promise<{ issues: Issue[]; total: number }>
  getIssue(ref: string): Promise<Issue>
  comments(issueId: string): Promise<Comment[]>
  addComment(issueId: string, content: string): Promise<Comment>
  updateIssue(issueId: string, body: Record<string, unknown>): Promise<Issue>
}

export interface BotDeps {
  board: () => Board
  tg: Tg
  store: Store
  /**
   * fl0w's Telegram id; the private chat id is the same number. Only this account may answer,
   * in the private chat or in a chat set as target (routing.ts).
   */
  ownerChatId: number
  /** fl0w's Multica user id: comments by this member count as fl0w's answer. */
  flowUserId: string
  /** Card link that opens on the phone (Tailnet host). */
  link: (identifier: string) => string
  now?: () => number
  /** How long an answer waits for a Bemerkung before it goes to the card. */
  graceMs?: number
  log?: (msg: string) => void
  /** Called once, right after the first greeting reached fl0w (go-live). */
  onLive?: (openQuestions: number) => Promise<void>
}

const BEMERKUNG_WINDOW_MS = 30 * 60_000
const NACHTRAG_WINDOW_MS = 15 * 60_000
const POST_ALARM_MS = 30 * 60_000

const asked = (r: Row): AskedQuestion => ({ identifier: r.identifier, project: r.project, frage: r.frage, empfehlung: r.empfehlung, optionen: r.optionen, quelle: r.quelle })
const answerOf = (r: Row): Answer => ({ kind: r.answer_kind ?? 'bemerkung', option: r.answer_option, bemerkung: r.bemerkung })
const errText = (err: unknown) => ((err as Error)?.message ?? String(err)).slice(0, 300)
/** Topic of an incoming message; outside forum topics Telegram's thread id means a reply chain, not a target. */
const targetOf = (m: { chat: { id: number } } & Pick<TgMessage, 'message_thread_id' | 'is_topic_message'>): Target => ({ chat: m.chat.id, thread: m.is_topic_message ? (m.message_thread_id ?? null) : null })

export class DecisionBot {
  private readonly d: Required<BotDeps>
  /** Last evaluation per card, keyed by its last activity, so unchanged cards are not re-read. */
  private readonly cache = new Map<string, { activity: string; q: Question | null }>()
  /** After a refused send (e.g. fl0w has not pressed Start yet) the next try waits a little. */
  private sendPausedUntil = 0
  /** Since when sending to fl0w fails without a break, and why (for the alarm in main). */
  private sendFailing: { since: number; error: string } | null = null
  /** Chat and topic of the update being handled: replies go back there. */
  private inbound: Target | null = null

  constructor(deps: BotDeps) {
    this.d = { now: Date.now, graceMs: 120_000, log: () => {}, onLive: async () => {}, ...deps }
  }

  private get now(): number {
    return this.d.now()
  }

  private routing(): Routing {
    return readRouting(this.d.store)
  }

  private get home(): Target {
    return { chat: this.d.ownerChatId, thread: null }
  }

  private questionTarget(): Target {
    return this.routing().fragen ?? this.home
  }

  /** Chat of a stored message; rows written before chats were recorded are migrated by the store. */
  private chatOf(chat: number | null): number {
    return chat ?? this.d.ownerChatId
  }

  // ---------------------------------------------------------------- scan

  private async openIssues(b: Board): Promise<Issue[]> {
    const out: Issue[] = []
    for (let offset = 0; ; offset += 100) {
      const { issues, total } = await b.listIssues({ statuses: [...OPEN_STATUSES], limit: 100, offset })
      out.push(...issues)
      if (!issues.length || out.length >= total) return out
    }
  }

  /** Bring the questions in line with the board. Returns how many were added and closed. */
  async scan(): Promise<{ added: number; closed: number }> {
    const b = this.d.board()
    const projects = new Map((await b.projects()).map((p) => [p.id, p]))
    const issues = await this.openIssues(b)
    const active = (i: Issue) => !i.project_id || !INACTIVE_PROJECT_STATUSES.has(projects.get(i.project_id)?.status ?? '')
    const byId = new Map(issues.map((i) => [i.id, i]))
    let added = 0
    let closed = 0

    // Questions of cards that left the open statuses or sit in a paused project.
    for (const r of this.d.store.inState(...ACTIVE)) {
      const i = byId.get(r.issue_id)
      if (i && active(i)) continue
      if (!i && r.source === 'extern') {
        // An outside question may target a card in progress; only a closed card ends it.
        const cur = await b.getIssue(r.issue_id).catch(() => null)
        if (cur && !['done', 'cancelled'].includes(cur.status) && (!cur.project_id || !INACTIVE_PROJECT_STATUSES.has(projects.get(cur.project_id)?.status ?? ''))) continue
      }
      await this.close(r, i ? 'das Projekt ist pausiert' : 'die Karte ist nicht mehr offen')
      closed++
    }

    for (const i of issues) {
      if (!active(i) || !isCandidate(i)) continue
      const activity = (i as Issue & { last_activity_at?: string }).last_activity_at ?? i.updated_at
      let hit = this.cache.get(i.id)
      if (!hit || hit.activity !== activity) {
        const q = extractQuestion(i, await b.comments(i.id), this.d.flowUserId)
        hit = { activity, q }
        this.cache.set(i.id, hit)
      }
      const rows = this.d.store.inState(...ACTIVE).filter((r) => r.issue_id === i.id)
      for (const r of rows) {
        if (r.source === 'extern') continue
        if (!hit.q || r.hash !== hit.q.hash) {
          await this.close(r, hit.q ? 'die Karte fragt inzwischen etwas anderes' : 'in Multica beantwortet oder nicht mehr gefragt')
          closed++
        }
      }
      if (!hit.q || rows.some((r) => r.source === 'extern')) continue
      const row = this.d.store.insert({
        issue_id: i.id,
        identifier: i.identifier,
        project: i.project_id ? (projects.get(i.project_id)?.title ?? null) : null,
        hash: hit.q.hash,
        source: hit.q.source,
        frage: hit.q.frage,
        empfehlung: hit.q.empfehlung,
        optionen: hit.q.optionen,
        quelle: null,
        done_after_answer: hit.q.doneAfterAnswer,
        created_at: this.now,
      })
      if (row) {
        added++
        this.d.log(`neu ${i.identifier}: ${hit.q.frage.slice(0, 80)}`)
      }
    }
    return { added, closed }
  }

  /** Question from outside (CLI), e.g. the "model2star Jobs" daily loop. false = asked before. */
  async addExternal(ref: string, frage: string, optionen: string[], empfehlung: string | null, quelle: string | null): Promise<{ added: boolean; identifier: string }> {
    const b = this.d.board()
    const i = await b.getIssue(ref)
    const project = i.project_id ? ((await b.projects()).find((p) => p.id === i.project_id)?.title ?? null) : null
    const q = externalQuestion(frage, optionen, empfehlung)
    if (!q.frage) throw new Error('Frage ist leer')
    const row = this.d.store.insert({
      issue_id: i.id,
      identifier: i.identifier,
      project,
      hash: q.hash,
      source: 'extern',
      frage: q.frage,
      empfehlung: q.empfehlung,
      optionen: q.optionen,
      quelle,
      done_after_answer: false,
      created_at: this.now,
    })
    if (row) {
      // One open question per card: the outside question replaces what the scan found.
      for (const r of this.d.store.inState(...ACTIVE)) {
        if (r.issue_id === i.id && r.id !== row.id && r.source !== 'extern') await this.close(r, 'ersetzt durch eine neue Frage zur Karte')
      }
    }
    return { added: !!row, identifier: i.identifier }
  }

  private async close(r: Row, reason: string): Promise<void> {
    if (!this.d.store.update(r.id, { state: 'erledigt', closed_reason: reason }, [...ACTIVE])) return
    this.d.log(`erledigt ${r.identifier}: ${reason}`)
    if (r.message_id && r.state === 'gesendet') {
      if (this.routing().nachAntwort !== 'behalten') return this.retire(r, `${questionText(asked(r), false)}\n\nErledigt, ${reason}.`)
      await this.d.tg.edit(this.chatOf(r.chat_id), r.message_id, `${questionText(asked(r))}\n\nErledigt, ${reason}. Die Knöpfe sind entfernt.`, null).catch((err) => this.d.log(`edit ${r.identifier}: ${errText(err)}`))
    }
  }

  // ---------------------------------------------------------------- send

  /** Send new questions and postponed ones that are due. Stops at the first Telegram error. */
  async sendDue(): Promise<number> {
    let sent = 0
    if (this.now < this.sendPausedUntil) return 0
    if (!this.d.store.getKv('begruesst')) {
      try {
        await this.d.tg.send(this.questionTarget(), `Der Entscheidungs-Bot ist live. ${HELP_TEXT}`)
        this.d.store.setKv('begruesst', String(this.now))
        this.sendFailing = null
        const open = this.d.store.inState('neu', 'spaeter').length
        await this.d.onLive(open).catch((err) => this.d.log(`go-live-meldung: ${errText(err)}`))
      } catch (err) {
        this.sendFailed(err)
        return 0
      }
    }
    const due = this.d.store.inState('neu', 'spaeter').filter((r) => r.state === 'neu' || (r.snooze_until ?? 0) <= this.now)
    const to = this.questionTarget()
    for (const r of due) {
      try {
        const id = await this.d.tg.send(to, questionText(asked(r)), questionKeyboard(r.id, r, this.d.link(r.identifier)))
        this.sendFailing = null
        if (this.d.store.update(r.id, { state: 'gesendet', sent_at: this.now, message_id: id, chat_id: to.chat, thread_id: to.thread, snooze_until: null }, ['neu', 'spaeter'])) {
          this.d.store.remember(to.chat, id, r.id, 'frage', this.now)
          sent++
          this.d.log(`gesendet ${r.identifier} (#${r.id})`)
        }
      } catch (err) {
        this.d.log(`senden ${r.identifier}: ${errText(err)}`)
        this.sendFailed(err)
        break
      }
    }
    return sent
  }

  private sendFailed(err: unknown): void {
    this.sendPausedUntil = this.now + 120_000
    this.sendFailing = { since: this.sendFailing?.since ?? this.now, error: errText(err) }
  }

  /** null while sending works; otherwise since when it fails and the last error. */
  sendHealth(): { since: number; error: string } | null {
    return this.sendFailing
  }

  // ---------------------------------------------------------------- answers

  /** Only fl0w's account, and only in the private chat or a chat set as target. */
  private isOwner(fromId: number | undefined, chatId: number | undefined): boolean {
    if (fromId !== this.d.ownerChatId || chatId === undefined) return false
    const z = this.routing()
    return chatId === this.d.ownerChatId || chatId === z.fragen?.chat || chatId === z.beantwortet?.chat
  }

  async handle(u: TgUpdate): Promise<void> {
    try {
      await this.handleUpdate(u)
    } finally {
      this.inbound = null
    }
  }

  private async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query)
    const m = u.message
    if (!m) return
    if (!this.isOwner(m.from?.id, m.chat.id)) {
      this.d.log(`ignoriert: Nachricht von ${m.from?.id ?? '?'} in Chat ${m.chat.id}`)
      return
    }
    this.inbound = targetOf(m)
    // fl0w writes (e.g. pressed Start): sending works again, try right away.
    this.sendPausedUntil = 0
    const text = (m.text ?? '').trim()
    if (!text) return void (await this.reply('Hier kommt nur Text an der Karte an. Schreib deine Antwort bitte als Text.'))
    if (text.startsWith('/')) return this.onCommand(text)

    const replyTo = m.reply_to_message?.message_id
    const target = replyTo ? this.d.store.byMessage(m.chat.id, replyTo) : null
    if (target) {
      if (target.kind === 'bemerkung' || !ACTIVE.includes(target.row.state)) return this.addBemerkung(target.row, text)
      return this.answerText(target.row, text)
    }
    const pending = this.pendingBemerkung()
    if (pending) return this.addBemerkung(pending, text)

    const latest = <K extends keyof Row>(rows: Row[], key: K) => rows.sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0))[0]
    const sent = latest(this.d.store.inState('gesendet'), 'sent_at')
    const waiting = latest(this.d.store.inState('beantwortet'), 'answered_at')
    if (waiting && (!sent || (waiting.answered_at ?? 0) > (sent.sent_at ?? 0))) return this.addBemerkung(waiting, text)
    if (sent) return this.answerText(sent, text)
    const posted = latest(this.d.store.inState('weitergegeben'), 'posted_at')
    if (posted && (posted.posted_at ?? 0) > this.now - NACHTRAG_WINDOW_MS) return this.addBemerkung(posted, text)
    await this.reply(NONE_OPEN_TEXT)
  }

  /** Back to where fl0w wrote or tapped; without such an update to the question target. */
  private async reply(text: string, keyboard: Parameters<Tg['send']>[2] = null): Promise<number> {
    return this.d.tg.send(this.inbound ?? this.questionTarget(), text, keyboard)
  }

  private pendingBemerkung(): Row | null {
    const raw = this.d.store.getKv('bemerkung')
    if (!raw) return null
    const { id, at } = JSON.parse(raw) as { id: number; at: number }
    if (at < this.now - BEMERKUNG_WINDOW_MS) {
      this.d.store.setKv('bemerkung', null)
      return null
    }
    return this.d.store.get(id)
  }

  private async onCallback(cb: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    if (!this.isOwner(cb.from.id, cb.message?.chat.id)) {
      this.d.log(`ignoriert: Knopf von ${cb.from.id} in Chat ${cb.message?.chat.id ?? '?'}`)
      return
    }
    this.inbound = cb.message ? targetOf(cb.message) : null
    const m = /^([absn]):(\d+)(?::(j|n|o[a-e]))?$/.exec(cb.data ?? '')
    const row = m ? this.d.store.get(Number(m[2])) : null
    if (!m || !row) return void (await this.d.tg.answerCallback(cb.id, 'Diese Frage kenne ich nicht mehr.'))
    const [, action, , choice] = m

    if (action === 'a') {
      if (row.state === 'erledigt') {
        await this.d.tg.answerCallback(cb.id, 'In Multica schon erledigt.')
        if (row.message_id) await this.d.tg.edit(this.chatOf(row.chat_id), row.message_id, `${questionText(asked(row))}\n\nErledigt, ${row.closed_reason ?? 'in Multica'}.`, null).catch(() => {})
        return
      }
      if (!ACTIVE.includes(row.state)) return void (await this.d.tg.answerCallback(cb.id, `Schon beantwortet: ${answerHead(row, answerOf(row))}`))
      const a: Answer = choice === 'j' ? { kind: 'ja', option: null, bemerkung: null } : choice === 'n' ? { kind: 'nein', option: null, bemerkung: null } : { kind: 'option', option: choice!.slice(1), bemerkung: null }
      await this.d.tg.answerCallback(cb.id, `${answerHead(row, a).slice(0, 150)}: angekommen`)
      await this.record(row, a, 'knopf')
      return
    }
    if (action === 'b') {
      await this.d.tg.answerCallback(cb.id)
      const to = this.inbound ?? this.questionTarget()
      const id = await this.d.tg.send(to, `Bemerkung zu ${row.identifier}: schreib sie als Antwort auf diese Nachricht.`, null, true)
      this.d.store.remember(to.chat, id, row.id, 'bemerkung', this.now)
      this.d.store.setKv('bemerkung', JSON.stringify({ id: row.id, at: this.now }))
      return
    }
    if (action === 's') {
      if (row.state !== 'gesendet') return void (await this.d.tg.answerCallback(cb.id, 'Nicht mehr offen.'))
      const until = tomorrowNine(this.now)
      this.d.store.update(row.id, { state: 'spaeter', snooze_until: until }, ['gesendet'])
      await this.d.tg.answerCallback(cb.id, 'Kommt morgen um 9 Uhr wieder.')
      if (!row.message_id) return
      // Tidy targets: the postponed message goes, the question comes again as a new one.
      if (this.routing().nachAntwort !== 'behalten') await this.d.tg.delete(this.chatOf(row.chat_id), row.message_id).catch((err) => this.d.log(`loeschen ${row.identifier}: ${errText(err)}`))
      else await this.d.tg.edit(this.chatOf(row.chat_id), row.message_id, `${questionText(asked(row))}\n\nSpäter: kommt am ${berlin(until)} Uhr wieder.`, null).catch(() => {})
      return
    }
    // n: ask now (from /offen)
    if (row.state === 'spaeter' || row.state === 'neu') {
      this.d.store.update(row.id, { state: 'neu', snooze_until: null }, ['spaeter', 'neu'])
      await this.d.tg.answerCallback(cb.id, 'Kommt sofort.')
      await this.sendDue()
    } else {
      await this.d.tg.answerCallback(cb.id, row.state === 'gesendet' ? 'Steht schon im Chat, siehe weiter oben.' : 'Nicht mehr offen.')
    }
  }

  private async answerText(row: Row, text: string): Promise<void> {
    const a = parseTextAnswer(text, row.optionen)
    if (!(await this.record(row, a, 'text'))) await this.addBemerkung(this.d.store.get(row.id)!, text)
  }

  /** Store the answer, freeze the question message (buttons gone) and confirm. */
  private async record(row: Row, a: Answer, via: 'knopf' | 'text'): Promise<boolean> {
    const now = this.now
    const ok = this.d.store.update(
      row.id,
      { state: 'beantwortet', answer_kind: a.kind, answer_option: a.option, bemerkung: a.bemerkung, via, answered_at: now, last_input_at: now },
      [...ACTIVE],
    )
    if (!ok) return false
    this.clearPending(row.id)
    this.d.log(`antwort ${row.identifier}: ${a.kind}${a.option ? ` ${a.option}` : ''} per ${via}`)
    if (row.message_id) {
      await this.d.tg.edit(this.chatOf(row.chat_id), row.message_id, `${questionText(asked(row))}\n\nAntwort ${berlin(now)}: ${answerLine(row, a)}`, null).catch((err) => this.d.log(`edit ${row.identifier}: ${errText(err)}`))
    }
    const to = this.inbound ?? (row.chat_id ? { chat: row.chat_id, thread: row.thread_id } : this.questionTarget())
    const cid = await this.d.tg.send(to, confirmText(asked(row), a, Math.round(this.d.graceMs / 1000)), confirmKeyboard(row.id, this.d.link(row.identifier)))
    this.d.store.remember(to.chat, cid, row.id, 'bestaetigung', now)
    this.d.store.update(row.id, { confirm_message_id: cid, confirm_chat_id: to.chat })
    return true
  }

  private clearPending(id: number): void {
    const raw = this.d.store.getKv('bemerkung')
    if (raw && (JSON.parse(raw) as { id: number }).id === id) this.d.store.setKv('bemerkung', null)
  }

  private async addBemerkung(row: Row, text: string): Promise<void> {
    const t = text.trim().slice(0, 2000)
    this.clearPending(row.id)
    if (ACTIVE.includes(row.state)) {
      await this.record(row, { kind: 'bemerkung', option: null, bemerkung: t }, 'text')
      return
    }
    if (row.state === 'beantwortet' && !row.commented_at) {
      const bemerkung = [row.bemerkung, t].filter(Boolean).join('\n')
      this.d.store.update(row.id, { bemerkung, last_input_at: this.now }, ['beantwortet'])
      await this.reply(`Verstanden für ${row.identifier}: Bemerkung „${t}“. Sie geht zusammen mit deiner Antwort an die Karte.\nFrage: ${row.frage}`)
      return
    }
    // Already on the card (or the card closed meanwhile): the Bemerkung follows as Nachtrag.
    try {
      await this.d.board().addComment(row.issue_id, nachtragText(row, t, this.now))
      await this.reply(`Verstanden für ${row.identifier}: Bemerkung „${t}“. Sie steht jetzt als Nachtrag an der Karte.\nFrage: ${row.frage}`)
      this.d.log(`nachtrag ${row.identifier}`)
    } catch (err) {
      await this.reply(`Deine Bemerkung zu ${row.identifier} kam nicht in Multica an (${errText(err)}). Bitte gleich noch einmal schicken.`)
    }
  }

  // ---------------------------------------------------------------- deliver

  /** Answers whose grace period is over go to the card; then the card's next step. */
  async flush(): Promise<number> {
    let done = 0
    for (const r of this.d.store.inState('beantwortet')) {
      if ((r.last_input_at ?? 0) > this.now - this.d.graceMs) continue
      try {
        const step = await this.deliver(r)
        this.d.store.update(r.id, { state: 'weitergegeben', posted_at: this.now, next_step: step, post_error: null }, ['beantwortet'])
        this.d.log(`weitergegeben ${r.identifier}: ${step}`)
        done++
        const cur = this.d.store.get(r.id)!
        if (this.routing().nachAntwort !== 'behalten') {
          await this.retire(cur, `${questionText(asked(cur), false)}\n\nAntwort ${berlin(cur.answered_at ?? this.now)}: ${answerLine(cur, answerOf(cur))}\nSteht an der Karte. ${step}`)
        } else if (r.confirm_message_id) {
          await this.d.tg
            .edit(this.chatOf(r.confirm_chat_id), r.confirm_message_id, `${confirmText(asked(r), answerOf(r), 0).split('\n\n')[0]}\n\nSteht an der Karte. ${step}`, confirmKeyboard(r.id, this.d.link(r.identifier)))
            .catch(() => {})
        }
      } catch (err) {
        const e = errText(err)
        this.d.store.update(r.id, { post_error: e })
        this.d.log(`weitergabe ${r.identifier}: ${e}`)
        if (!r.post_alarm_at && (r.answered_at ?? 0) < this.now - POST_ALARM_MS) {
          this.d.store.update(r.id, { post_alarm_at: this.now })
          const what = this.d.store.get(r.id)?.commented_at ? 'steht an der Karte, aber der nächste Schritt klappt seit 30 Minuten nicht' : 'ist seit 30 Minuten nicht in Multica angekommen'
          await this.reply(`Deine Antwort zu ${r.identifier} ${what} (${e}). Ich versuche es weiter, du musst nichts tun.`).catch(() => {})
        }
      }
    }
    return done
  }

  /**
   * Question done (answer on the card, or closed in Multica) and the target is to stay tidy:
   * "verschieben" posts `summary` to the answered target first; then question and confirmation
   * are deleted. If the summary cannot be sent, the originals stay, so nothing is lost.
   */
  private async retire(r: Row, summary: string): Promise<void> {
    const z = this.routing()
    if (z.nachAntwort === 'verschieben' && z.beantwortet) {
      try {
        const id = await this.d.tg.send(z.beantwortet, summary, confirmKeyboard(r.id, this.d.link(r.identifier)))
        // A reply to the moved message still reaches the card as Nachtrag.
        this.d.store.remember(z.beantwortet.chat, id, r.id, 'bestaetigung', this.now)
      } catch (err) {
        this.d.log(`verschieben ${r.identifier}: ${errText(err)}`)
        return
      }
    }
    for (const [chat, id] of [[r.chat_id, r.message_id], [r.confirm_chat_id, r.confirm_message_id]] as const) {
      if (id) await this.d.tg.delete(this.chatOf(chat), id).catch((err) => this.d.log(`loeschen ${r.identifier}: ${errText(err)}`))
    }
  }

  /**
   * Comment as fl0w, then what the card itself foresees. Returns a sentence for fl0w.
   * `commented_at` marks the comment as posted, so a retry after a failed next step never posts it twice.
   */
  private async deliver(r: Row): Promise<string> {
    const b = this.d.board()
    if (!r.commented_at) {
      await b.addComment(r.issue_id, commentText(asked(r), answerOf(r), r.via ?? 'text', r.answered_at ?? this.now))
      this.d.store.update(r.id, { commented_at: this.now })
    }
    const i = await b.getIssue(r.issue_id)
    if (i.assignee_type === 'agent' || i.assignee_type === 'squad') {
      // fl0w's comment wakes the assigned agent; a blocked card goes back into the queue.
      if (i.status === 'blocked') {
        await b.updateIssue(i.id, { status: 'todo' })
        return 'Der zuständige Agent ist geweckt, die Karte steht wieder auf todo.'
      }
      return 'Der zuständige Agent ist geweckt.'
    }
    if (r.done_after_answer && !['done', 'cancelled'].includes(i.status)) {
      await b.updateIssue(i.id, { status: 'done' })
      return 'Die Karte steht auf done, wie sie es vorsieht.'
    }
    return 'Die Karte nennt keinen weiteren Schritt.'
  }

  // ---------------------------------------------------------------- commands

  private async onCommand(text: string): Promise<void> {
    const cmd = text.split(/[\s@]/)[0].toLowerCase()
    if (cmd === '/offen') return this.sendOpenList()
    await this.reply(HELP_TEXT)
  }

  /** /offen: a fresh scan, then every open decision with a link; postponed ones can be asked now. */
  async sendOpenList(): Promise<void> {
    try {
      await this.scan()
    } catch (err) {
      this.d.log(`scan fuer /offen: ${errText(err)}`)
    }
    const rows = this.d.store.inState(...ACTIVE, 'beantwortet')
    if (!rows.length) return void (await this.reply('Keine offenen Entscheidungen in den aktiven Projekten.'))
    const lines = rows.map((r) => {
      const stand = r.state === 'spaeter' ? `später, kommt ${berlin(r.snooze_until ?? 0)}` : r.state === 'beantwortet' ? (r.commented_at ? 'steht an der Karte, nächster Schritt folgt' : 'beantwortet, geht gleich an die Karte') : r.state === 'neu' ? 'kommt gleich' : 'steht im Chat'
      return `• ${header(r).replace('Entscheidung für ', '')}: ${r.frage.slice(0, 140)} (${stand})`
    })
    const keyboard = rows.slice(0, 30).map((r) => [
      { text: `${r.identifier} öffnen`, url: this.d.link(r.identifier) },
      ...(r.state === 'spaeter' ? [{ text: `${r.identifier} jetzt fragen`, callback_data: `n:${r.id}` }] : []),
    ])
    await this.reply(`Offene Entscheidungen (${rows.length}):\n\n${lines.join('\n')}`.slice(0, 4000), keyboard)
  }
}

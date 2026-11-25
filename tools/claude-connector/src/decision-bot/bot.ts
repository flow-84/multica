// Decision bot @multicafl0wbot (MS-4379): every open decision card of every active
// Multica project reaches fl0w as one Telegram message with buttons; the answer goes
// back to the card as a comment by fl0w, then the card's next step is triggered.
//
// Flow per question (states in store.ts):
//   scan()     reads the open cards, adds new questions, closes ones the card no longer asks
//   sendDue()  sends new and due postponed questions
//   handle()   buttons and texts from fl0w; every other chat and every other group member is ignored
//   flush()    after the grace period the answer (with any Bemerkung) goes to the card
//
// Group mode (MS-4383): with `groupId` the questions go into fl0w's forum group, topics
// Offen (Dringend for priority urgent/high), Später, Beantwortet and Bot-Status. An answered or
// postponed question is deleted from Offen/Dringend, so only open ones stay there. When the group
// cannot be reached, the private chat takes over and the questions move back once it works.
import type { Comment, Issue, Project } from '../multica.ts'
import { INACTIVE_PROJECT_STATUSES, OPEN_STATUSES, extractQuestion, externalQuestion, isCandidate, type Question } from './detect.ts'
import { ACTIVE, type Row, type Store } from './store.ts'
import type { Keyboard, Tg, TgUpdate } from './telegram.ts'
import {
  type Answer,
  type AskedQuestion,
  HELP_TEXT,
  NONE_OPEN_TEXT,
  answerHead,
  answerLine,
  berlin,
  commentText,
  GROUP_HELP_TEXT,
  confirmKeyboard,
  confirmText,
  entryText,
  header,
  nachtragText,
  parseTextAnswer,
  questionKeyboard,
  questionText,
  spaeterKeyboard,
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
  /** fl0w's Telegram id; the private chat id is the same number. */
  ownerChatId: number
  /** fl0w's forum group (MS-4383); null = private chat only. */
  groupId?: number | null
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
/** Telegram deletes nothing older than 48 hours, so group questions are posted anew before that. */
const REFRESH_MS = 40 * 3_600_000
const GROUP_PAUSE_MS = 120_000

export const TOPICS = { offen: 'Offen', dringend: 'Dringend', spaeter: 'Später', beantwortet: 'Beantwortet', status: 'Bot-Status' } as const
export type Topic = keyof typeof TOPICS
const TOPIC_COLORS: Record<Topic, number> = { offen: 7322096, dringend: 16478047, spaeter: 16766590, beantwortet: 9367192, status: 13338331 }
const URGENT = new Set(['urgent', 'high'])
/** Where a message goes: a chat id and, in the group, the topic. */
interface Place {
  chat: number
  thread: number | null
}
const topicGone = (err: unknown) => /thread not found|TOPIC_(ID_INVALID|DELETED|CLOSED)/i.test(errText(err))

const asked = (r: Row): AskedQuestion => ({ identifier: r.identifier, project: r.project, frage: r.frage, empfehlung: r.empfehlung, optionen: r.optionen, quelle: r.quelle })
const answerOf = (r: Row): Answer => ({ kind: r.answer_kind ?? 'bemerkung', option: r.answer_option, bemerkung: r.bemerkung })
const errText = (err: unknown) => ((err as Error)?.message ?? String(err)).slice(0, 300)

export class DecisionBot {
  private readonly d: Required<BotDeps>
  /** Last evaluation per card, keyed by its last activity, so unchanged cards are not re-read. */
  private readonly cache = new Map<string, { activity: string; q: Question | null }>()
  /** After a refused send (e.g. fl0w has not pressed Start yet) the next try waits a little. */
  private sendPausedUntil = 0
  /** Since when sending to fl0w fails without a break, and why (for the alarm in main). */
  private sendFailing: { since: number; error: string } | null = null
  /** After a group error the private chat takes over for a little while. */
  private groupPausedUntil = 0
  /** Where the update being handled came from; replies go there. */
  private here: Place

  constructor(deps: BotDeps) {
    this.d = { now: Date.now, graceMs: 120_000, log: () => {}, onLive: async () => {}, groupId: null, ...deps }
    this.here = { chat: this.d.ownerChatId, thread: null }
  }

  // ---------------------------------------------------------------- places

  /** Store key of a chat: 0 = fl0w's private chat. */
  private key(chat: number): number {
    return chat === this.d.ownerChatId ? 0 : chat
  }

  private chatOf(key: number | null): number {
    return key ? key : this.d.ownerChatId
  }

  private questionTopic(r: Row): Topic {
    return r.state === 'spaeter' ? 'spaeter' : URGENT.has(r.priority ?? '') ? 'dringend' : 'offen'
  }

  private groupFailed(what: string, err: unknown): void {
    this.groupPausedUntil = this.now + GROUP_PAUSE_MS
    this.d.log(`gruppe ${what}: ${errText(err)}`)
  }

  /** The topic in the group, created on first use; null without group or while it fails. */
  private async topic(t: Topic): Promise<Place | null> {
    const g = this.d.groupId
    if (!g || this.now < this.groupPausedUntil) return null
    let thread = Number(this.d.store.getKv(`topic:${t}`) ?? 0)
    if (!thread) {
      try {
        thread = await this.d.tg.createTopic(g, TOPICS[t], TOPIC_COLORS[t])
      } catch (err) {
        this.groupFailed(`thema ${TOPICS[t]} anlegen`, err)
        return null
      }
      this.d.store.setKv(`topic:${t}`, String(thread))
      this.d.log(`thema ${TOPICS[t]} angelegt (${thread})`)
    }
    return { chat: g, thread }
  }

  /** Send into a group topic; null when there is no group or it fails. A deleted topic is created anew. */
  private async postGroup(t: Topic, text: string, keyboard: Keyboard = null, forceReply = false): Promise<{ place: Place; id: number } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const place = await this.topic(t)
      if (!place) return null
      try {
        return { place, id: await this.d.tg.send(place.chat, text, keyboard, forceReply, place.thread) }
      } catch (err) {
        if (attempt === 0 && topicGone(err)) {
          this.d.store.setKv(`topic:${t}`, null)
          continue
        }
        this.groupFailed(`senden in ${TOPICS[t]}`, err)
        return null
      }
    }
    return null
  }

  /** Group topic `t` if possible, otherwise fl0w's private chat (the fallback). */
  private async post(t: Topic | null, text: string, keyboard: Keyboard = null, forceReply = false): Promise<{ place: Place; id: number }> {
    const g = t ? await this.postGroup(t, text, keyboard, forceReply) : null
    if (g) return g
    return { place: { chat: this.d.ownerChatId, thread: null }, id: await this.d.tg.send(this.d.ownerChatId, text, keyboard, forceReply) }
  }

  /** Take a question message away: deleted in the group, frozen with `text` in the private chat. */
  private async drop(r: Row, text: string): Promise<void> {
    if (!r.message_id) return
    const chat = this.chatOf(r.chat_key)
    if (chat !== this.d.ownerChatId) {
      try {
        await this.d.tg.delete(chat, r.message_id)
        return
      } catch (err) {
        this.d.log(`loeschen ${r.identifier}: ${errText(err)}`)
      }
    }
    await this.d.tg.edit(chat, r.message_id, text, null).catch((err) => this.d.log(`edit ${r.identifier}: ${errText(err)}`))
  }

  private get now(): number {
    return this.d.now()
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
      // A new priority moves the question between Offen and Dringend (relocate in sendDue).
      for (const r of rows) if (r.priority !== i.priority) this.d.store.update(r.id, { priority: i.priority })
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
        priority: i.priority,
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
      priority: i.priority,
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
    if (r.state === 'gesendet' || (r.state === 'spaeter' && r.chat_key)) await this.drop(r, `${questionText(asked(r))}\n\nErledigt, ${reason}. Die Knöpfe sind entfernt.`)
  }

  // ---------------------------------------------------------------- send

  /** Send new questions and postponed ones that are due. Stops at the first Telegram error. */
  async sendDue(): Promise<number> {
    let sent = 0
    if (this.now < this.sendPausedUntil) return 0
    if (!this.d.store.getKv('begruesst')) {
      try {
        await this.d.tg.send(this.d.ownerChatId, `Der Entscheidungs-Bot ist live. ${HELP_TEXT}`)
        this.d.store.setKv('begruesst', String(this.now))
        this.sendFailing = null
        const open = this.d.store.inState('neu', 'spaeter').length
        await this.d.onLive(open).catch((err) => this.d.log(`go-live-meldung: ${errText(err)}`))
      } catch (err) {
        this.sendFailed(err)
        return 0
      }
    }
    await this.greetGroup()
    const due = this.d.store.inState('neu', 'spaeter').filter((r) => r.state === 'neu' || (r.snooze_until ?? 0) <= this.now)
    for (const r of due) {
      try {
        const { place, id } = await this.post(URGENT.has(r.priority ?? '') ? 'dringend' : 'offen', questionText(asked(r)), questionKeyboard(r.id, r, this.d.link(r.identifier)))
        this.sendFailing = null
        if (this.d.store.update(r.id, { state: 'gesendet', sent_at: this.now, message_id: id, chat_key: this.key(place.chat), thread_id: place.thread, snooze_until: null }, ['neu', 'spaeter'])) {
          this.d.store.remember(this.key(place.chat), id, r.id, 'frage', this.now)
          sent++
          this.d.log(`gesendet ${r.identifier} (#${r.id})${place.thread ? ` in Thema ${place.thread}` : ''}`)
          // A postponed question leaves the topic Später.
          if (r.message_id && r.chat_key) await this.drop(r, questionText(asked(r)))
        }
      } catch (err) {
        this.d.log(`senden ${r.identifier}: ${errText(err)}`)
        this.sendFailed(err)
        break
      }
    }
    await this.relocate()
    return sent
  }

  /** First contact with the group: all five topics exist, one greeting in Bot-Status. */
  private async greetGroup(): Promise<void> {
    if (!this.d.groupId || this.d.store.getKv('gruppe_begruesst')) return
    for (const t of Object.keys(TOPICS) as Topic[]) if (!(await this.topic(t))) return
    if (await this.postGroup('status', GROUP_HELP_TEXT)) this.d.store.setKv('gruppe_begruesst', String(this.now))
  }

  /**
   * Questions in the wrong place move: from the private chat into the group once it works, between
   * Offen and Dringend after a priority change, and anew before Telegram's 48-hour delete limit.
   */
  private async relocate(): Promise<void> {
    if (!this.d.groupId) return
    for (const r of this.d.store.inState('gesendet')) {
      const t = this.questionTopic(r)
      const want = await this.topic(t)
      if (!want) return
      if (r.chat_key === want.chat && r.thread_id === want.thread && (r.sent_at ?? 0) > this.now - REFRESH_MS) continue
      const moved = await this.postGroup(t, questionText(asked(r)), questionKeyboard(r.id, r, this.d.link(r.identifier)))
      if (!moved) return
      this.d.store.update(r.id, { message_id: moved.id, chat_key: moved.place.chat, thread_id: moved.place.thread, sent_at: this.now }, ['gesendet'])
      this.d.store.remember(moved.place.chat, moved.id, r.id, 'frage', this.now)
      this.d.log(`verschoben ${r.identifier} nach ${TOPICS[t]}`)
      await this.drop(r, `${questionText(asked(r))}\n\nSteht jetzt in der Gruppe im Thema ${TOPICS[t]}.`)
    }
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

  private inGroup(chatId: number | undefined): boolean {
    return !!this.d.groupId && chatId === this.d.groupId
  }

  /** Only fl0w counts: in the private chat with him, or as himself (not anonymous) in his group. */
  private isOwner(fromId: number | undefined, chatId: number | undefined): boolean {
    return fromId === this.d.ownerChatId && (chatId === this.d.ownerChatId || this.inGroup(chatId))
  }

  /** Is this thread one of the question topics, where only open questions may stay? */
  private isQuestionTopic(thread: number | null): boolean {
    return !!thread && (['offen', 'dringend', 'spaeter'] as Topic[]).some((t) => Number(this.d.store.getKv(`topic:${t}`) ?? 0) === thread)
  }

  async handle(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query)
    const m = u.message
    if (!m) return
    const group = this.inGroup(m.chat.id)
    if (!(group || m.chat.type === 'private') || !this.isOwner(m.from?.id, m.chat.id)) {
      this.d.log(`ignoriert: Nachricht von ${m.from?.id ?? '?'} in Chat ${m.chat.id}`)
      return
    }
    // fl0w writes (e.g. pressed Start): sending works again, try right away.
    this.sendPausedUntil = 0
    this.here = { chat: m.chat.id, thread: m.message_thread_id ?? null }
    const text = (m.text ?? '').trim()
    // Service messages of the group (topic created, member added) carry no text.
    if (!text && group) return
    if (!text) return void (await this.reply('Hier kommt nur Text an der Karte an. Schreib deine Antwort bitte als Text.'))
    if (text.startsWith('/')) return this.onCommand(text)

    // In a topic every message "replies" to the topic's first message; that is no reply to a question.
    const replyTo = m.reply_to_message?.message_id
    const target = replyTo && replyTo !== m.message_thread_id ? this.d.store.byMessage(this.key(m.chat.id), replyTo) : null
    const prompt = target ? (target.kind === 'bemerkung' ? replyTo! : 0) : (this.pendingPrompt() ?? 0)
    try {
      await this.route(text, target)
    } finally {
      // Offen, Dringend and Später keep only open questions: fl0w's text and the Bemerkung prompt go.
      if (group && this.isQuestionTopic(this.here.thread)) {
        for (const id of [m.message_id, prompt]) if (id) await this.d.tg.delete(m.chat.id, id).catch(() => {})
      }
    }
  }

  private async route(text: string, target: { row: Row; kind: string } | null): Promise<void> {
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
    await this.replyHere(NONE_OPEN_TEXT)
  }

  /** Reply where fl0w wrote (commands, lists). */
  private async replyHere(text: string, keyboard: Keyboard = null): Promise<number> {
    return this.d.tg.send(this.here.chat, text, keyboard, false, this.here.thread)
  }

  /** Reply about an answer: in the group into Beantwortet, so the question topics stay clean. */
  private async reply(text: string, keyboard: Keyboard = null): Promise<number> {
    if (this.inGroup(this.here.chat)) return (await this.post('beantwortet', text, keyboard)).id
    return this.replyHere(text, keyboard)
  }

  /** Message id of the open Bemerkung prompt in the chat being handled, if any. */
  private pendingPrompt(): number | null {
    const raw = this.d.store.getKv('bemerkung')
    if (!raw) return null
    const p = JSON.parse(raw) as { chat?: number; msg?: number }
    return p.msg && p.chat === this.here.chat ? p.msg : null
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
      this.d.log(`ignoriert: Knopf von ${cb.from.id}`)
      return
    }
    const m = /^([absn]):(\d+)(?::(j|n|o[a-e]))?$/.exec(cb.data ?? '')
    const row = m ? this.d.store.get(Number(m[2])) : null
    if (!m || !row) return void (await this.d.tg.answerCallback(cb.id, 'Diese Frage kenne ich nicht mehr.'))
    const [, action, , choice] = m
    this.here = { chat: cb.message!.chat.id, thread: cb.message!.message_thread_id ?? null }

    if (action === 'a') {
      if (row.state === 'erledigt') {
        await this.d.tg.answerCallback(cb.id, 'In Multica schon erledigt.')
        await this.drop(row, `${questionText(asked(row))}\n\nErledigt, ${row.closed_reason ?? 'in Multica'}.`)
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
      const id = await this.d.tg.send(this.here.chat, `Bemerkung zu ${row.identifier}: schreib sie als Antwort auf diese Nachricht.`, null, true, this.here.thread)
      this.d.store.remember(this.key(this.here.chat), id, row.id, 'bemerkung', this.now)
      this.d.store.setKv('bemerkung', JSON.stringify({ id: row.id, at: this.now, chat: this.here.chat, msg: id }))
      return
    }
    if (action === 's') {
      if (row.state !== 'gesendet') return void (await this.d.tg.answerCallback(cb.id, 'Nicht mehr offen.'))
      const until = tomorrowNine(this.now)
      this.d.store.update(row.id, { state: 'spaeter', snooze_until: until }, ['gesendet'])
      await this.d.tg.answerCallback(cb.id, 'Kommt morgen um 9 Uhr wieder.')
      const text = `${questionText(asked(row))}\n\nSpäter: kommt am ${berlin(until)} Uhr wieder${row.chat_key ? ' in Offen' : ''}.`
      if (!row.chat_key) {
        if (row.message_id) await this.d.tg.edit(this.d.ownerChatId, row.message_id, text, null).catch(() => {})
        return
      }
      // Group: the question leaves Offen/Dringend and waits in the topic Später.
      await this.drop(row, text)
      const moved = await this.post('spaeter', text, spaeterKeyboard(row.id, this.d.link(row.identifier))).catch((err) => {
        this.d.log(`spaeter ${row.identifier}: ${errText(err)}`)
        return null
      })
      this.d.store.update(row.id, moved ? { message_id: moved.id, chat_key: this.key(moved.place.chat), thread_id: moved.place.thread } : { message_id: null })
      if (moved) this.d.store.remember(this.key(moved.place.chat), moved.id, row.id, 'frage', this.now)
      return
    }
    // n: ask now (from /offen)
    if (row.state === 'spaeter' || row.state === 'neu') {
      this.d.store.update(row.id, { state: 'neu', snooze_until: null }, ['spaeter', 'neu'])
      await this.d.tg.answerCallback(cb.id, 'Kommt sofort.')
      await this.sendDue()
    } else {
      await this.d.tg.answerCallback(cb.id, row.state === 'gesendet' ? (row.chat_key ? `Steht schon im Thema ${TOPICS[this.questionTopic(row)]}.` : 'Steht schon im Chat, siehe weiter oben.') : 'Nicht mehr offen.')
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
    // Private chat: the question stays, frozen with the answer. Group: it leaves Offen/Dringend.
    await this.drop(row, `${questionText(asked(row))}\n\nAntwort ${berlin(now)}: ${answerLine(row, a)}`)
    const graceSec = Math.round(this.d.graceMs / 1000)
    const group = !!row.chat_key
    const { place, id: cid } = await this.post(
      group ? 'beantwortet' : null,
      group ? entryText(asked(row), a, now, graceSec, null) : confirmText(asked(row), a, graceSec),
      confirmKeyboard(row.id, this.d.link(row.identifier)),
    )
    this.d.store.remember(this.key(place.chat), cid, row.id, 'bestaetigung', now)
    this.d.store.update(row.id, { confirm_message_id: cid, confirm_chat: this.key(place.chat) })
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
        if (r.confirm_message_id) {
          const fin = this.d.store.get(r.id)!
          const text = fin.confirm_chat
            ? entryText(asked(fin), answerOf(fin), fin.answered_at ?? this.now, 0, `Steht an der Karte. ${step}`)
            : `${confirmText(asked(fin), answerOf(fin), 0).split('\n\n')[0]}\n\nSteht an der Karte. ${step}`
          await this.d.tg.edit(this.chatOf(fin.confirm_chat), r.confirm_message_id, text, confirmKeyboard(r.id, this.d.link(r.identifier))).catch(() => {})
        }
      } catch (err) {
        const e = errText(err)
        this.d.store.update(r.id, { post_error: e })
        this.d.log(`weitergabe ${r.identifier}: ${e}`)
        if (!r.post_alarm_at && (r.answered_at ?? 0) < this.now - POST_ALARM_MS) {
          this.d.store.update(r.id, { post_alarm_at: this.now })
          const what = this.d.store.get(r.id)?.commented_at ? 'steht an der Karte, aber der nächste Schritt klappt seit 30 Minuten nicht' : 'ist seit 30 Minuten nicht in Multica angekommen'
          await this.post('status', `Deine Antwort zu ${r.identifier} ${what} (${e}). Ich versuche es weiter, du musst nichts tun.`).catch(() => {})
        }
      }
    }
    return done
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
    await this.replyHere(this.inGroup(this.here.chat) ? GROUP_HELP_TEXT : HELP_TEXT)
  }

  /** /offen: a fresh scan, then every open decision with a link; postponed ones can be asked now. */
  async sendOpenList(): Promise<void> {
    try {
      await this.scan()
    } catch (err) {
      this.d.log(`scan fuer /offen: ${errText(err)}`)
    }
    const rows = this.d.store.inState(...ACTIVE, 'beantwortet')
    if (!rows.length) return void (await this.replyHere('Keine offenen Entscheidungen in den aktiven Projekten.'))
    const lines = rows.map((r) => {
      const stand = r.state === 'spaeter' ? `später, kommt ${berlin(r.snooze_until ?? 0)}` : r.state === 'beantwortet' ? (r.commented_at ? 'steht an der Karte, nächster Schritt folgt' : 'beantwortet, geht gleich an die Karte') : r.state === 'neu' ? 'kommt gleich' : r.chat_key ? `steht in ${TOPICS[this.questionTopic(r)]}` : 'steht im Chat'
      return `• ${header(r).replace('Entscheidung für ', '')}: ${r.frage.slice(0, 140)} (${stand})`
    })
    const keyboard = rows.slice(0, 30).map((r) => [
      { text: `${r.identifier} öffnen`, url: this.d.link(r.identifier) },
      ...(r.state === 'spaeter' ? [{ text: `${r.identifier} jetzt fragen`, callback_data: `n:${r.id}` }] : []),
    ])
    await this.replyHere(`Offene Entscheidungen (${rows.length}):\n\n${lines.join('\n')}`.slice(0, 4000), keyboard)
  }
}

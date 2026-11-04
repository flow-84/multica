// Multica -> Trello mirror and the manual Trello -> Multica pull (MS-3182).
//
// Every linked card has a snapshot of the card fields the sync last wrote or
// last accepted from Trello. Pushing compares the card Multica wants with that
// snapshot and writes only the difference, so a Trello edit survives until it
// is pulled or Multica changes the same field. Pulling compares the live card
// with the snapshot and turns every difference into a Multica change.
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type Agent, type Comment, type Issue, type Member, type MulticaApi, MulticaError } from '../multica.ts'
import { MIRRORED_STATUS, type Pair } from './config.ts'
import { type TCard, type TLabel, type TList, type Trello, TrelloError } from './trello.ts'

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trello_cards (
  issue_id   TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  board_id   TEXT NOT NULL,
  card_id    TEXT NOT NULL UNIQUE,
  snapshot   TEXT NOT NULL,
  linked_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trello_comments (
  multica_comment_id TEXT NOT NULL UNIQUE,
  trello_action_id   TEXT NOT NULL UNIQUE,
  card_id            TEXT NOT NULL,
  origin             TEXT NOT NULL CHECK (origin IN ('multica', 'trello')),
  at                 TEXT NOT NULL
);
`

export function openSyncDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  if (path !== ':memory:') chmodSync(path, 0o600)
  return db
}

/** The card fields the sync owns. */
export interface Snapshot {
  name: string
  desc: string
  idList: string
  /** Id of the sync-owned priority label on the card, null for none. */
  priorityLabel: string | null
  due: string | null
  closed: boolean
  /** null: the pair maps no members, card members are left alone. */
  idMembers: string[] | null
}

export interface Link {
  issueId: string
  identifier: string
  boardId: string
  cardId: string
  snapshot: Snapshot
  linkedAt: string
}

interface LinkRow {
  issue_id: string
  identifier: string
  board_id: string
  card_id: string
  snapshot: string
  linked_at: string
}

const toLink = (r: LinkRow | undefined): Link | undefined =>
  r && { issueId: r.issue_id, identifier: r.identifier, boardId: r.board_id, cardId: r.card_id, snapshot: JSON.parse(r.snapshot), linkedAt: r.linked_at }

export class SyncStore {
  readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
  }
  byIssue(issueId: string): Link | undefined {
    return toLink(this.db.prepare('SELECT * FROM trello_cards WHERE issue_id = ?').get(issueId) as LinkRow | undefined)
  }
  byCard(cardId: string): Link | undefined {
    return toLink(this.db.prepare('SELECT * FROM trello_cards WHERE card_id = ?').get(cardId) as LinkRow | undefined)
  }
  byBoard(boardId: string): Link[] {
    return (this.db.prepare('SELECT * FROM trello_cards WHERE board_id = ?').all(boardId) as unknown as LinkRow[]).map((r) => toLink(r) as Link)
  }
  link(l: Link): void {
    this.db
      .prepare(
        `INSERT INTO trello_cards (issue_id, identifier, board_id, card_id, snapshot, linked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (issue_id) DO UPDATE SET identifier = excluded.identifier, board_id = excluded.board_id, card_id = excluded.card_id,
           snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
      )
      .run(l.issueId, l.identifier, l.boardId, l.cardId, JSON.stringify(l.snapshot), l.linkedAt, new Date().toISOString())
  }
  setSnapshot(issueId: string, s: Snapshot): void {
    this.db.prepare('UPDATE trello_cards SET snapshot = ?, updated_at = ? WHERE issue_id = ?').run(JSON.stringify(s), new Date().toISOString(), issueId)
  }
  unlink(issueId: string): void {
    this.db.prepare('DELETE FROM trello_cards WHERE issue_id = ?').run(issueId)
  }
  commentKnown(multicaId: string | null, trelloId: string | null): boolean {
    return !!this.db.prepare('SELECT 1 FROM trello_comments WHERE multica_comment_id = ? OR trello_action_id = ?').get(multicaId ?? '', trelloId ?? '')
  }
  recordComment(multicaId: string, trelloId: string, cardId: string, origin: 'multica' | 'trello'): void {
    this.db
      .prepare('INSERT OR IGNORE INTO trello_comments (multica_comment_id, trello_action_id, card_id, origin, at) VALUES (?, ?, ?, ?, ?)')
      .run(multicaId, trelloId, cardId, origin, new Date().toISOString())
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

const BERLIN = 'Europe/Berlin'
const berlinFmt = new Intl.DateTimeFormat('de-DE', { timeZone: BERLIN, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: BERLIN, year: 'numeric', month: '2-digit', day: '2-digit' })
const berlinHour = new Intl.DateTimeFormat('en-GB', { timeZone: BERLIN, hour: '2-digit', hourCycle: 'h23' })

/** "04.11.2026, 14:36" in Berlin time; storage stays UTC. */
export const berlin = (iso: string) => berlinFmt.format(new Date(iso))

/** Multica calendar date -> Trello due: 12:00 Berlin time, as UTC. Noon keeps the date in every time zone. */
export function dueFromDate(date: string | null | undefined): string | null {
  if (!date) return null
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, 12)
  const offset = Number(berlinHour.format(new Date(guess))) - 12
  return new Date(guess - offset * 3_600_000).toISOString()
}

/** Trello due -> Multica calendar date in Berlin time. */
export const dateFromDue = (due: string | null): string | null => (due ? berlinDate.format(new Date(due)) : null)

/** Mention links to plain names: "[@Builder](mention://agent/…)" -> "@Builder". */
const plain = (md: string) => md.replace(/\[([^\]]+)\]\(mention:\/\/[^)]+\)/g, '$1')

export const STATUS_DE: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Zu erledigen',
  in_progress: 'In Arbeit',
  in_review: 'Im Review',
  done: 'Erledigt',
  blocked: 'Blockiert',
  cancelled: 'Abgebrochen',
}

const PRIORITY_LABEL: Record<string, { name: string; color: string }> = {
  urgent: { name: 'Priorität: dringend', color: 'red' },
  high: { name: 'Priorität: hoch', color: 'orange' },
  medium: { name: 'Priorität: mittel', color: 'yellow' },
  low: { name: 'Priorität: niedrig', color: 'green' },
}

const FOOTER = '---\nMultica: '
const CUT = '\n\n… (gekürzt, vollständig in Multica)'
/** Trello allows 16384 characters in a description and a comment. */
const TRELLO_MAX = 16_000
/** First line of every comment the pull writes into Multica; the push never sends these back. */
export const PULL_MARK = 'Aus Trello von '
const ID_PREFIX = /^\s*[A-Z]+-\d+:\s*/

/** Description part of a card, without the sync footer. */
export function cardBody(desc: string): string {
  const i = desc.lastIndexOf(FOOTER)
  return (i >= 0 ? desc.slice(0, i) : desc).trimEnd()
}

/** Card title without the "MS-123: " prefix. */
export const cardTitle = (name: string) => name.replace(ID_PREFIX, '').trim()

// ---------------------------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------------------------

interface BoardCtx {
  boardId: string
  lists: TList[]
  /** Multica status -> Trello list id. */
  statusList: Record<string, string>
  priorityLabels: Record<string, string>
  managedLabelIds: Set<string>
}

interface People {
  agents: Agent[]
  members: Member[]
  at: number
}

export type PushResult = 'created' | 'linked' | 'updated' | 'unchanged' | 'archived' | 'skipped'

export interface SyncDeps {
  api: () => MulticaApi
  trello: Trello
  store: SyncStore
  pairs: Pair[]
  multicaWebUrl: string
  log?: (msg: string) => void
}

export class Sync {
  private readonly d: SyncDeps
  private readonly boards = new Map<string, BoardCtx>()
  private people: People | null = null

  constructor(d: SyncDeps) {
    this.d = d
  }

  private log(msg: string): void {
    this.d.log?.(msg)
  }

  pairFor(projectId: string | null | undefined): Pair | undefined {
    return this.d.pairs.find((p) => p.projectId === projectId)
  }

  /** Lists and labels of the board; creates missing status lists and priority labels. */
  async board(pair: Pair, refresh = false): Promise<BoardCtx> {
    const cached = this.boards.get(pair.board)
    if (cached && !refresh) return cached
    const t = this.d.trello
    const { id: boardId } = await t.board(pair.board)
    let lists = (await t.lists(boardId)).filter((l) => !l.closed).sort((a, b) => a.pos - b.pos)
    const statusList: Record<string, string> = {}
    for (const [i, status] of MIRRORED_STATUS.entries()) {
      const name = pair.lists[status]
      let list = lists.find((l) => l.name === name)
      if (!list) {
        // Directly before the list of the next status already on the board, else at the end.
        const next = MIRRORED_STATUS.slice(i + 1)
          .map((s) => lists.find((l) => l.name === pair.lists[s]))
          .find(Boolean)
        let pos = 'bottom'
        if (next) {
          const before = lists.filter((l) => l.pos < next.pos).at(-1)
          pos = String(before ? (before.pos + next.pos) / 2 : next.pos / 2)
        }
        list = await t.createList(boardId, name, pos)
        this.log(`liste angelegt: ${name}`)
        lists = [...lists, list].sort((a, b) => a.pos - b.pos)
      }
      statusList[status] = list.id
    }
    let labels: TLabel[] = await t.labels(boardId)
    const priorityLabels: Record<string, string> = {}
    for (const [prio, want] of Object.entries(PRIORITY_LABEL)) {
      let label = labels.find((l) => l.name === want.name)
      if (!label) {
        label = await t.createLabel(boardId, want.name, want.color)
        labels = [...labels, label]
      }
      priorityLabels[prio] = label.id
    }
    const ctx: BoardCtx = { boardId, lists, statusList, priorityLabels, managedLabelIds: new Set(Object.values(priorityLabels)) }
    this.boards.set(pair.board, ctx)
    return ctx
  }

  private async loadPeople(): Promise<People> {
    if (this.people && Date.now() - this.people.at < 10 * 60_000) return this.people
    const api = this.d.api()
    const [agents, members] = await Promise.all([api.agents(), api.members()])
    this.people = { agents, members, at: Date.now() }
    return this.people
  }

  private name(p: People, type: string | null | undefined, id: string | null | undefined): string {
    if (!type || !id) return 'niemand'
    if (type === 'agent') return p.agents.find((a) => a.id === id)?.name ?? 'Agent'
    if (type === 'member') return p.members.find((m) => m.user_id === id)?.name ?? 'Mitglied'
    return 'Squad'
  }

  issueUrl(identifier: string): string {
    return `${this.d.multicaWebUrl.replace(/\/+$/, '')}/issues/${identifier}`
  }

  /** The card Multica wants for this issue. */
  desired(issue: Issue, pair: Pair, ctx: BoardCtx, people: People, prev?: Snapshot): Snapshot {
    const footer = `${FOOTER}${issue.identifier} (${this.issueUrl(issue.identifier)})\nZuständig: ${this.name(people, issue.assignee_type, issue.assignee_id)}`
    let body = plain(issue.description ?? '').trim()
    if (body.length + footer.length + 2 > TRELLO_MAX) body = body.slice(0, TRELLO_MAX - footer.length - CUT.length - 2) + CUT
    const cancelled = issue.status === 'cancelled'
    const mapped = Object.keys(pair.members).length > 0
    const member = issue.assignee_type === 'member' && issue.assignee_id ? pair.members[issue.assignee_id] : undefined
    return {
      name: `${issue.identifier}: ${issue.title}`,
      desc: body ? `${body}\n\n${footer}` : footer,
      idList: cancelled ? (prev?.idList ?? ctx.statusList.backlog) : (ctx.statusList[issue.status] ?? ctx.statusList.backlog),
      priorityLabel: ctx.priorityLabels[issue.priority] ?? null,
      due: dueFromDate(issue.due_date),
      closed: cancelled,
      idMembers: mapped ? (member ? [member] : []) : null,
    }
  }

  /** Brings the Trello card of one issue up to date. A missing issue archives its card. */
  async pushIssue(issueId: string): Promise<PushResult> {
    const { store, trello } = this.d
    let issue: Issue | null = null
    try {
      issue = await this.d.api().getIssue(issueId)
    } catch (err) {
      if (!(err instanceof MulticaError && err.status === 404)) throw err
    }
    const link = store.byIssue(issueId)
    const pair = issue ? this.pairFor(issue.project_id) : undefined
    if (!issue || !pair) {
      // Deleted, or moved out of every mirrored project.
      if (!link || link.snapshot.closed) return link ? 'unchanged' : 'skipped'
      await this.writeCard(link.cardId, { closed: 'true' })
      store.setSnapshot(issueId, { ...link.snapshot, closed: true })
      this.log(`archiviert: ${link.identifier} (${issue ? 'Projekt gewechselt' : 'gelöscht'})`)
      return 'archived'
    }
    const ctx = await this.board(pair)
    const people = await this.loadPeople()
    const want = this.desired(issue, pair, ctx, people, link?.snapshot)

    if (!link || link.boardId !== ctx.boardId) {
      if (issue.status === 'cancelled') return 'skipped'
      // A card left over from a crash between create and store carries the identifier already.
      const orphan = (await trello.cards(ctx.boardId)).find((c) => !store.byCard(c.id) && c.name.startsWith(`${issue.identifier}:`))
      const now = new Date().toISOString()
      if (orphan) {
        store.link({ issueId, identifier: issue.identifier, boardId: ctx.boardId, cardId: orphan.id, snapshot: this.cardState(orphan, ctx), linkedAt: now })
        await this.pushIssue(issueId)
        return 'linked'
      }
      const card = await trello.createCard({
        idList: want.idList,
        name: want.name,
        desc: want.desc,
        pos: 'bottom',
        idLabels: want.priorityLabel ?? undefined,
        due: want.due ?? undefined,
        idMembers: want.idMembers?.join(',') || undefined,
      })
      store.link({ issueId, identifier: issue.identifier, boardId: ctx.boardId, cardId: card.id, snapshot: want, linkedAt: now })
      this.log(`angelegt: ${issue.identifier} -> ${card.shortUrl}`)
      return 'created'
    }

    const prev = link.snapshot
    const fields: Record<string, string> = {}
    if (want.name !== prev.name) fields.name = want.name
    if (want.desc !== prev.desc) fields.desc = want.desc
    if (want.idList !== prev.idList) {
      fields.idList = want.idList
      fields.pos = 'bottom'
    }
    if (want.due !== prev.due) fields.due = want.due ?? 'null'
    if (want.closed !== prev.closed) fields.closed = String(want.closed)
    if (want.idMembers && want.idMembers.join(',') !== (prev.idMembers ?? []).join(',')) fields.idMembers = want.idMembers.join(',')
    if (want.priorityLabel !== prev.priorityLabel) {
      const current = await this.readCard(link.cardId)
      if (current) {
        const keep = current.idLabels.filter((l) => !ctx.managedLabelIds.has(l))
        fields.idLabels = [...keep, ...(want.priorityLabel ? [want.priorityLabel] : [])].join(',')
      }
    }
    let result: PushResult = 'unchanged'
    if (Object.keys(fields).length) {
      const ok = await this.writeCard(link.cardId, fields)
      if (!ok) {
        // The card was deleted on Trello: start over with a new one.
        store.unlink(issueId)
        this.log(`karte fehlt auf Trello, neu: ${issue.identifier}`)
        return this.pushIssue(issueId)
      }
      store.setSnapshot(issueId, want)
      result = want.closed && !prev.closed ? 'archived' : 'updated'
      this.log(`${result}: ${issue.identifier} (${Object.keys(fields).join(', ')})`)
    }
    if ((await this.pushComments(issue, link, people)) && result === 'unchanged') result = 'updated'
    return result
  }

  /** New Multica comments since the card was linked, as Trello comments. */
  private async pushComments(issue: Issue, link: Link, people: People): Promise<number> {
    const { store, trello } = this.d
    const comments: Comment[] = await this.d.api().commentsSince(issue.id, link.linkedAt)
    let n = 0
    for (const c of comments) {
      if (store.commentKnown(c.id, null) || c.content.startsWith(PULL_MARK)) continue
      let text = `${this.name(people, c.author_type, c.author_id)} in Multica, ${berlin(c.created_at)}:\n\n${plain(c.content)}`
      if (text.length > TRELLO_MAX) text = text.slice(0, TRELLO_MAX - CUT.length) + CUT
      const actionId = await trello.addComment(link.cardId, text)
      store.recordComment(c.id, actionId, link.cardId, 'multica')
      n++
    }
    if (n) this.log(`kommentare: ${issue.identifier} +${n}`)
    return n
  }

  private async readCard(cardId: string): Promise<TCard | null> {
    try {
      return await this.d.trello.card(cardId)
    } catch (err) {
      if (err instanceof TrelloError && err.status === 404) return null
      throw err
    }
  }

  /** false when the card no longer exists. */
  private async writeCard(cardId: string, fields: Record<string, string>): Promise<boolean> {
    try {
      await this.d.trello.updateCard(cardId, fields)
      return true
    } catch (err) {
      if (err instanceof TrelloError && err.status === 404) return false
      throw err
    }
  }

  cardState(card: TCard, ctx: BoardCtx): Snapshot {
    return {
      name: card.name,
      desc: card.desc,
      idList: card.idList,
      priorityLabel: card.idLabels.find((l) => ctx.managedLabelIds.has(l)) ?? null,
      due: card.due ? new Date(card.due).toISOString() : null,
      closed: card.closed,
      idMembers: [...card.idMembers],
    }
  }

  /** Full pass over one project: every issue pushed, cards of issues that left the project archived. */
  async reconcile(pair: Pair): Promise<Record<PushResult, number>> {
    const counts: Record<PushResult, number> = { created: 0, linked: 0, updated: 0, unchanged: 0, archived: 0, skipped: 0 }
    const ctx = await this.board(pair, true)
    this.people = null
    const issues = await this.d.api().projectIssues(pair.projectId)
    const seen = new Set<string>()
    for (const i of issues.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      seen.add(i.id)
      try {
        counts[await this.pushIssue(i.id)]++
      } catch (err) {
        this.log(`fehler bei ${i.identifier}: ${(err as Error).message}`)
      }
    }
    for (const l of this.d.store.byBoard(ctx.boardId)) {
      if (seen.has(l.issueId)) continue
      try {
        counts[await this.pushIssue(l.issueId)]++
      } catch (err) {
        this.log(`fehler bei ${l.identifier}: ${(err as Error).message}`)
      }
    }
    return counts
  }

  // -------------------------------------------------------------------------------------------
  // Pull: Trello -> Multica, only on request
  // -------------------------------------------------------------------------------------------

  /** What a pull would change. Nothing is written. */
  async planPull(pair: Pair, cardRef?: string): Promise<PullPlan> {
    const { trello, store } = this.d
    const ctx = await this.board(pair, true)
    const api = this.d.api()
    const listName = (id: string) => ctx.lists.find((l) => l.id === id)?.name ?? 'einer unbekannten Liste'
    const statusOf = (listId: string) => Object.entries(ctx.statusList).find(([, id]) => id === listId)?.[0]
    let cards = (await trello.cards(ctx.boardId)).filter((c) => !c.closed)
    if (cardRef) {
      const ref = cardRef.trim()
      const short = /trello\.com\/c\/([A-Za-z0-9]+)/.exec(ref)?.[1] ?? ref
      cards = cards.filter((c) => {
        const link = store.byCard(c.id)
        return c.id === ref || c.shortUrl.endsWith(`/${short}`) || link?.identifier.toLowerCase() === ref.toLowerCase().replace(/\s+/, '-')
      })
    }
    const projectIssues = await api.projectIssues(pair.projectId)
    const items: PullItem[] = []
    for (const card of cards) {
      const link = store.byCard(card.id)
      const comments = (await trello.comments(card.id)).filter((c) => !store.commentKnown(null, c.id))
      if (!link) {
        const id = ID_PREFIX.exec(card.name)?.[0].replace(':', '').trim()
        const existing = id ? projectIssues.find((i) => i.identifier === id && !store.byIssue(i.id)) : undefined
        if (existing) {
          items.push({ kind: 'link', card, issue: existing, changes: [`wird mit ${existing.identifier} verbunden`], update: {}, comments })
          continue
        }
        items.push({
          kind: 'new',
          card,
          changes: [`neue Karte im Backlog${comments.length ? ` mit ${comments.length} Kommentar${comments.length === 1 ? '' : 'en'}` : ''}`],
          update: { title: cardTitle(card.name) || 'Ohne Titel', description: cardBody(card.desc), status: 'backlog', due_date: dateFromDue(card.due) },
          comments,
        })
        continue
      }
      const issue = projectIssues.find((i) => i.id === link.issueId)
      if (!issue) continue
      const snap = link.snapshot
      const update: Record<string, string | null> = {}
      const changes: string[] = []
      if (card.name !== snap.name) {
        const title = cardTitle(card.name)
        if (title && title !== issue.title) {
          update.title = title
          changes.push(`Titel wird „${title}“`)
        }
      }
      if (card.desc !== snap.desc) {
        const body = cardBody(card.desc)
        if (body.includes(CUT.trim())) changes.push('Beschreibung bleibt, weil die Trello-Fassung gekürzt ist')
        else if (body !== (issue.description ?? '').trim()) {
          update.description = body
          changes.push('Beschreibung wird übernommen')
        }
      }
      if (card.idList !== snap.idList) {
        const status = statusOf(card.idList)
        if (!status) changes.push(`liegt in der Liste ${listName(card.idList)}, die zu keinem Status gehört, der Status bleibt ${STATUS_DE[issue.status]} und die Karte geht in dessen Liste zurück`)
        else if (status !== issue.status) {
          update.status = status
          const agentStarts = status === 'todo' && issue.assignee_type === 'agent'
          changes.push(`Status wird ${STATUS_DE[status]}${agentStarts ? ', dabei startet der zuständige Agent' : ''}`)
        }
      }
      const due = card.due ? new Date(card.due).toISOString() : null
      if (due !== snap.due) {
        const date = dateFromDue(due)
        if (date !== (issue.due_date?.slice(0, 10) ?? null)) {
          update.due_date = date
          changes.push(date ? `fällig am ${date.split('-').reverse().join('.')}` : 'Fälligkeit wird entfernt')
        }
      }
      if (comments.length) changes.push(`${comments.length} neue${comments.length === 1 ? 'r' : ''} Kommentar${comments.length === 1 ? '' : 'e'}`)
      if (changes.length) items.push({ kind: 'update', card, issue, changes, update, comments })
    }
    return { pair, items }
  }

  /** Applies a plan from planPull; afterwards every touched card is mirrored again. */
  async applyPull(plan: PullPlan): Promise<string[]> {
    const { store } = this.d
    const api = this.d.api()
    const ctx = await this.board(plan.pair)
    const done: string[] = []
    for (const item of plan.items) {
      let issue = item.issue
      const now = new Date().toISOString()
      if (item.kind === 'new') {
        const body: Record<string, unknown> = { title: item.update.title, project_id: plan.pair.projectId, status: 'backlog', priority: 'none' }
        if (item.update.description) body.description = item.update.description
        if (item.update.due_date) body.due_date = item.update.due_date
        issue = await api.createIssue(body)
        store.link({ issueId: issue.id, identifier: issue.identifier, boardId: ctx.boardId, cardId: item.card.id, snapshot: this.cardState(item.card, ctx), linkedAt: now })
        done.push(`${issue.identifier} „${issue.title}“ neu angelegt`)
      } else if (item.kind === 'link' && issue) {
        store.link({ issueId: issue.id, identifier: issue.identifier, boardId: ctx.boardId, cardId: item.card.id, snapshot: this.cardState(item.card, ctx), linkedAt: now })
        done.push(`${issue.identifier} mit der Trello-Karte verbunden`)
      } else if (issue) {
        if (Object.keys(item.update).length) issue = await api.updateIssue(issue.id, item.update)
        // The card as it is now is the agreed state; the push below adds prefix and footer back.
        store.setSnapshot(issue.id, this.cardState(item.card, ctx))
        done.push(`${issue.identifier}: ${item.changes.join(', ')}`)
      }
      if (!issue) continue
      for (const c of item.comments) {
        const mc = await api.addComment(issue.id, `${PULL_MARK}${c.author}, ${berlin(c.date)}:\n\n${c.text}`)
        store.recordComment(mc.id, c.id, item.card.id, 'trello')
      }
      await this.pushIssue(issue.id)
    }
    return done
  }
}

export interface WsFrame {
  type: string
  payload?: { issue?: { id?: string; project_id?: string | null }; issue_id?: string; comment?: { issue_id?: string } }
}

/** Issue a Multica WebSocket event is about, if it concerns a mirrored project or an already linked card. */
export function relevantIssue(f: WsFrame, projectIds: Set<string>, linked: (id: string) => boolean): string | null {
  const p = f.payload ?? {}
  if (f.type === 'issue:created' || f.type === 'issue:updated') {
    const id = p.issue?.id
    return id && (projectIds.has(p.issue?.project_id ?? '') || linked(id)) ? id : null
  }
  if (f.type === 'issue:deleted') return p.issue_id && linked(p.issue_id) ? p.issue_id : null
  if (f.type === 'comment:created') {
    const id = p.comment?.issue_id
    return id && linked(id) ? id : null
  }
  return null
}

export interface PullItem {
  kind: 'new' | 'link' | 'update'
  card: TCard
  issue?: Issue
  changes: string[]
  update: Record<string, string | null>
  comments: { id: string; date: string; text: string; author: string }[]
}

export interface PullPlan {
  pair: Pair
  items: PullItem[]
}

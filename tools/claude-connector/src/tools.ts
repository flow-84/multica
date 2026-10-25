// MCP tools. Every answer is a few short German sentences: the Claude app
// reads them aloud in voice mode, so no tables, no Markdown, no UUIDs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { type Agent, type Issue, type Label, type Member, MulticaApi, MulticaError, type Project } from './multica.ts'
import { type Clock, audit } from './store.ts'

export const SERVER_INFO = { name: 'multica', version: '1.1.0' }

const INSTRUCTIONS = [
  'Steuert den Multica-Workspace von fl0w (Issues, Projekte, Agenten). Antworten sind kurze deutsche Sätze zum Vorlesen.',
  'Projekte und Zuständige werden mit ihrem Namen angegeben, Issues mit ihrer Kennung wie MS-2400.',
  'Vor dem Anlegen eines Issues, einer Statusänderung oder einem Kommentar den Inhalt kurz bestätigen lassen.',
  'Ein Issue mit Status todo und einem Agenten als Zuständigem startet sofort einen Agentenlauf.',
  'Gibt es ein genanntes Projekt noch nicht, wird es mit create_project angelegt, nicht über eine Karte an einen Agenten.',
  'Unterkarten entstehen mit create_issue und parent, Abhängigkeiten mit blocked_by oder blocks.',
].join(' ')

export const STATUS = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] as const
export type Status = (typeof STATUS)[number]
const STATUS_DE: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Zu erledigen',
  in_progress: 'In Arbeit',
  in_review: 'Im Review',
  done: 'Erledigt',
  blocked: 'Blockiert',
  cancelled: 'Abgebrochen',
}
const PRIORITY = ['urgent', 'high', 'medium', 'low', 'none'] as const
const PRIORITY_DE: Record<string, string> = { urgent: 'dringend', high: 'hoch', medium: 'mittel', low: 'niedrig', none: 'ohne' }
const CLOSED = new Set(['done', 'cancelled'])
export const PROJECT_STATUS = ['planned', 'in_progress', 'paused', 'completed', 'cancelled'] as const
const PROJECT_STATUS_DE: Record<string, string> = {
  planned: 'geplant',
  in_progress: 'aktiv',
  paused: 'pausiert',
  completed: 'abgeschlossen',
  cancelled: 'archiviert',
}

const statusDe = (s: string) => STATUS_DE[s] ?? s
const projectStatusDe = (s: string) => PROJECT_STATUS_DE[s] ?? s
const ids = (issues: Issue[]) => issues.map((i) => i.identifier).join(', ')

/** "vor 3 Stunden", "gestern", "vor 5 Tagen". */
export function ago(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000))
  if (s < 90) return 'gerade eben'
  const m = Math.round(s / 60)
  if (m < 60) return `vor ${m} Minuten`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? 'vor einer Stunde' : `vor ${h} Stunden`
  const d = Math.round(h / 24)
  if (d === 1) return 'gestern'
  return `vor ${d} Tagen`
}

/** Markdown to speakable plain text, cut at a sentence-ish boundary. */
export function speakable(md: string | null | undefined, max: number): string {
  if (!md) return ''
  let t = md
    .replace(/```[\s\S]*?```/g, ' (Codeblock) ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' (Bild) ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > max) {
    const cut = t.slice(0, max)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    t = `${end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.trimEnd()} …`}`
  }
  return t
}

const norm = (s: string) => s.toLocaleLowerCase('de').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim()

/** Exact name first, then a unique substring match. */
export function pickByName<T>(items: T[], name: string, label: (t: T) => string): { ok: true; item: T } | { ok: false; candidates: T[] } {
  const n = norm(name)
  const exact = items.filter((i) => norm(label(i)) === n)
  if (exact.length === 1) return { ok: true, item: exact[0] }
  const partial = items.filter((i) => norm(label(i)).includes(n))
  if (partial.length === 1) return { ok: true, item: partial[0] }
  return { ok: false, candidates: exact.length > 1 ? exact : partial }
}

/** Expected user error: the text is read aloud and nothing was changed. */
class Say extends Error {}

interface Ctx {
  api: MulticaApi
  /** The Multica user behind the grant (fl0w). */
  userId: string
  nowMs: number
}

type Assignee = { type: 'member' | 'agent'; id: string; name: string }

interface People {
  agents: Agent[]
  members: Member[]
}

async function loadPeople(api: MulticaApi): Promise<People> {
  const [agents, members] = await Promise.all([api.agents(), api.members()])
  return { agents: agents.filter((a) => !a.archived_at), members }
}

function assigneeName(p: People, type: string | null, id: string | null): string | null {
  if (!type || !id) return null
  if (type === 'agent') return p.agents.find((a) => a.id === id)?.name ?? 'einem archivierten Agenten'
  if (type === 'member') return p.members.find((m) => m.user_id === id)?.name ?? 'einem Mitglied'
  if (type === 'squad') return 'einem Squad'
  return null
}

const SELF = new Set(['ich', 'mich', 'mir', 'selbst'])
const NOBODY = new Set(['niemand', 'keiner', 'keine', 'nobody'])

function resolveAssignee(p: People, name: string, selfId: string): Assignee {
  if (SELF.has(norm(name))) {
    const me = p.members.find((m) => m.user_id === selfId)
    return { type: 'member', id: selfId, name: me?.name ?? 'dich' }
  }
  const pool: Assignee[] = [
    ...p.agents.map((a) => ({ type: 'agent' as const, id: a.id, name: a.name })),
    ...p.members.map((m) => ({ type: 'member' as const, id: m.user_id, name: m.name })),
  ]
  const r = pickByName(pool, name, (a) => a.name)
  if (r.ok) return r.item
  if (r.candidates.length) throw new Say(`„${name}“ passt auf mehrere: ${r.candidates.slice(0, 5).map((c) => c.name).join(', ')}. Welcher ist gemeint?`)
  throw new Say(`Ich finde niemanden namens „${name}“. Möglich sind zum Beispiel ${pool.slice(0, 6).map((c) => c.name).join(', ')}.`)
}

async function resolveProject(api: MulticaApi, name: string): Promise<Project> {
  const projects = await api.projects()
  const r = pickByName(projects, name, (p) => p.title)
  if (r.ok) return r.item
  if (r.candidates.length) {
    throw new Say(`„${name}“ passt auf mehrere Projekte: ${r.candidates.slice(0, 5).map((c) => c.title).join(', ')}. Welches ist gemeint?`)
  }
  throw new Say(`Ein Projekt „${name}“ gibt es nicht. Soll ich es anlegen?`)
}

async function resolveLabels(api: MulticaApi, names: string[]): Promise<Label[]> {
  if (!names.length) return []
  const all = await api.issueLabels()
  return names.map((name) => {
    const r = pickByName(all, name, (l) => l.name)
    if (r.ok) return r.item
    if (r.candidates.length) throw new Say(`Das Label „${name}“ passt auf mehrere: ${r.candidates.slice(0, 5).map((l) => l.name).join(', ')}. Welches ist gemeint?`)
    throw new Say(`Ein Label „${name}“ gibt es nicht. Vorhanden sind zum Beispiel ${all.slice(0, 8).map((l) => l.name).join(', ')}.`)
  })
}

async function loadIssue(api: MulticaApi, ref: string): Promise<Issue> {
  const r = ref.trim().toUpperCase().replace(/\s+/g, '').replace(/^([A-Z]+)(\d+)$/, '$1-$2')
  try {
    return await api.getIssue(r)
  } catch (err) {
    if (err instanceof MulticaError && (err.status === 404 || err.status === 400)) throw new Say(`Das Issue ${ref} finde ich nicht.`)
    throw err
  }
}

function issueLine(i: Issue, p: People, nowMs: number): string {
  const who = assigneeName(p, i.assignee_type, i.assignee_id)
  return `${i.identifier}: ${i.title}. ${statusDe(i.status)}${who ? `, bei ${who}` : ', ohne Zuständigen'}, geändert ${ago(i.updated_at, nowMs)}.`
}

// ---------------------------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------------------------

export const listIssuesInput = {
  project: z.string().optional().describe('Projektname, zum Beispiel "Multica" oder "CRM (m2s)". Ohne Angabe: alle Projekte.'),
  status: z.array(z.enum(STATUS)).optional().describe('Nur diese Status. Ohne Angabe: alle offenen (nicht erledigt, nicht abgebrochen).'),
  assignee: z.string().optional().describe('Name eines Agenten oder Mitglieds, "ich" für fl0w selbst.'),
  days: z.number().int().min(1).max(365).optional().describe('Nur Issues, die in den letzten so vielen Tagen geändert wurden.'),
  query: z.string().min(2).max(200).optional().describe('Suchbegriff in Titel, Beschreibung und Kommentaren.'),
  parent: z.string().min(2).max(40).optional().describe('Nur die Unterkarten dieser Karte (Kennung wie MS-2400). Ohne Status: alle, auch erledigte.'),
  limit: z.number().int().min(1).max(100).optional().describe('Höchstens so viele je Seite vorlesen, Standard 8, höchstens 100.'),
  page: z.number().int().min(1).max(100).optional().describe('Seite, Standard 1. Die Antwort sagt, ob es eine weitere Seite gibt.'),
}

export const LIST_PAGE = 100
export const SEARCH_PAGE = 50

async function listIssues(c: Ctx, a: z.infer<z.ZodObject<typeof listIssuesInput>>): Promise<string> {
  const size = a.limit ?? 8
  const page = a.page ?? 1
  const offset = (page - 1) * size
  const [project, people, parent] = await Promise.all([
    a.project ? resolveProject(c.api, a.project) : undefined,
    loadPeople(c.api),
    a.parent ? loadIssue(c.api, a.parent) : undefined,
  ])
  const assignee = a.assignee ? resolveAssignee(people, a.assignee, c.userId) : undefined
  const since = a.days ? c.nowMs - a.days * 86_400_000 : null
  const inRange = (i: Issue) => since === null || Date.parse(i.updated_at) >= since
  const matches = (i: Issue) =>
    (!project || i.project_id === project.id) &&
    (!assignee || i.assignee_id === assignee.id) &&
    (!a.status?.length || a.status.includes(i.status as Status)) &&
    inRange(i)
  let shown: Issue[]
  /** Spoken count: exact, or "mindestens N" when a capped page may hide further matches. */
  let count: number
  let atLeast = false
  if (parent || a.query) {
    // Both sources come back whole (children) or capped at one page (search): page locally.
    const hits = parent ? await c.api.children(parent.id) : await c.api.searchIssues(a.query ?? '', SEARCH_PAGE)
    const issues = hits.filter(matches).sort((x, y) => y.updated_at.localeCompare(x.updated_at))
    count = issues.length
    atLeast = !parent && hits.length >= SEARCH_PAGE && issues.length > 0
    shown = issues.slice(offset, offset + size)
  } else {
    const statuses = a.status?.length ? a.status : STATUS.filter((s) => !CLOSED.has(s))
    const q = { projectId: project?.id, statuses, assigneeId: assignee?.id, offset }
    if (since === null) {
      const r = await c.api.listIssues({ ...q, limit: size })
      shown = r.issues
      count = r.total
    } else {
      // Sorted by updated_at: skipped issues are newer, so all of them are in range,
      // and the time filter only cuts the tail of this page.
      const r = await c.api.listIssues({ ...q, limit: LIST_PAGE })
      const issues = r.issues.filter(inRange)
      count = offset + issues.length
      atLeast = r.issues.length >= LIST_PAGE && issues.length === r.issues.length && r.total > count
      shown = issues.slice(0, size)
    }
  }

  const scope = [
    parent ? `unter ${parent.identifier}` : null,
    project ? `im Projekt ${project.title}` : null,
    assignee ? `bei ${assignee.name}` : null,
    a.query ? `zu „${a.query}“` : null,
    a.days ? `aus den letzten ${a.days} Tagen` : null,
  ]
    .filter(Boolean)
    .join(' ')
  const what = a.status?.length ? `mit Status ${a.status.map(statusDe).join(' oder ')}` : a.query || parent ? '' : 'offen'
  const number = count === 0 ? 'Keine' : atLeast ? `Mindestens ${count}` : String(count)
  const head = `${number} ${count === 1 && !atLeast ? 'Issue' : 'Issues'} ${[what, scope].filter(Boolean).join(' ')}`.trim()
  if (count === 0) return `${head}.`
  if (!shown.length) return `${head}. Seite ${page} ist leer.`
  const more = atLeast || count > offset + shown.length
  const range =
    page === 1 ? (more ? ` Das waren die ${shown.length} zuletzt geänderten.` : '') : ` Das waren die Nummern ${offset + 1} bis ${offset + shown.length}.`
  const next = more ? ` Weitere mit Seite ${page + 1}.` : ''
  return `${head}, zuletzt geänderte zuerst. ${shown.map((i) => issueLine(i, people, c.nowMs)).join(' ')}${range}${next}`
}

export const getIssueInput = { issue: z.string().min(2).max(40).describe('Kennung wie MS-2400') }

async function getIssue(c: Ctx, a: { issue: string }): Promise<string> {
  const i = await loadIssue(c.api, a.issue)
  const [people, comments, projects, kids, parent] = await Promise.all([
    loadPeople(c.api),
    c.api.recentComments(i.id, 3),
    c.api.projects(),
    c.api.children(i.id),
    i.parent_issue_id ? c.api.getIssue(i.parent_issue_id).catch(() => undefined) : undefined,
  ])
  const project = projects.find((p) => p.id === i.project_id)?.title
  const who = assigneeName(people, i.assignee_type, i.assignee_id)
  const parts = [
    `${i.identifier}: ${i.title}.`,
    `Status ${statusDe(i.status)}, Priorität ${PRIORITY_DE[i.priority] ?? i.priority}, ${who ? `zuständig ${who}` : 'ohne Zuständigen'}${project ? `, Projekt ${project}` : ''}.`,
    `Angelegt ${ago(i.created_at, c.nowMs)}, zuletzt geändert ${ago(i.updated_at, c.nowMs)}.`,
  ]
  if (parent) parts.push(`Unterkarte von ${parent.identifier}${i.stage ? `, Stufe ${i.stage}` : ''}.`)
  if (kids.length) {
    const closed = kids.filter((k) => CLOSED.has(k.status)).length
    parts.push(`${kids.length === 1 ? 'Eine Unterkarte' : `${kids.length} Unterkarten`}, davon ${closed} abgeschlossen: ${ids(kids)}.`)
  }
  const desc = speakable(i.description, 700)
  parts.push(desc ? `Beschreibung: ${desc}` : 'Keine Beschreibung.')
  if (comments.length) {
    parts.push(`Letzte ${comments.length === 1 ? 'Kommentar' : `${comments.length} Kommentare`}:`)
    for (const cm of comments) {
      const author = assigneeName(people, cm.author_type, cm.author_id) ?? 'System'
      parts.push(`${author}, ${ago(cm.created_at, c.nowMs)}: ${speakable(cm.content, 350)}`)
    }
  } else {
    parts.push('Noch keine Kommentare.')
  }
  return parts.join(' ')
}

const issueRefs = z.array(z.string().min(2).max(40)).max(10)

export const createIssueInput = {
  project: z.string().optional().describe('Projektname. Darf bei einer Unterkarte fehlen, dann gilt das Projekt der Oberkarte. Fehlt das Projekt in Multica, zuerst create_project.'),
  title: z.string().min(3).max(200).describe('Titel des Issues'),
  description: z.string().max(10_000).optional().describe('Beschreibung, gern mehrere Sätze'),
  assignee: z.string().optional().describe('Name eines Agenten (Builder, Scribe, Reviewer, Claude …) oder Mitglieds, "ich" für fl0w'),
  status: z.enum(STATUS).optional().describe('Standard backlog. todo mit Agent startet sofort einen Lauf.'),
  priority: z.enum(PRIORITY).optional().describe('Standard none'),
  parent: z.string().min(2).max(40).optional().describe('Oberkarte (Kennung wie MS-2400): die neue Karte wird ihre Unterkarte.'),
  stage: z.number().int().min(1).max(50).optional().describe('Stufe unter der Oberkarte. Stufe 2 kommt nach Stufe 1, nur zusammen mit parent.'),
  blocked_by: issueRefs.optional().describe('Karten, auf die die neue Karte wartet. Hat sie einen Agenten, startet er, sobald jede davon erledigt ist.'),
  blocks: issueRefs.optional().describe('Karten, die auf die neue Karte warten.'),
  labels: z.array(z.string().min(1).max(80)).max(10).optional().describe('Namen vorhandener Labels, zum Beispiel "bereich/Model to Star".'),
}

/**
 * `waiter` waits for `blocker`. Multica has no dependency field, so the wait is a
 * wakeup that starts the waiter's agent once the blocker is done, plus a visible
 * line in the waiter's description. Returns false when no agent will be started.
 */
async function addDependency(c: Ctx, waiter: Issue, blocker: Issue): Promise<boolean> {
  const agent = waiter.assignee_type === 'agent' ? waiter.assignee_id : null
  if (agent) {
    await c.api.waitForIssue(
      waiter.id,
      agent,
      blocker.id,
      `${blocker.identifier} ist erledigt. ${waiter.identifier} hat darauf gewartet und kann jetzt bearbeitet werden.`,
    )
  }
  const line = `Wartet auf: [${blocker.identifier}](mention://issue/${blocker.id})`
  const desc = waiter.description?.trim() ?? ''
  if (!desc.includes(line)) {
    // Keep the local copy current: a second blocker for the same card appends to this text.
    waiter.description = desc ? `${desc}\n\n${line}` : line
    await c.api.updateIssue(waiter.id, { description: waiter.description })
  }
  return Boolean(agent)
}

async function createIssue(c: Ctx, a: z.infer<z.ZodObject<typeof createIssueInput>>): Promise<{ text: string; target: string }> {
  if (a.stage && !a.parent) throw new Say('Eine Stufe gibt es nur zusammen mit einer Oberkarte. Unter welcher Karte?')
  if (!a.project && !a.parent) throw new Say('In welchem Projekt soll die Karte liegen?')
  // Resolve everything first: a wrong name must not leave a half-made card behind.
  const [parent, blockers, blocked, labels, people] = await Promise.all([
    a.parent ? loadIssue(c.api, a.parent) : undefined,
    Promise.all((a.blocked_by ?? []).map((r) => loadIssue(c.api, r))),
    Promise.all((a.blocks ?? []).map((r) => loadIssue(c.api, r))),
    resolveLabels(c.api, a.labels ?? []),
    loadPeople(c.api),
  ])
  const project = a.project ? await resolveProject(c.api, a.project) : (await c.api.projects()).find((p) => p.id === parent?.project_id)
  if (!project) throw new Say(`${parent?.identifier} liegt in keinem Projekt. In welchem Projekt soll die Karte liegen?`)
  const assignee = a.assignee ? resolveAssignee(people, a.assignee, c.userId) : undefined
  const status = a.status ?? 'backlog'
  const open = blockers.filter((b) => !CLOSED.has(b.status))
  if (open.length && status === 'todo' && assignee?.type === 'agent') {
    throw new Say(`${ids(open)} ist noch nicht erledigt. Eine wartende Karte bitte mit Status backlog anlegen, ${assignee.name} startet dann von selbst.`)
  }
  const body: Record<string, unknown> = { title: a.title.trim(), project_id: project.id, status, priority: a.priority ?? 'none' }
  if (a.description?.trim()) body.description = a.description.trim()
  if (assignee) {
    body.assignee_type = assignee.type
    body.assignee_id = assignee.id
  }
  if (parent) body.parent_issue_id = parent.id
  if (a.stage) body.stage = a.stage
  if (labels.length) body.label_ids = labels.map((l) => l.id)
  const i = await c.api.createIssue(body)

  const said = [
    `Angelegt: ${i.identifier}, „${i.title}“, im Projekt ${project.title}${parent ? `, als Unterkarte von ${parent.identifier}${a.stage ? ` in Stufe ${a.stage}` : ''}` : ''}.`,
    `Status ${statusDe(i.status)}${assignee ? `, zuständig ${assignee.name}` : ', ohne Zuständigen'}${labels.length ? `, Labels ${labels.map((l) => l.name).join(', ')}` : ''}.`,
  ]
  if (assignee?.type === 'agent' && status === 'todo') said.push(`${assignee.name} fängt gleich an.`)
  // The card exists from here on: a failed dependency is reported, not hidden behind "nichts geändert".
  const failed: string[] = []
  const silent = new Set<string>()
  const pairs: [Issue, Issue][] = [...open.map((b): [Issue, Issue] => [i, b]), ...blocked.map((w): [Issue, Issue] => [w, i])]
  for (const [waiter, blocker] of pairs) {
    try {
      if (!(await addDependency(c, waiter, blocker))) silent.add(waiter.identifier)
    } catch {
      failed.push(`${waiter.identifier} wartet auf ${blocker.identifier}`)
    }
  }
  const done = blockers.filter((b) => CLOSED.has(b.status))
  if (open.length) said.push(`Wartet auf ${ids(open)}.`)
  if (blocked.length) said.push(`${ids(blocked)} ${blocked.length === 1 ? 'wartet' : 'warten'} jetzt auf ${i.identifier}.`)
  if (done.length) said.push(`${ids(done)} ist schon abgeschlossen, darauf muss nicht gewartet werden.`)
  if (silent.size) said.push(`${[...silent].join(', ')} ${silent.size === 1 ? 'hat' : 'haben'} keinen Agenten, dort startet nach dem Warten nichts von selbst.`)
  if (failed.length) said.push(`Nicht eingetragen werden konnte: ${failed.join(', ')}.`)
  return { text: said.join(' '), target: i.identifier }
}

export const updateIssueInput = {
  issue: z.string().min(2).max(40).describe('Kennung wie MS-2400'),
  status: z.enum(STATUS).optional().describe('Neuer Status'),
  assignee: z.string().optional().describe('Neuer Zuständiger (Name), "ich" für fl0w, "niemand" zum Entfernen'),
}

async function updateIssue(c: Ctx, a: z.infer<z.ZodObject<typeof updateIssueInput>>): Promise<{ text: string; target: string }> {
  if (!a.status && !a.assignee) throw new Say('Was soll sich ändern, der Status oder der Zuständige?')
  const i = await loadIssue(c.api, a.issue)
  const body: Record<string, unknown> = {}
  const said: string[] = []
  if (a.status) {
    body.status = a.status
    said.push(`steht auf ${statusDe(a.status)}`)
  }
  if (a.assignee) {
    if (NOBODY.has(norm(a.assignee))) {
      body.assignee_type = null
      body.assignee_id = null
      said.push('hat keinen Zuständigen mehr')
    } else {
      const who = resolveAssignee(await loadPeople(c.api), a.assignee, c.userId)
      body.assignee_type = who.type
      body.assignee_id = who.id
      said.push(`liegt bei ${who.name}`)
    }
  }
  const u = await c.api.updateIssue(i.id, body)
  return { text: `${u.identifier} ${said.join(' und ')}.`, target: u.identifier }
}

export const addCommentInput = {
  issue: z.string().min(2).max(40).describe('Kennung wie MS-2400'),
  text: z.string().min(1).max(10_000).describe('Wortlaut des Kommentars'),
}

async function addComment(c: Ctx, a: { issue: string; text: string }): Promise<{ text: string; target: string }> {
  const i = await loadIssue(c.api, a.issue)
  await c.api.addComment(i.id, a.text.trim())
  return { text: `Kommentar an ${i.identifier} geschrieben.`, target: i.identifier }
}

export const BULK_MAX = 50

export const bulkUpdateInput = {
  issues: z.array(z.string().min(2).max(40)).max(BULK_MAX).optional().describe('Kennungen wie MS-2400, höchstens 50'),
  parent: z
    .string()
    .min(2)
    .max(40)
    .optional()
    .describe('Statt einer Liste: alle offenen Unterkarten dieser Karte, etwa eine ganze Phase. Erledigte und abgebrochene bleiben unverändert.'),
  status: z.enum(STATUS).optional().describe('Neuer Status für alle. todo mit Agent startet je Karte einen Lauf.'),
  assignee: z.string().optional().describe('Neuer Zuständiger für alle (Name), "ich" für fl0w, "niemand" zum Entfernen'),
}

async function bulkUpdate(c: Ctx, a: z.infer<z.ZodObject<typeof bulkUpdateInput>>): Promise<{ text: string; target: string }> {
  if (!a.status && !a.assignee) throw new Say('Was soll sich bei allen ändern, der Status oder der Zuständige?')
  if (!a.issues?.length && !a.parent) throw new Say('Welche Karten? Bitte Kennungen oder eine Oberkarte nennen.')
  let targets: Issue[]
  let skipped = 0
  if (a.parent) {
    const parent = await loadIssue(c.api, a.parent)
    const kids = await c.api.children(parent.id)
    targets = kids.filter((k) => !CLOSED.has(k.status))
    skipped = kids.length - targets.length
    if (!targets.length) throw new Say(`${parent.identifier} hat keine offenen Unterkarten.`)
  } else {
    targets = await Promise.all([...new Set(a.issues)].map((r) => loadIssue(c.api, r)))
  }
  if (targets.length > BULK_MAX) throw new Say(`Das sind ${targets.length} Karten, auf einmal gehen höchstens ${BULK_MAX}.`)
  const updates: Record<string, unknown> = {}
  const said: string[] = []
  let agent: Assignee | undefined
  if (a.status) {
    updates.status = a.status
    said.push(`auf ${statusDe(a.status)}`)
  }
  if (a.assignee) {
    if (NOBODY.has(norm(a.assignee))) {
      updates.assignee_type = null
      updates.assignee_id = null
      said.push('ohne Zuständigen')
    } else {
      const who = resolveAssignee(await loadPeople(c.api), a.assignee, c.userId)
      updates.assignee_type = who.type
      updates.assignee_id = who.id
      if (who.type === 'agent') agent = who
      said.push(`bei ${who.name}`)
    }
  }
  const n = await c.api.batchUpdateIssues(
    targets.map((t) => t.id),
    updates,
  )
  const parts = [`${n === 1 ? 'Eine Karte steht' : `${n} Karten stehen`} jetzt ${said.join(' und ')}: ${ids(targets)}.`]
  if (n < targets.length) parts.push(`${targets.length - n} davon hat Multica nicht geändert.`)
  if (skipped) parts.push(skipped === 1 ? 'Eine schon abgeschlossene Unterkarte blieb, wie sie war.' : `${skipped} schon abgeschlossene Unterkarten blieben, wie sie waren.`)
  const withAgent = a.assignee ? (agent ? targets.length : 0) : targets.filter((t) => t.assignee_type === 'agent').length
  const runs = a.status === 'todo' ? withAgent : 0
  if (runs) parts.push(runs === 1 ? 'Für eine Karte startet jetzt ein Agentenlauf.' : `Für ${runs} Karten starten jetzt Agentenläufe.`)
  return { text: parts.join(' '), target: ids(targets).slice(0, 200) }
}

export const archiveIssueInput = {
  issue: z.string().min(2).max(40).describe('Kennung der versehentlich angelegten Karte'),
  duplicate_of: z.string().min(2).max(40).optional().describe('Kennung der Karte, die sie doppelt'),
}

async function archiveIssue(c: Ctx, a: z.infer<z.ZodObject<typeof archiveIssueInput>>): Promise<{ text: string; target: string }> {
  const [i, original] = await Promise.all([loadIssue(c.api, a.issue), a.duplicate_of ? loadIssue(c.api, a.duplicate_of) : undefined])
  if (original?.id === i.id) throw new Say('Eine Karte kann kein Duplikat von sich selbst sein.')
  const body: Record<string, unknown> = { status: 'cancelled' }
  if (original) body.duplicate_of_issue_id = original.id
  const u = await c.api.updateIssue(i.id, body)
  return {
    text: `${u.identifier} ist abgebrochen${original ? ` und als Duplikat von ${original.identifier} markiert` : ''}. Sie bleibt in Multica sichtbar und lässt sich wieder öffnen.`,
    target: u.identifier,
  }
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export const createProjectInput = {
  name: z.string().min(2).max(120).describe('Projektname'),
  description: z.string().max(10_000).optional().describe('Worum es im Projekt geht'),
  status: z.enum(PROJECT_STATUS).optional().describe('Standard in_progress (aktiv). planned = geplant, paused = inaktiv, completed = abgeschlossen.'),
}

async function createProject(c: Ctx, a: z.infer<z.ZodObject<typeof createProjectInput>>): Promise<{ text: string; target: string }> {
  const name = a.name.trim()
  const existing = (await c.api.projects()).find((p) => norm(p.title) === norm(name))
  if (existing) throw new Say(`Das Projekt ${existing.title} gibt es schon, Status ${projectStatusDe(existing.status)}.`)
  const body: Record<string, unknown> = { title: name, status: a.status ?? 'in_progress' }
  if (a.description?.trim()) body.description = a.description.trim()
  const p = await c.api.createProject(body)
  return { text: `Projekt ${p.title} angelegt, Status ${projectStatusDe(p.status)}. Es hat noch keine Karten.`, target: p.title }
}

export const updateProjectInput = {
  project: z.string().describe('Bisheriger Projektname'),
  name: z.string().min(2).max(120).optional().describe('Neuer Name'),
  description: z.string().max(10_000).optional().describe('Neue Beschreibung, ersetzt die alte'),
  status: z.enum(PROJECT_STATUS).optional().describe('Neuer Status. cancelled = archiviert.'),
  archive: z.boolean().optional().describe('true archiviert das Projekt (Status cancelled). Karten bleiben erhalten, nichts wird gelöscht.'),
}

async function updateProject(c: Ctx, a: z.infer<z.ZodObject<typeof updateProjectInput>>): Promise<{ text: string; target: string }> {
  const status = a.archive ? 'cancelled' : a.status
  if (!a.name && a.description === undefined && !status) throw new Say('Was soll sich am Projekt ändern, Name, Beschreibung oder Status?')
  const p = await resolveProject(c.api, a.project)
  const body: Record<string, unknown> = {}
  const said: string[] = []
  if (a.name?.trim() && a.name.trim() !== p.title) {
    const clash = (await c.api.projects()).find((o) => o.id !== p.id && norm(o.title) === norm(a.name ?? ''))
    if (clash) throw new Say(`Ein Projekt ${clash.title} gibt es schon.`)
    body.title = a.name.trim()
    said.push(`heißt jetzt ${a.name.trim()}`)
  }
  if (a.description !== undefined) {
    body.description = a.description.trim()
    said.push('hat eine neue Beschreibung')
  }
  if (status) {
    body.status = status
    said.push(status === 'cancelled' ? 'ist archiviert, die Karten bleiben erhalten' : `steht auf ${projectStatusDe(status)}`)
  }
  if (!said.length) throw new Say(`Das Projekt heißt schon ${p.title}.`)
  const u = await c.api.updateProject(p.id, body)
  return { text: `Das Projekt ${p.title} ${said.join(' und ')}.`, target: u.title }
}

export const getProjectInput = { project: z.string().describe('Projektname') }

async function getProject(c: Ctx, a: { project: string }): Promise<string> {
  const found = await resolveProject(c.api, a.project)
  const [p, ...perStatus] = await Promise.all([
    c.api.getProject(found.id),
    ...STATUS.map((s) => c.api.listIssues({ projectId: found.id, statuses: [s], limit: 1 })),
  ])
  const parts = [`Projekt ${p.title}, Status ${projectStatusDe(p.status)}.`]
  const desc = speakable(p.description, 500)
  parts.push(desc ? `Beschreibung: ${desc}` : 'Keine Beschreibung.')
  const total = perStatus.reduce((n, r) => n + r.total, 0)
  if (!total) {
    parts.push('Noch keine Karten.')
    return parts.join(' ')
  }
  const counts = STATUS.map((s, n) => [s, perStatus[n].total] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${statusDe(s)}`)
  parts.push(`${total === 1 ? 'Eine Karte' : `${total} Karten`}: ${counts.join(', ')}.`)
  const last = perStatus
    .flatMap((r) => r.issues)
    .sort((x, y) => y.updated_at.localeCompare(x.updated_at))
    .at(0)
  if (last) parts.push(`Zuletzt geändert ${ago(last.updated_at, c.nowMs)}: ${last.identifier}, ${last.title}.`)
  return parts.join(' ')
}

async function systemStatus(c: Ctx): Promise<string> {
  const [runtimes, agents, working] = await Promise.all([
    c.api.runtimes(),
    c.api.agents(),
    c.api.listIssues({ statuses: ['in_progress'], limit: 1 }),
  ])
  const online = runtimes.filter((r) => r.status === 'online')
  const parts: string[] = []
  if (runtimes.length === 0) parts.push('Es ist kein Daemon registriert.')
  else if (online.length === runtimes.length) parts.push(`Der Daemon läuft, alle ${runtimes.length} Laufzeiten sind online.`)
  else if (online.length === 0) {
    const last = runtimes.map((r) => r.last_seen_at).filter((v): v is string => Boolean(v)).sort().at(-1)
    parts.push(`Der Daemon ist offline${last ? `, zuletzt gesehen ${ago(last, c.nowMs)}` : ''}.`)
  } else {
    const off = runtimes.filter((r) => r.status !== 'online').map((r) => r.provider || r.name)
    parts.push(`${online.length} von ${runtimes.length} Laufzeiten online, offline: ${off.join(', ')}.`)
  }
  const active = agents.filter((a) => !a.archived_at)
  const busy = active.filter((a) => a.status === 'working')
  parts.push(
    busy.length
      ? `${busy.length} von ${active.length} Agenten arbeiten gerade: ${busy.map((a) => a.name).join(', ')}.`
      : `Alle ${active.length} Agenten sind frei.`,
  )
  parts.push(`${working.total === 0 ? 'Kein' : working.total} ${working.total === 1 ? 'Issue ist' : 'Issues sind'} in Arbeit.`)
  return parts.join(' ')
}

async function listProjects(c: Ctx): Promise<string> {
  const projects = await c.api.projects()
  const active = projects.filter((p) => p.status === 'in_progress').map((p) => p.title)
  const rest = projects.filter((p) => p.status !== 'in_progress').map((p) => p.title)
  return `${projects.length} Projekte. Aktiv sind: ${active.join(', ') || 'keine'}. Weitere: ${rest.join(', ')}.`
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

export interface Principal {
  grantId: string
  clientId: string
  userId: string
  multicaToken: string
}

export interface ToolDeps {
  db: DatabaseSync
  now: Clock
  multicaUrl: string
  workspaceId: string
  fetch: typeof fetch
  /** Multica rejected the session: drop the grant so the client logs in again. */
  onSessionExpired: (grantId: string) => void
}

const RO = { readOnlyHint: true, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const

/** One MCP server per request, bound to the grant of the bearer token. */
export function buildMcpServer(deps: ToolDeps, who: Principal): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS })
  const api = new MulticaApi(deps.fetch, deps.multicaUrl, deps.workspaceId, who.multicaToken)

  const run = async (tool: string, write: boolean, args: unknown, fn: (c: Ctx) => Promise<string | { text: string; target: string }>) => {
    let text: string
    let target: string | null = null
    let result: 'ok' | 'fehler' | 'abgelehnt' = 'ok'
    let error: string | undefined
    try {
      const r = await fn({ api, userId: who.userId, nowMs: deps.now() * 1000 })
      text = typeof r === 'string' ? r : r.text
      target = typeof r === 'string' ? null : r.target
    } catch (err) {
      if (err instanceof Say) {
        text = err.message
        result = 'abgelehnt'
      } else if (err instanceof MulticaError && err.status === 401) {
        deps.onSessionExpired(who.grantId)
        text = 'Die Multica-Anmeldung ist abgelaufen. Bitte den Connector in Claude neu verbinden.'
        result = 'fehler'
        error = 'multica 401'
      } else {
        text = write ? 'Das hat nicht geklappt, in Multica wurde nichts geändert.' : 'Multica antwortet gerade nicht richtig.'
        result = 'fehler'
        error = String((err as Error)?.message ?? err).slice(0, 300)
      }
    }
    if (write || result === 'fehler') {
      audit(deps.db, deps.now, {
        grantId: who.grantId,
        clientId: who.clientId,
        action: `tool:${tool}`,
        target,
        result,
        detail: { args, ...(error ? { error } : {}) },
      })
    }
    return { content: [{ type: 'text' as const, text }], ...(result === 'ok' ? {} : { isError: true }) }
  }

  server.registerTool(
    'list_issues',
    {
      title: 'Issues auflisten',
      description:
        'Issues auflisten und filtern: nach Projekt, Status, Zuständigem, Oberkarte (parent), Zeitraum (geändert in den letzten N Tagen) oder Suchbegriff. Zuletzt geänderte zuerst, seitenweise mit page.',
      inputSchema: listIssuesInput,
      annotations: RO,
    },
    async (a) => run('list_issues', false, a, (c) => listIssues(c, a)),
  )
  server.registerTool(
    'get_issue',
    {
      title: 'Issue lesen',
      description: 'Ein Issue mit Status, Zuständigem, Beschreibung und den letzten drei Kommentaren.',
      inputSchema: getIssueInput,
      annotations: RO,
    },
    async (a) => run('get_issue', false, a, (c) => getIssue(c, a)),
  )
  server.registerTool(
    'create_issue',
    {
      title: 'Issue anlegen',
      description:
        'Legt ein Issue in einem Projekt an, auf Wunsch als Unterkarte (parent, stage), mit Abhängigkeiten (blocked_by, blocks) und Labels. Gibt es das Projekt noch nicht, zuerst create_project aufrufen. Vorher Titel, Projekt und Zuständigen bestätigen lassen.',
      inputSchema: createIssueInput,
      annotations: WRITE,
    },
    async (a) => run('create_issue', true, a, (c) => createIssue(c, a)),
  )
  server.registerTool(
    'update_issue',
    {
      title: 'Status oder Zuständigen ändern',
      description: 'Ändert den Status und/oder den Zuständigen eines Issues.',
      inputSchema: updateIssueInput,
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (a) => run('update_issue', true, a, (c) => updateIssue(c, a)),
  )
  server.registerTool(
    'add_comment',
    {
      title: 'Kommentar schreiben',
      description: 'Schreibt einen Kommentar als fl0w an ein Issue. Vorher den Wortlaut bestätigen lassen.',
      inputSchema: addCommentInput,
      annotations: WRITE,
    },
    async (a) => run('add_comment', true, a, (c) => addComment(c, a)),
  )
  server.registerTool(
    'bulk_update_issues',
    {
      title: 'Mehrere Karten auf einmal ändern',
      description:
        'Setzt Status und/oder Zuständigen für mehrere Karten auf einmal: eine Liste von Kennungen oder alle offenen Unterkarten einer Oberkarte, etwa eine ganze Phase auf todo oder cancelled. Vorher die Karten und den neuen Stand bestätigen lassen.',
      inputSchema: bulkUpdateInput,
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (a) => run('bulk_update_issues', true, a, (c) => bulkUpdate(c, a)),
  )
  server.registerTool(
    'archive_issue',
    {
      title: 'Karte abbrechen (Duplikat)',
      description:
        'Bricht eine versehentlich oder doppelt angelegte Karte ab, auf Wunsch mit Verweis auf das Original. Nichts wird gelöscht, die Karte lässt sich wieder öffnen.',
      inputSchema: archiveIssueInput,
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (a) => run('archive_issue', true, a, (c) => archiveIssue(c, a)),
  )
  server.registerTool(
    'create_project',
    {
      title: 'Projekt anlegen',
      description:
        'Legt ein neues, leeres Projekt an. Immer verwenden, wenn ein genanntes Projekt noch nicht existiert, statt dafür eine Karte an einen Agenten zu schreiben. Vorher Namen bestätigen lassen.',
      inputSchema: createProjectInput,
      annotations: WRITE,
    },
    async (a) => run('create_project', true, a, (c) => createProject(c, a)),
  )
  server.registerTool(
    'update_project',
    {
      title: 'Projekt ändern oder archivieren',
      description: 'Benennt ein Projekt um, ersetzt seine Beschreibung, ändert den Status oder archiviert es. Archivieren löscht keine Karten.',
      inputSchema: updateProjectInput,
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (a) => run('update_project', true, a, (c) => updateProject(c, a)),
  )
  server.registerTool(
    'get_project',
    {
      title: 'Projekt lesen',
      description: 'Ein Projekt mit Status, Beschreibung, Anzahl Karten je Status und der zuletzt geänderten Karte.',
      inputSchema: getProjectInput,
      annotations: RO,
    },
    async (a) => run('get_project', false, a, (c) => getProject(c, a)),
  )
  server.registerTool(
    'system_status',
    {
      title: 'Stand von Daemon und Agenten',
      description: 'Ob der lokale Daemon läuft, welche Agenten gerade arbeiten und wie viele Issues in Arbeit sind.',
      inputSchema: {},
      annotations: RO,
    },
    async () => run('system_status', false, {}, (c) => systemStatus(c)),
  )
  server.registerTool(
    'list_projects',
    {
      title: 'Projekte auflisten',
      description: 'Alle Projektnamen des Workspace, aktive zuerst. Fehlt ein Projekt, legt create_project es an.',
      inputSchema: {},
      annotations: RO,
    },
    async () => run('list_projects', false, {}, (c) => listProjects(c)),
  )
  return server
}

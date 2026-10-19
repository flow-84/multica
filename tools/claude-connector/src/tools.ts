// MCP tools. Every answer is a few short German sentences: the Claude app
// reads them aloud in voice mode, so no tables, no Markdown, no UUIDs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { type Agent, type Issue, type Member, MulticaApi, MulticaError, type Project } from './multica.ts'
import { type Clock, audit } from './store.ts'

export const SERVER_INFO = { name: 'multica', version: '1.0.0' }

const INSTRUCTIONS = [
  'Steuert den Multica-Workspace von fl0w (Issues, Projekte, Agenten). Antworten sind kurze deutsche Sätze zum Vorlesen.',
  'Projekte und Zuständige werden mit ihrem Namen angegeben, Issues mit ihrer Kennung wie MS-2400.',
  'Vor dem Anlegen eines Issues, einer Statusänderung oder einem Kommentar den Inhalt kurz bestätigen lassen.',
  'Ein Issue mit Status todo und einem Agenten als Zuständigem startet sofort einen Agentenlauf.',
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

const statusDe = (s: string) => STATUS_DE[s] ?? s

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
  throw new Say(`Ein Projekt „${name}“ gibt es nicht.`)
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
  limit: z.number().int().min(1).max(25).optional().describe('Höchstens so viele vorlesen, Standard 8.'),
}

async function listIssues(c: Ctx, a: z.infer<z.ZodObject<typeof listIssuesInput>>): Promise<string> {
  const limit = a.limit ?? 8
  const [project, people] = await Promise.all([a.project ? resolveProject(c.api, a.project) : undefined, loadPeople(c.api)])
  const assignee = a.assignee ? resolveAssignee(people, a.assignee, c.userId) : undefined
  let issues: Issue[]
  if (a.query) {
    issues = await c.api.searchIssues(a.query, 50)
    if (project) issues = issues.filter((i) => i.project_id === project.id)
    if (assignee) issues = issues.filter((i) => i.assignee_id === assignee.id)
    if (a.status?.length) issues = issues.filter((i) => a.status!.includes(i.status as Status))
  } else {
    const statuses = a.status?.length ? a.status : STATUS.filter((s) => !CLOSED.has(s))
    issues = await c.api.listIssues({ projectId: project?.id, statuses, assigneeId: assignee?.id, limit: 100 })
  }
  if (a.days) {
    const since = c.nowMs - a.days * 86_400_000
    issues = issues.filter((i) => Date.parse(i.updated_at) >= since)
  }
  issues.sort((x, y) => y.updated_at.localeCompare(x.updated_at))

  const scope = [
    project ? `im Projekt ${project.title}` : null,
    assignee ? `bei ${assignee.name}` : null,
    a.query ? `zu „${a.query}“` : null,
    a.days ? `aus den letzten ${a.days} Tagen` : null,
  ]
    .filter(Boolean)
    .join(' ')
  const what = a.status?.length ? `mit Status ${a.status.map(statusDe).join(' oder ')}` : a.query ? '' : 'offen'
  const head = `${issues.length === 0 ? 'Keine' : issues.length} ${issues.length === 1 ? 'Issue' : 'Issues'} ${[what, scope].filter(Boolean).join(' ')}`.trim()
  if (issues.length === 0) return `${head}.`
  const shown = issues.slice(0, limit)
  const more = issues.length > shown.length ? ` Das waren die ${shown.length} zuletzt geänderten.` : ''
  return `${head}, zuletzt geänderte zuerst. ${shown.map((i) => issueLine(i, people, c.nowMs)).join(' ')}${more}`
}

export const getIssueInput = { issue: z.string().min(2).max(40).describe('Kennung wie MS-2400') }

async function getIssue(c: Ctx, a: { issue: string }): Promise<string> {
  const i = await loadIssue(c.api, a.issue)
  const [people, comments, projects] = await Promise.all([loadPeople(c.api), c.api.recentComments(i.id, 3), c.api.projects()])
  const project = projects.find((p) => p.id === i.project_id)?.title
  const who = assigneeName(people, i.assignee_type, i.assignee_id)
  const parts = [
    `${i.identifier}: ${i.title}.`,
    `Status ${statusDe(i.status)}, Priorität ${PRIORITY_DE[i.priority] ?? i.priority}, ${who ? `zuständig ${who}` : 'ohne Zuständigen'}${project ? `, Projekt ${project}` : ''}.`,
    `Angelegt ${ago(i.created_at, c.nowMs)}, zuletzt geändert ${ago(i.updated_at, c.nowMs)}.`,
  ]
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

export const createIssueInput = {
  project: z.string().describe('Projektname'),
  title: z.string().min(3).max(200).describe('Titel des Issues'),
  description: z.string().max(10_000).optional().describe('Beschreibung, gern mehrere Sätze'),
  assignee: z.string().optional().describe('Name eines Agenten (Builder, Scribe, Reviewer, Claude …) oder Mitglieds, "ich" für fl0w'),
  status: z.enum(STATUS).optional().describe('Standard backlog. todo mit Agent startet sofort einen Lauf.'),
  priority: z.enum(PRIORITY).optional().describe('Standard none'),
}

async function createIssue(c: Ctx, a: z.infer<z.ZodObject<typeof createIssueInput>>): Promise<{ text: string; target: string }> {
  const project = await resolveProject(c.api, a.project)
  const assignee = a.assignee ? resolveAssignee(await loadPeople(c.api), a.assignee, c.userId) : undefined
  const status = a.status ?? 'backlog'
  const body: Record<string, unknown> = { title: a.title.trim(), project_id: project.id, status, priority: a.priority ?? 'none' }
  if (a.description?.trim()) body.description = a.description.trim()
  if (assignee) {
    body.assignee_type = assignee.type
    body.assignee_id = assignee.id
  }
  const i = await c.api.createIssue(body)
  const run = assignee?.type === 'agent' && status === 'todo' ? ` ${assignee.name} fängt gleich an.` : ''
  return {
    text: `Angelegt: ${i.identifier}, „${i.title}“, im Projekt ${project.title}. Status ${statusDe(i.status)}${assignee ? `, zuständig ${assignee.name}` : ', ohne Zuständigen'}.${run}`,
    target: i.identifier,
  }
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
    if (['niemand', 'keiner', 'keine', 'nobody'].includes(norm(a.assignee))) {
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

async function systemStatus(c: Ctx): Promise<string> {
  const [runtimes, agents, working] = await Promise.all([
    c.api.runtimes(),
    c.api.agents(),
    c.api.listIssues({ statuses: ['in_progress'], limit: 100 }),
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
  parts.push(`${working.length === 0 ? 'Kein' : working.length} ${working.length === 1 ? 'Issue ist' : 'Issues sind'} in Arbeit.`)
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
        'Issues auflisten und filtern: nach Projekt, Status, Zuständigem, Zeitraum (geändert in den letzten N Tagen) oder Suchbegriff. Zuletzt geänderte zuerst.',
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
      description: 'Legt ein Issue in einem Projekt an. Vorher Titel, Projekt und Zuständigen bestätigen lassen.',
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
      description: 'Alle Projektnamen des Workspace, aktive zuerst.',
      inputSchema: {},
      annotations: RO,
    },
    async () => run('list_projects', false, {}, (c) => listProjects(c)),
  )
  return server
}

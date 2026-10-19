// Thin client for the Multica HTTP API (the same endpoints the `multica` CLI
// uses). Calls run as fl0w with the session token of the OAuth grant.

export class MulticaError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface Issue {
  id: string
  identifier: string
  title: string
  description: string | null
  status: string
  priority: string
  assignee_type: 'member' | 'agent' | 'squad' | null
  assignee_id: string | null
  project_id: string | null
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  title: string
  status: string
}

export interface Agent {
  id: string
  name: string
  status: string
  archived_at: string | null
  runtime_id: string | null
}

export interface Member {
  user_id: string
  name: string
  email: string
}

export interface Runtime {
  id: string
  name: string
  status: string
  provider: string
  last_seen_at: string | null
}

export interface Comment {
  id: string
  author_type: string
  author_id: string
  content: string
  created_at: string
}

type Fetch = typeof fetch

async function call<T>(f: Fetch, url: string, init: RequestInit): Promise<T> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  if (!res.ok) {
    let msg = text.slice(0, 300)
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg
    } catch {
      // body was not JSON
    }
    throw new MulticaError(res.status, msg)
  }
  return (text ? JSON.parse(text) : null) as T
}

/** Email login: Multica mails a six-digit code to the address. */
export async function sendLoginCode(f: Fetch, baseUrl: string, email: string): Promise<void> {
  await call(f, `${baseUrl}/auth/send-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
}

export async function verifyLoginCode(
  f: Fetch,
  baseUrl: string,
  email: string,
  code: string,
): Promise<{ token: string; user: { id: string; email: string; name: string } }> {
  return call(f, `${baseUrl}/auth/verify-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
  })
}

function list<T>(v: unknown, key: string): T[] {
  if (Array.isArray(v)) return v as T[]
  const inner = (v as Record<string, unknown> | null)?.[key]
  return Array.isArray(inner) ? (inner as T[]) : []
}

export class MulticaApi {
  private readonly f: Fetch
  private readonly baseUrl: string
  private readonly workspaceId: string
  private readonly token: string

  constructor(f: Fetch, baseUrl: string, workspaceId: string, token: string) {
    this.f = f
    this.baseUrl = baseUrl
    this.workspaceId = workspaceId
    this.token = token
  }

  private req<T>(method: string, path: string, body?: unknown): Promise<T> {
    return call<T>(this.f, `${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-workspace-id': this.workspaceId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  async projects(): Promise<Project[]> {
    return list<Project>(await this.req('GET', `/api/projects?workspace_id=${this.workspaceId}`), 'projects')
  }

  async agents(): Promise<Agent[]> {
    return list<Agent>(await this.req('GET', `/api/agents?workspace_id=${this.workspaceId}`), 'agents')
  }

  async members(): Promise<Member[]> {
    return list<Member>(await this.req('GET', `/api/workspaces/${this.workspaceId}/members`), 'members')
  }

  async runtimes(): Promise<Runtime[]> {
    return list<Runtime>(await this.req('GET', `/api/runtimes?workspace_id=${this.workspaceId}`), 'runtimes')
  }

  /** Most recently changed first. The server caps a page at 100; `total` counts every match. */
  async listIssues(q: { projectId?: string; statuses?: string[]; assigneeId?: string; limit: number }): Promise<{ issues: Issue[]; total: number }> {
    const p = new URLSearchParams({ workspace_id: this.workspaceId, limit: String(q.limit), sort: 'updated_at', direction: 'desc' })
    if (q.projectId) p.set('project_id', q.projectId)
    if (q.statuses?.length) p.set('statuses', q.statuses.join(','))
    if (q.assigneeId) p.set('assignee_id', q.assigneeId)
    const r = await this.req<{ issues?: Issue[]; total?: number }>('GET', `/api/issues?${p}`)
    const issues = list<Issue>(r, 'issues')
    return { issues, total: typeof r?.total === 'number' ? r.total : issues.length }
  }

  /** The server caps search at 50 hits and returns no total. */
  async searchIssues(query: string, limit: number): Promise<Issue[]> {
    const p = new URLSearchParams({ q: query, limit: String(limit), include_closed: 'true' })
    return list<Issue>(await this.req('GET', `/api/issues/search?${p}`), 'issues')
  }

  getIssue(ref: string): Promise<Issue> {
    return this.req('GET', `/api/issues/${encodeURIComponent(ref)}`)
  }

  async recentComments(issueId: string, n: number): Promise<Comment[]> {
    const all = list<Comment & { replies?: Comment[] }>(await this.req('GET', `/api/issues/${issueId}/comments?recent=${n}`), 'comments')
    const flat = all.flatMap((c) => [c, ...(Array.isArray(c.replies) ? c.replies : [])])
    return flat.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-n)
  }

  createIssue(body: Record<string, unknown>): Promise<Issue> {
    return this.req('POST', '/api/issues', body)
  }

  updateIssue(issueId: string, body: Record<string, unknown>): Promise<Issue> {
    return this.req('PUT', `/api/issues/${issueId}`, body)
  }

  addComment(issueId: string, content: string): Promise<Comment> {
    return this.req('POST', `/api/issues/${issueId}/comments`, { content })
  }
}

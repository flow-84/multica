// Test harness: a fake Multica API plus the connector on random ports, and a
// helper that walks the whole OAuth flow the way claude.ai does.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Config } from '../src/config.ts'
import { createApp } from '../src/http.ts'
import type { Issue } from '../src/multica.ts'
import { openDb } from '../src/store.ts'

export const WS = '50b08bfb-a5fe-426f-b012-5da67a25d153'
export const FLOW = '46ece536-d531-4ef9-a493-be97b0118e06'
export const EMAIL = 'info@model2star.com'
export const GOOD_CODE = '123456'
/** A valid Multica code, but for another account. */
export const OTHER_CODE = '654321'
export const JWT = 'jwt-of-fl0w-session'
export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
export const P_MULTICA = '10fa81ae-9125-4c88-a3ba-de471b4eba43'
export const P_CRM = '7699726c-e49d-4382-b8d0-50800065aa28'
export const BUILDER = '1d76643a-7409-477f-9436-d29e0ffd2275'
export const CLAUDE = 'b86596ff-926e-475c-95c6-5415625b27b6'

export const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, 'Z')
export const HOUR = 3_600_000

export interface FakeMultica {
  url: string
  server: Server
  issues: Issue[]
  sentCodes: string[]
  writes: { method: string; path: string; body: unknown }[]
  /** When true every API call answers 401, as after an expired session. */
  expired: boolean
}

export function fakeIssue(n: number, o: Partial<Issue>): Issue {
  return {
    id: `0000000${n}-0000-0000-0000-000000000000`,
    identifier: `MS-${n}`,
    title: `Issue ${n}`,
    description: null,
    status: 'todo',
    priority: 'none',
    assignee_type: null,
    assignee_id: null,
    project_id: P_MULTICA,
    created_at: iso(48 * HOUR),
    updated_at: iso(2 * HOUR),
    ...o,
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const c of req) raw += c
  return raw ? JSON.parse(raw) : {}
}

export async function startFakeMultica(): Promise<FakeMultica> {
  const state: FakeMultica = {
    url: '',
    server: undefined as unknown as Server,
    sentCodes: [],
    writes: [],
    expired: false,
    issues: [
      fakeIssue(1, {
        title: 'MCP-Connector bauen',
        status: 'in_progress',
        assignee_type: 'agent',
        assignee_id: CLAUDE,
        description: '## Ziel\n\nfl0w will **Multica** per Sprache steuern. Siehe [MS-2397](mention://issue/x).',
      }),
      fakeIssue(2, { title: 'Daemon-Log aufräumen', status: 'backlog', assignee_type: 'agent', assignee_id: BUILDER, updated_at: iso(10 * 24 * HOUR) }),
      fakeIssue(3, { title: 'Alter Bug', status: 'done', updated_at: iso(1 * HOUR) }),
      fakeIssue(4, { title: 'CRM-Export', status: 'todo', project_id: P_CRM }),
    ],
  }
  const comments = [
    { id: 'c1', author_type: 'member', author_id: FLOW, content: 'Bitte mit **OAuth**.', created_at: iso(5 * HOUR) },
    { id: 'c2', author_type: 'agent', author_id: CLAUDE, content: 'Ich baue das jetzt.', created_at: iso(1 * HOUR) },
  ]
  let next = 100

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(v))
    }
    if (url.pathname === '/auth/send-code') {
      const b = await body(req)
      state.sentCodes.push(String(b.email))
      return send(200, { message: 'sent' })
    }
    if (url.pathname === '/auth/verify-code') {
      const b = await body(req)
      if (b.email === EMAIL && b.code === GOOD_CODE) return send(200, { token: JWT, user: { id: FLOW, email: EMAIL, name: 'fl0w' } })
      if (b.email === EMAIL && b.code === OTHER_CODE) return send(200, { token: 'jwt-other', user: { id: 'someone-else', email: EMAIL, name: 'x' } })
      return send(400, { error: 'invalid or expired code' })
    }
    if (state.expired || req.headers.authorization !== `Bearer ${JWT}` || req.headers['x-workspace-id'] !== WS) {
      return send(401, { error: 'unauthorized' })
    }
    const p = url.pathname.replace(/\/+$/, '')
    if (req.method === 'GET' && p === '/api/projects') {
      return send(200, {
        projects: [
          { id: P_MULTICA, title: 'Multica', status: 'planned' },
          { id: P_CRM, title: 'CRM (m2s)', status: 'in_progress' },
          { id: 'p-map', title: 'map.multica', status: 'in_progress' },
        ],
      })
    }
    if (req.method === 'GET' && p === '/api/agents') {
      return send(200, [
        { id: CLAUDE, name: 'Claude', status: 'working', archived_at: null, runtime_id: 'r1' },
        { id: BUILDER, name: 'Builder', status: 'idle', archived_at: null, runtime_id: 'r1' },
        { id: 'a-old', name: 'Fuzz-Tester', status: 'idle', archived_at: iso(HOUR), runtime_id: 'r1' },
      ])
    }
    if (req.method === 'GET' && p === `/api/workspaces/${WS}/members`) {
      return send(200, [{ user_id: FLOW, name: 'fl0w', email: EMAIL }])
    }
    if (req.method === 'GET' && p === '/api/runtimes') {
      return send(200, [
        { id: 'r1', name: 'Claude (MacBook)', status: 'online', provider: 'claude', last_seen_at: iso(0) },
        { id: 'r2', name: 'Codex (MacBook)', status: 'online', provider: 'codex', last_seen_at: iso(0) },
      ])
    }
    if (req.method === 'GET' && p === '/api/issues/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50)
      return send(200, { issues: state.issues.filter((i) => i.title.toLowerCase().includes(q)).slice(0, limit) })
    }
    if (req.method === 'GET' && p === '/api/issues') {
      const statuses = url.searchParams.get('statuses')?.split(',')
      const project = url.searchParams.get('project_id')
      const assignee = url.searchParams.get('assignee_id')
      const list = state.issues.filter(
        (i) => (!statuses || statuses.includes(i.status)) && (!project || i.project_id === project) && (!assignee || i.assignee_id === assignee),
      )
      // Like the server: sort column and direction, a page capped at 100, total over all matches.
      const col = (url.searchParams.get('sort') ?? 'created_at') as 'created_at' | 'updated_at'
      const dir = url.searchParams.get('direction') === 'asc' ? 1 : -1
      list.sort((x, y) => dir * x[col].localeCompare(y[col]))
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100)
      return send(200, { issues: list.slice(0, limit), total: list.length, has_more: list.length > limit })
    }
    if (req.method === 'POST' && p === '/api/issues') {
      const b = await body(req)
      state.writes.push({ method: 'POST', path: p, body: b })
      const n = next++
      const i = fakeIssue(n, { ...(b as Partial<Issue>), created_at: iso(0), updated_at: iso(0) })
      state.issues.push(i)
      return send(201, i)
    }
    const m = /^\/api\/issues\/([^/]+)(\/comments)?$/.exec(p)
    if (m) {
      const ref = decodeURIComponent(m[1])
      const issue = state.issues.find((i) => i.id === ref || i.identifier === ref)
      if (!issue) return send(404, { error: 'issue not found' })
      if (m[2] && req.method === 'GET') return send(200, issue.identifier === 'MS-1' ? comments : [])
      if (m[2] && req.method === 'POST') {
        const b = await body(req)
        state.writes.push({ method: 'POST', path: p, body: b })
        return send(201, { id: 'c-new', author_type: 'member', author_id: FLOW, content: b.content, created_at: iso(0) })
      }
      if (req.method === 'GET') return send(200, issue)
      if (req.method === 'PUT') {
        const b = await body(req)
        state.writes.push({ method: 'PUT', path: p, body: b })
        Object.assign(issue, b, { updated_at: iso(0) })
        return send(200, issue)
      }
    }
    send(404, { error: `fake: no route ${req.method} ${p}` })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  state.server = server
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return state
}

export interface Harness {
  base: string
  db: DatabaseSync
  fake: FakeMultica
  clock: { t: number }
  close: () => Promise<void>
}

export async function startHarness(): Promise<Harness> {
  const fake = await startFakeMultica()
  const db = openDb(':memory:')
  const clock = { t: Math.floor(Date.now() / 1000) }
  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'https://connector.test',
    multicaUrl: fake.url,
    workspaceId: WS,
    allowedEmail: EMAIL,
    allowedUserId: FLOW,
    dbPath: ':memory:',
  }
  const app = createApp({ config, db, now: () => clock.t, fetch, authorizeLimit: 1000, quiet: true })
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
  return {
    base,
    db,
    fake,
    clock,
    close: async () => {
      await new Promise((r) => app.close(r))
      await new Promise((r) => fake.server.close(r))
      db.close()
    },
  }
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export async function register(base: string, redirectUris: unknown = [REDIRECT]): Promise<Response> {
  return fetch(`${base}/mcp-oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris }),
  })
}

export function form(base: string, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
}

export function authorizeParams(clientId: string, challenge: string): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    scope: 'multica',
  }
}

/** Register, log in with the Multica code, return the authorization code. */
export async function loginCode(base: string, code = GOOD_CODE): Promise<{ clientId: string; verifier: string; authCode: string }> {
  const reg = (await (await register(base)).json()) as { client_id: string }
  const { verifier, challenge } = pkce()
  const params = authorizeParams(reg.client_id, challenge)
  assert.equal((await form(base, '/mcp-oauth/authorize', { ...params, step: 'send' })).status, 200)
  const res = await form(base, '/mcp-oauth/authorize', { ...params, step: 'verify', code })
  assert.equal(res.status, 302)
  const loc = new URL(res.headers.get('location') ?? '')
  assert.equal(loc.searchParams.get('state'), 'st-1')
  return { clientId: reg.client_id, verifier, authCode: loc.searchParams.get('code') ?? '' }
}

export async function tokenRequest(base: string, fields: Record<string, string>): Promise<Response> {
  return form(base, '/mcp-oauth/token', fields)
}

export async function login(base: string): Promise<{ access: string; refresh: string; clientId: string }> {
  const { clientId, verifier, authCode } = await loginCode(base)
  const res = await tokenRequest(base, {
    grant_type: 'authorization_code',
    code: authCode,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  })
  assert.equal(res.status, 200)
  const t = (await res.json()) as { access_token: string; refresh_token: string }
  return { access: t.access_token, refresh: t.refresh_token, clientId }
}

export async function mcpClient(base: string, access: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access}` } } }))
  return client
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean }
  return { text: r.content.map((c) => c.text).join(' '), isError: Boolean(r.isError) }
}

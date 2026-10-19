// HTTP surface: OAuth discovery and endpoints, the login page, and the
// Streamable HTTP MCP endpoint. Plain node:http, no framework.
//
// Login: fl0w signs in with the Multica email code. The page only ever asks
// Multica to mail the configured address, so nobody can use it to create
// Multica accounts, and the verified Multica user id must match the allowed
// one. The Multica session from that login is what the tools act with.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Config } from './config.ts'
import { MulticaError, sendLoginCode, verifyLoginCode } from './multica.ts'
import { OAuthStore, SCOPE } from './oauth.ts'
import { type Clock, audit } from './store.ts'
import { buildMcpServer } from './tools.ts'

export interface AppDeps {
  config: Config
  db: DatabaseSync
  now: Clock
  fetch: typeof fetch
  /** Requests per minute and client IP on the login form; tests raise it. */
  authorizeLimit?: number
  /** No access log (tests). */
  quiet?: boolean
}

const MAX_BODY = 1 << 20
/** JSON-RPC method per /mcp response, for the access log. */
const rpcMethod = new WeakMap<ServerResponse, string>()

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'body too large')
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  const type = String(req.headers['content-type'] ?? '')
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw))
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    // No form-action: Chrome applies it to the redirect after the login post,
    // which would block the hop back to the client's redirect_uri.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  })
  res.end(body)
}

function redirect(res: ServerResponse, to: string, q: Record<string, string | undefined>): void {
  const u = new URL(to)
  for (const [k, v] of Object.entries(q)) if (v !== undefined) u.searchParams.set(k, v)
  res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' })
  res.end()
}

/** Tailscale Funnel connects from loopback and sets X-Forwarded-For. */
function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? ''
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && /^(127\.|::1|::ffff:127\.)/.test(remote)) return xff.split(',')[0].trim()
  return remote
}

/** Fixed-window limiter per key, in memory: enough for one MacBook and one user. */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; n: number }>()
  private readonly now: Clock
  constructor(now: Clock) {
    this.now = now
  }
  allow(key: string, max: number, windowS = 60): boolean {
    const t = this.now()
    const h = this.hits.get(key)
    if (!h || t - h.start >= windowS) {
      this.hits.set(key, { start: t, n: 1 })
      if (this.hits.size > 10_000) this.hits.clear()
      return true
    }
    h.n += 1
    return h.n <= max
  }
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@')
  return `${user.slice(0, 1)}***@${domain}`
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;background:#f5f5f5;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:#fff;padding:28px;border-radius:12px;max-width:380px;width:100%;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 6px}p{color:#555;font-size:14px}label{display:block;font-size:14px;margin-top:14px}
input[type=text]{width:100%;box-sizing:border-box;padding:10px;margin-top:4px;border:1px solid #ccc;border-radius:8px;font-size:22px;letter-spacing:4px}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:#111;color:#fff;font-size:16px}
.err{color:#b00020}
</style></head><body><main>${body}</main></body></html>`
}

type Params = Record<string, string | undefined>
const PASS_THROUGH = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']

function hidden(params: Params): string {
  return PASS_THROUGH.map((k) => (params[k] ? `<input type="hidden" name="${k}" value="${esc(params[k])}">` : '')).join('')
}

/** The redirect target is the one thing a self-registered client cannot fake, so fl0w sees it before signing in. */
function redirectHost(uri: string): string {
  try {
    return new URL(uri).host
  } catch {
    return uri
  }
}

function intro(clientName: string | null, redirectUri: string): string {
  return `<h1>Multica verbinden</h1>
<p>${esc(clientName ?? 'Ein Client')} möchte Issues im Multica-Workspace lesen, anlegen und ändern.</p>
<p>Nach der Anmeldung geht es weiter zu <strong>${esc(redirectHost(redirectUri))}</strong>. Steht dort nicht claude.ai oder claude.com, hier abbrechen.</p>`
}

function sendPage(cfg: Config, params: Params, clientName: string | null, redirectUri: string, error?: string): string {
  return page(
    'Multica verbinden',
    `${intro(clientName, redirectUri)}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/mcp-oauth/authorize">${hidden(params)}<input type="hidden" name="step" value="send">
<button type="submit">Login-Code an ${esc(maskEmail(cfg.allowedEmail))} senden</button></form>`,
  )
}

function codePage(cfg: Config, params: Params, clientName: string | null, redirectUri: string, error?: string): string {
  return page(
    'Multica verbinden',
    `${intro(clientName, redirectUri)}
<p>Multica hat einen Code an ${esc(maskEmail(cfg.allowedEmail))} geschickt.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/mcp-oauth/authorize">${hidden(params)}<input type="hidden" name="step" value="verify">
<label>Code aus der Mail<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required autofocus></label>
<button type="submit">Anmelden und verbinden</button></form>
<form method="post" action="/mcp-oauth/authorize">${hidden(params)}<input type="hidden" name="step" value="send">
<button type="submit" style="background:#666">Neuen Code senden</button></form>`,
  )
}

function errorPage(res: ServerResponse, status: number, msg: string): void {
  html(res, status, page('Fehler', `<h1>Verbindung nicht möglich</h1><p class="err">${esc(msg)}</p>`))
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  if (typeof h !== 'string') return null
  return /^Bearer\s+(.+)$/i.exec(h.trim())?.[1]?.trim() ?? null
}

export function createApp(deps: AppDeps): Server {
  const { config: cfg, db, now } = deps
  const oauth = new OAuthStore(db, now)
  const limiter = new RateLimiter(now)
  const base = cfg.publicUrl
  const resourceMetadataUrl = `${base}/.well-known/oauth-protected-resource/mcp`

  const protectedResource = {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'Multica (m2s)',
  }
  const authServer = {
    issuer: base,
    authorization_endpoint: `${base}/mcp-oauth/authorize`,
    token_endpoint: `${base}/mcp-oauth/token`,
    registration_endpoint: `${base}/mcp-oauth/register`,
    revocation_endpoint: `${base}/mcp-oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  }

  type Check = { ok: true; clientId: string; clientName: string | null; redirectUri: string; challenge: string } | { ok: false }

  /** Unknown client or unregistered redirect: error page, never a redirect (that would be an open redirect). */
  function checkAuthorize(params: Params, res: ServerResponse): Check {
    const client = oauth.getClient(params.client_id)
    if (!client) {
      errorPage(res, 400, 'Unbekannter Client. Den Connector in Claude bitte neu anlegen.')
      return { ok: false }
    }
    const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined)
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      errorPage(res, 400, 'Die Weiterleitungsadresse ist für diesen Client nicht registriert.')
      return { ok: false }
    }
    if (params.response_type !== 'code') {
      redirect(res, redirectUri, { error: 'unsupported_response_type', state: params.state })
      return { ok: false }
    }
    if (!params.code_challenge || params.code_challenge_method !== 'S256') {
      redirect(res, redirectUri, { error: 'invalid_request', error_description: 'PKCE mit S256 ist Pflicht', state: params.state })
      return { ok: false }
    }
    return { ok: true, clientId: client.clientId, clientName: client.clientName, redirectUri, challenge: params.code_challenge }
  }

  async function authorizePost(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const params = (await readBody(req)) as Params
    const c = checkAuthorize(params, res)
    if (!c.ok) return
    if (params.step === 'send') {
      try {
        await sendLoginCode(deps.fetch, cfg.multicaUrl, cfg.allowedEmail)
      } catch (err) {
        // Multica allows one code per minute; the last one is still valid.
        if (!(err instanceof MulticaError && err.status === 429)) {
          return html(res, 502, sendPage(cfg, params, c.clientName, c.redirectUri, 'Multica konnte keinen Code senden. Bitte gleich noch einmal.'))
        }
      }
      return html(res, 200, codePage(cfg, params, c.clientName, c.redirectUri))
    }
    const code = String(params.code ?? '').replace(/\s+/g, '')
    let login: Awaited<ReturnType<typeof verifyLoginCode>> | null = null
    try {
      login = code ? await verifyLoginCode(deps.fetch, cfg.multicaUrl, cfg.allowedEmail, code) : null
    } catch {
      login = null
    }
    if (!login || login.user?.id !== cfg.allowedUserId || login.user.email?.toLowerCase() !== cfg.allowedEmail) {
      audit(db, now, { clientId: c.clientId, action: 'login', result: 'abgelehnt', detail: { ip } })
      return html(res, 401, codePage(cfg, params, c.clientName, c.redirectUri, 'Der Code stimmt nicht oder ist abgelaufen.'))
    }
    const authCode = oauth.createGrantAndCode({
      clientId: c.clientId,
      userId: login.user.id,
      multicaToken: login.token,
      redirectUri: c.redirectUri,
      codeChallenge: c.challenge,
    })
    audit(db, now, { clientId: c.clientId, action: 'login', result: 'ok', detail: { ip, clientName: c.clientName } })
    redirect(res, c.redirectUri, { code: authCode, state: params.state })
  }

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearer(req)
    const who = oauth.verifyAccessToken(token)
    if (!who) {
      const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`]
      if (token) parts.push('error="invalid_token"')
      return json(res, 401, { error: token ? 'invalid_token' : 'unauthorized' }, { 'www-authenticate': parts.join(', ') })
    }
    const body = req.method === 'POST' ? await readBody(req) : undefined
    const rpc = Array.isArray(body) ? body.map((m) => m?.method).join(',') : (body as { method?: string } | undefined)?.method
    if (rpc) rpcMethod.set(res, String(rpc).slice(0, 100))
    // Stateless: one server and transport per request, JSON instead of SSE.
    // A restart loses nothing and Funnel never holds a stream open.
    const server = buildMcpServer(
      { db, now, fetch: deps.fetch, multicaUrl: cfg.multicaUrl, workspaceId: cfg.workspaceId, onSessionExpired: (g) => oauth.revokeGrant(g) },
      who,
    )
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const ip = clientIp(req)
    const m = req.method ?? 'GET'

    if (path === '/healthz') return json(res, 200, { ok: true })
    if (m === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      return json(res, 200, protectedResource)
    }
    if (m === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp')) {
      return json(res, 200, authServer)
    }
    if (path === '/mcp') return mcp(req, res)

    if (m === 'POST' && path === '/mcp-oauth/register') {
      if (!limiter.allow(`register:${ip}`, 20)) return json(res, 429, { error: 'rate_limited' })
      const r = oauth.registerClient((await readBody(req)) as Record<string, unknown>)
      if (!r.ok) return json(res, 400, { error: r.error, error_description: r.description })
      return json(res, 201, {
        client_id: r.client.clientId,
        client_id_issued_at: now(),
        client_name: r.client.clientName ?? undefined,
        redirect_uris: r.client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: SCOPE,
      })
    }
    if (m === 'GET' && path === '/mcp-oauth/authorize') {
      const params = Object.fromEntries(url.searchParams) as Params
      const c = checkAuthorize(params, res)
      if (!c.ok) return
      return html(res, 200, sendPage(cfg, params, c.clientName, c.redirectUri))
    }
    if (m === 'POST' && path === '/mcp-oauth/authorize') {
      // Brake on code guessing; Multica also locks a code after a few attempts.
      if (!limiter.allow(`authorize:${ip}`, deps.authorizeLimit ?? 10)) return errorPage(res, 429, 'Zu viele Versuche. Bitte eine Minute warten.')
      return authorizePost(req, res, ip)
    }
    if (m === 'POST' && path === '/mcp-oauth/token') {
      if (!limiter.allow(`token:${ip}`, 30)) return json(res, 429, { error: 'rate_limited' })
      const b = (await readBody(req)) as Params
      const r =
        b.grant_type === 'authorization_code'
          ? oauth.exchangeCode({ code: b.code, clientId: b.client_id, redirectUri: b.redirect_uri, codeVerifier: b.code_verifier })
          : b.grant_type === 'refresh_token'
            ? oauth.refresh({ refreshToken: b.refresh_token, clientId: b.client_id })
            : ({ ok: false, error: 'unsupported_grant_type', description: 'nur authorization_code und refresh_token' } as const)
      if (!r.ok) return json(res, 400, { error: r.error, error_description: r.description })
      return json(res, 200, r.tokens)
    }
    if (m === 'POST' && path === '/mcp-oauth/revoke') {
      if (!limiter.allow(`revoke:${ip}`, 30)) return json(res, 429, { error: 'rate_limited' })
      const b = (await readBody(req)) as Params
      oauth.revokeToken(b.token)
      audit(db, now, { action: 'revoke', result: 'ok', detail: { ip, hint: b.token_type_hint ?? null } })
      return json(res, 200, {})
    }
    return json(res, 404, { error: 'not_found' })
  }

  return createServer((req, res) => {
    const t0 = Date.now()
    // Access log without query strings: they carry codes and PKCE values.
    res.on('finish', () => {
      if (!deps.quiet) console.log(`${new Date().toISOString()} ${req.method} ${(req.url ?? '').split('?')[0]} ${res.statusCode} ${Date.now() - t0}ms ${rpcMethod.get(res) ?? '-'} ${req.headers['user-agent'] ?? '-'}`)
    })
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error('connector: request failed', req.method, req.url, err)
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal_error' : (err as Error).message })
      else res.end()
    })
  })
}

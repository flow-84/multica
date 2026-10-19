// OAuth 2.1 authorization server for the connector: Dynamic Client
// Registration (RFC 7591), authorization code with mandatory PKCE S256,
// rotating refresh tokens, revocation (RFC 7009). Modelled on the CRM
// promo-voice connector (m2s-crm, MS-2397).
//
// Opaque random tokens, stored as SHA-256 hashes. Every token belongs to a
// grant; a grant holds the Multica session of the login that created it.
// Revoking a refresh token ends the whole grant, so "disconnect" in claude.ai
// cuts access immediately, not when the access token expires.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Clock } from './store.ts'

export const SCOPE = 'multica'
export const ACCESS_TTL_S = 60 * 60
export const REFRESH_TTL_S = 30 * 24 * 60 * 60
export const CODE_TTL_S = 10 * 60
const MAX_REDIRECT_URIS = 5

export function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

/** PKCE S256: base64url(sha256(verifier)) == challenge. OAuth 2.1 has no `plain`. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  return createHash('sha256').update(verifier).digest('base64url') === challenge
}

/** https anywhere, http only on loopback (desktop clients), never a fragment. */
export function isAllowedRedirectUri(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 500) return false
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return false
  }
  if (u.hash) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
}

export interface Client {
  clientId: string
  clientName: string | null
  redirectUris: string[]
}

export interface Grant {
  grantId: string
  clientId: string
  userId: string
  multicaToken: string
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export type Fail = { ok: false; error: string; description: string }
const fail = (error: string, description: string): Fail => ({ ok: false, error, description })

export class OAuthStore {
  private readonly db: DatabaseSync
  private readonly now: Clock

  constructor(db: DatabaseSync, now: Clock) {
    this.db = db
    this.now = now
  }

  registerClient(body: { redirect_uris?: unknown; client_name?: unknown }): { ok: true; client: Client } | Fail {
    const uris = body.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(isAllowedRedirectUri)) {
      return fail('invalid_redirect_uri', 'redirect_uris: 1 bis 5 https-URLs (http nur localhost)')
    }
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null
    const clientId = `mcp_${randomBytes(16).toString('hex')}`
    this.db
      .prepare('INSERT INTO clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
      .run(clientId, name, JSON.stringify(uris), this.now())
    return { ok: true, client: { clientId, clientName: name, redirectUris: uris as string[] } }
  }

  getClient(clientId: unknown): Client | null {
    if (typeof clientId !== 'string' || !/^mcp_[0-9a-f]{32}$/.test(clientId)) return null
    const r = this.db.prepare('SELECT client_id, client_name, redirect_uris FROM clients WHERE client_id = ?').get(clientId) as
      | { client_id: string; client_name: string | null; redirect_uris: string }
      | undefined
    return r ? { clientId: r.client_id, clientName: r.client_name, redirectUris: JSON.parse(r.redirect_uris) } : null
  }

  /** After a successful Multica login: new grant plus a one-time code for the client. */
  createGrantAndCode(o: { clientId: string; userId: string; multicaToken: string; redirectUri: string; codeChallenge: string }): string {
    const grantId = randomUUID()
    const code = randomToken()
    const now = this.now()
    this.db
      .prepare('INSERT INTO grants (grant_id, client_id, user_id, multica_token, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(grantId, o.clientId, o.userId, o.multicaToken, now)
    this.db
      .prepare('INSERT INTO codes (code_hash, client_id, grant_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(code), o.clientId, grantId, o.redirectUri, o.codeChallenge, now + CODE_TTL_S)
    return code
  }

  private issueTokens(clientId: string, grantId: string): TokenResponse {
    const access = randomToken()
    const refresh = randomToken()
    const now = this.now()
    const ins = this.db.prepare('INSERT INTO tokens (token_hash, kind, client_id, grant_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    ins.run(sha256(access), 'access', clientId, grantId, now + ACCESS_TTL_S)
    ins.run(sha256(refresh), 'refresh', clientId, grantId, now + REFRESH_TTL_S)
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE }
  }

  private grantActive(grantId: string): boolean {
    const r = this.db.prepare('SELECT 1 FROM grants WHERE grant_id = ? AND revoked_at IS NULL AND multica_token IS NOT NULL').get(grantId)
    return Boolean(r)
  }

  /** authorization_code grant. The code is spent on the first attempt, even if a later check fails. */
  exchangeCode(o: { code: unknown; clientId: unknown; redirectUri: unknown; codeVerifier: unknown }): { ok: true; tokens: TokenResponse } | Fail {
    if (typeof o.code !== 'string' || typeof o.clientId !== 'string' || typeof o.codeVerifier !== 'string') {
      return fail('invalid_request', 'code, client_id und code_verifier sind Pflicht')
    }
    const c = this.db
      .prepare(
        'UPDATE codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING client_id, grant_id, redirect_uri, code_challenge',
      )
      .get(this.now(), sha256(o.code), this.now()) as
      | { client_id: string; grant_id: string; redirect_uri: string; code_challenge: string }
      | undefined
    if (!c) return fail('invalid_grant', 'Code unbekannt, abgelaufen oder schon benutzt')
    if (c.client_id !== o.clientId) return fail('invalid_grant', 'Code gehört zu einem anderen Client')
    if (typeof o.redirectUri === 'string' && o.redirectUri !== c.redirect_uri) return fail('invalid_grant', 'redirect_uri passt nicht')
    if (!pkceMatches(o.codeVerifier, c.code_challenge)) return fail('invalid_grant', 'code_verifier passt nicht')
    if (!this.grantActive(c.grant_id)) return fail('invalid_grant', 'Anmeldung wurde widerrufen')
    return { ok: true, tokens: this.issueTokens(c.client_id, c.grant_id) }
  }

  /** refresh_token grant, rotating: the presented refresh token is revoked. */
  refresh(o: { refreshToken: unknown; clientId: unknown }): { ok: true; tokens: TokenResponse } | Fail {
    if (typeof o.refreshToken !== 'string') return fail('invalid_request', 'refresh_token ist Pflicht')
    const r = this.db
      .prepare(
        "UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > ? RETURNING client_id, grant_id",
      )
      .get(this.now(), sha256(o.refreshToken), this.now()) as { client_id: string; grant_id: string } | undefined
    if (!r) return fail('invalid_grant', 'Refresh-Token unbekannt, abgelaufen oder widerrufen')
    if (typeof o.clientId === 'string' && o.clientId !== r.client_id) return fail('invalid_grant', 'Token gehört zu einem anderen Client')
    if (!this.grantActive(r.grant_id)) return fail('invalid_grant', 'Anmeldung wurde widerrufen')
    return { ok: true, tokens: this.issueTokens(r.client_id, r.grant_id) }
  }

  /** Bearer check for /mcp. `null` means 401. */
  verifyAccessToken(token: string | null | undefined): Grant | null {
    if (!token || token.length < 20 || token.length > 200) return null
    const now = this.now()
    const r = this.db
      .prepare(
        `UPDATE tokens SET last_used_at = ?
         WHERE token_hash = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at > ?
           AND grant_id IN (SELECT grant_id FROM grants WHERE revoked_at IS NULL AND multica_token IS NOT NULL)
         RETURNING grant_id`,
      )
      .get(now, sha256(token), now) as { grant_id: string } | undefined
    if (!r) return null
    const g = this.db.prepare('SELECT grant_id, client_id, user_id, multica_token FROM grants WHERE grant_id = ?').get(r.grant_id) as {
      grant_id: string
      client_id: string
      user_id: string
      multica_token: string
    }
    return { grantId: g.grant_id, clientId: g.client_id, userId: g.user_id, multicaToken: g.multica_token }
  }

  /**
   * RFC 7009. A refresh token ends its grant (all tokens, Multica session
   * dropped); an access token only itself. Unknown tokens are not an error.
   */
  revokeToken(token: unknown): void {
    if (typeof token !== 'string' || !token) return
    const r = this.db
      .prepare('UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL RETURNING kind, grant_id')
      .get(this.now(), sha256(token)) as { kind: string; grant_id: string } | undefined
    if (r?.kind === 'refresh') this.revokeGrant(r.grant_id)
  }

  /** Also used when Multica rejects the stored session: the client has to log in again. */
  revokeGrant(grantId: string): void {
    const now = this.now()
    this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(now, grantId)
    this.db.prepare('UPDATE grants SET revoked_at = ?, multica_token = NULL WHERE grant_id = ? AND revoked_at IS NULL').run(now, grantId)
  }
}

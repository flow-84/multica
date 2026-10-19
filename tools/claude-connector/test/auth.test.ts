// OAuth of the connector end to end over HTTP: discovery, registration, the
// Multica-code login (only fl0w), PKCE, one-time codes, rotating refresh
// tokens, revocation and expiry.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ACCESS_TTL_S, isAllowedRedirectUri, pkceMatches } from '../src/oauth.ts'
import {
  EMAIL,
  type Harness,
  OTHER_CODE,
  REDIRECT,
  authorizeParams,
  form,
  login,
  loginCode,
  mcpClient,
  pkce,
  register,
  startHarness,
  tokenRequest,
} from './harness.ts'

let h: Harness
before(async () => {
  h = await startHarness()
})
after(async () => {
  await h.close()
})

const mcpPost = (token?: string) =>
  fetch(`${h.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })

describe('ohne Token', () => {
  it('antwortet 401 mit resource_metadata im WWW-Authenticate', async () => {
    const res = await mcpPost()
    assert.equal(res.status, 401)
    assert.equal(
      res.headers.get('www-authenticate'),
      'Bearer resource_metadata="https://connector.test/.well-known/oauth-protected-resource/mcp"',
    )
  })

  it('meldet ein unbekanntes Token als invalid_token', async () => {
    const res = await mcpPost('x'.repeat(43))
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') ?? '', /error="invalid_token"/)
  })

  it('liefert die Discovery-Dokumente', async () => {
    const pr = (await (await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>
    assert.equal(pr.resource, 'https://connector.test/mcp')
    assert.deepEqual(pr.authorization_servers, ['https://connector.test'])
    const as = (await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>
    assert.equal(as.registration_endpoint, 'https://connector.test/mcp-oauth/register')
    assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
  })
})

describe('Registrierung und Login', () => {
  it('lehnt fremde Redirect-URIs ab', async () => {
    assert.equal((await register(h.base, ['http://evil.example/cb'])).status, 400)
    assert.equal((await register(h.base, ['https://claude.ai/cb#frag'])).status, 400)
    assert.equal((await register(h.base, [])).status, 400)
    assert.equal(isAllowedRedirectUri('http://localhost:6274/cb'), true)
  })

  it('zeigt bei unbekanntem Client eine Fehlerseite statt einer Weiterleitung', async () => {
    const { challenge } = pkce()
    const res = await fetch(`${h.base}/mcp-oauth/authorize?${new URLSearchParams(authorizeParams('mcp_' + '0'.repeat(32), challenge))}`, {
      redirect: 'manual',
    })
    assert.equal(res.status, 400)
    assert.equal(res.headers.get('location'), null)
  })

  it('weist eine nicht registrierte Redirect-URI ab', async () => {
    const reg = (await (await register(h.base)).json()) as { client_id: string }
    const { challenge } = pkce()
    const res = await fetch(
      `${h.base}/mcp-oauth/authorize?${new URLSearchParams({ ...authorizeParams(reg.client_id, challenge), redirect_uri: 'https://evil.example/cb' })}`,
      { redirect: 'manual' },
    )
    assert.equal(res.status, 400)
    assert.equal(res.headers.get('location'), null)
  })

  it('verlangt PKCE mit S256', async () => {
    const reg = (await (await register(h.base)).json()) as { client_id: string }
    const params = { ...authorizeParams(reg.client_id, 'abc'), code_challenge_method: 'plain' }
    const res = await fetch(`${h.base}/mcp-oauth/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.equal(new URL(res.headers.get('location') ?? '').searchParams.get('error'), 'invalid_request')
  })

  it('zeigt Ziel und maskierte Adresse und schickt den Code nur an die erlaubte Adresse', async () => {
    const reg = (await (await register(h.base)).json()) as { client_id: string }
    const { challenge } = pkce()
    const params = authorizeParams(reg.client_id, challenge)
    const pageRes = await fetch(`${h.base}/mcp-oauth/authorize?${new URLSearchParams(params)}`)
    // form-action would make Chrome block the redirect back to claude.ai after the login post.
    assert.doesNotMatch(pageRes.headers.get('content-security-policy') ?? '', /form-action/)
    const page = await pageRes.text()
    assert.match(page, /claude\.ai/)
    assert.match(page, /i\*\*\*@model2star\.com/)
    assert.doesNotMatch(page, /info@model2star\.com/)
    h.fake.sentCodes.length = 0
    // An injected address is ignored.
    const res = await form(h.base, '/mcp-oauth/authorize', { ...params, step: 'send', email: 'attacker@example.com' })
    assert.equal(res.status, 200)
    assert.deepEqual(h.fake.sentCodes, [EMAIL])
  })

  it('lehnt falschen Code und fremdes Konto ab', async () => {
    const reg = (await (await register(h.base)).json()) as { client_id: string }
    const { challenge } = pkce()
    const params = authorizeParams(reg.client_id, challenge)
    assert.equal((await form(h.base, '/mcp-oauth/authorize', { ...params, step: 'verify', code: '000000' })).status, 401)
    assert.equal((await form(h.base, '/mcp-oauth/authorize', { ...params, step: 'verify', code: OTHER_CODE })).status, 401)
    const rows = h.db.prepare("SELECT result FROM audit WHERE action = 'login'").all() as { result: string }[]
    assert.ok(rows.filter((r) => r.result === 'abgelehnt').length >= 2)
  })
})

describe('Token', () => {
  it('lehnt einen falschen PKCE-Verifier ab und verbraucht den Code dabei', async () => {
    const { clientId, verifier, authCode } = await loginCode(h.base)
    const wrong = await tokenRequest(h.base, {
      grant_type: 'authorization_code',
      code: authCode,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    })
    assert.equal(wrong.status, 400)
    assert.equal(((await wrong.json()) as { error: string }).error, 'invalid_grant')
    const retry = await tokenRequest(h.base, {
      grant_type: 'authorization_code',
      code: authCode,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    })
    assert.equal(retry.status, 400)
  })

  it('löst einen Code nur einmal ein', async () => {
    const { clientId, verifier, authCode } = await loginCode(h.base)
    const fields = { grant_type: 'authorization_code', code: authCode, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }
    assert.equal((await tokenRequest(h.base, fields)).status, 200)
    assert.equal((await tokenRequest(h.base, fields)).status, 400)
  })

  it('öffnet /mcp mit gültigem Token und speichert keine Klartext-Tokens', async () => {
    const t = await login(h.base)
    const client = await mcpClient(h.base, t.access)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((x) => x.name).sort(), [
      'add_comment',
      'create_issue',
      'get_issue',
      'list_issues',
      'list_projects',
      'system_status',
      'update_issue',
    ])
    await client.close()
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM tokens').all()) + JSON.stringify(h.db.prepare('SELECT * FROM codes').all())
    assert.equal(dump.includes(t.access), false)
    assert.equal(dump.includes(t.refresh), false)
  })

  it('rotiert den Refresh-Token', async () => {
    const t = await login(h.base)
    const r1 = await tokenRequest(h.base, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })
    assert.equal(r1.status, 200)
    const n = (await r1.json()) as { access_token: string; refresh_token: string }
    assert.notEqual(n.refresh_token, t.refresh)
    assert.equal((await tokenRequest(h.base, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })).status, 400)
    assert.equal((await mcpPost(n.access_token)).status, 200)
  })

  it('Widerruf des Refresh-Tokens sperrt auch den Access-Token sofort', async () => {
    const t = await login(h.base)
    assert.equal((await mcpPost(t.access)).status, 200)
    const rv = await form(h.base, '/mcp-oauth/revoke', { token: t.refresh, token_type_hint: 'refresh_token' })
    assert.equal(rv.status, 200)
    assert.equal((await mcpPost(t.access)).status, 401)
    assert.equal((await tokenRequest(h.base, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })).status, 400)
    const grant = h.db.prepare('SELECT multica_token FROM grants WHERE revoked_at IS NOT NULL').all() as { multica_token: string | null }[]
    assert.ok(grant.length >= 1 && grant.every((g) => g.multica_token === null))
  })

  it('Widerruf nur des Access-Tokens lässt den Refresh-Token gültig', async () => {
    const t = await login(h.base)
    await form(h.base, '/mcp-oauth/revoke', { token: t.access })
    assert.equal((await mcpPost(t.access)).status, 401)
    assert.equal((await tokenRequest(h.base, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })).status, 200)
  })

  it('Access-Token läuft nach einer Stunde ab', async () => {
    const t = await login(h.base)
    h.clock.t += ACCESS_TTL_S + 1
    try {
      assert.equal((await mcpPost(t.access)).status, 401)
    } finally {
      h.clock.t -= ACCESS_TTL_S + 1
    }
  })

  it('pkceMatches lehnt kurze Verifier ab', () => {
    assert.equal(pkceMatches('kurz', 'x'), false)
    const { verifier, challenge } = pkce()
    assert.equal(pkceMatches(verifier, challenge), true)
  })
})

describe('Bremse', () => {
  it('drosselt das Login-Formular nach zehn Versuchen pro Minute', async () => {
    const { RateLimiter } = await import('../src/http.ts')
    let t = 0
    const l = new RateLimiter(() => t)
    for (let i = 0; i < 10; i++) assert.equal(l.allow('a', 10), true)
    assert.equal(l.allow('a', 10), false)
    assert.equal(l.allow('b', 10), true)
    t = 60
    assert.equal(l.allow('a', 10), true)
  })
})

// The MCP tools against the fake Multica API, through the real MCP client:
// speakable German output, name resolution, the writes Multica receives and
// the audit log.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ago, speakable } from '../src/tools.ts'
import { BUILDER, FLOW, type Harness, P_MULTICA, callTool, login, mcpClient, startHarness } from './harness.ts'

let h: Harness
let client: Client
before(async () => {
  h = await startHarness()
  client = await mcpClient(h.base, (await login(h.base)).access)
})
after(async () => {
  await client.close()
  await h.close()
})

const auditRows = () =>
  h.db.prepare('SELECT action, target, result, detail FROM audit WHERE action LIKE ? ORDER BY id').all('tool:%') as {
    action: string
    target: string | null
    result: string
    detail: string
  }[]

describe('lesen', () => {
  it('listet offene Issues eines Projekts mit deutschem Status', async () => {
    const r = await callTool(client, 'list_issues', { project: 'multica' })
    assert.equal(r.isError, false)
    assert.match(r.text, /^2 Issues offen im Projekt Multica/)
    assert.match(r.text, /MS-1: MCP-Connector bauen\. In Arbeit, bei Claude/)
    assert.match(r.text, /MS-2: Daemon-Log aufräumen\. Backlog, bei Builder/)
    assert.doesNotMatch(r.text, /MS-3|MS-4/)
    assert.doesNotMatch(r.text, /[0-9a-f]{8}-[0-9a-f]{4}/)
  })

  it('filtert nach Status, Zuständigem und Zeitraum', async () => {
    assert.match((await callTool(client, 'list_issues', { status: ['done'] })).text, /^1 Issue mit Status Erledigt/)
    const byBuilder = await callTool(client, 'list_issues', { assignee: 'builder' })
    assert.match(byBuilder.text, /bei Builder/)
    assert.doesNotMatch(byBuilder.text, /MS-1:/)
    const recent = await callTool(client, 'list_issues', { project: 'Multica', days: 7 })
    assert.match(recent.text, /MS-1:/)
    assert.doesNotMatch(recent.text, /MS-2:/)
  })

  it('sucht nach Titel, auch in erledigten', async () => {
    const r = await callTool(client, 'list_issues', { query: 'bug' })
    assert.match(r.text, /^1 Issue zu „bug“/)
    assert.match(r.text, /MS-3: Alter Bug\. Erledigt/)
  })

  it('fragt bei mehrdeutigem Projekt nach und ändert nichts', async () => {
    const amb = await callTool(client, 'create_issue', { project: 'ica', title: 'Test' })
    assert.equal(amb.isError, true)
    assert.match(amb.text, /mehrere Projekte: Multica, map\.multica/)
    assert.equal(h.fake.writes.length, 0)
  })

  it('liest ein Issue mit Beschreibung und letzten Kommentaren', async () => {
    const r = await callTool(client, 'get_issue', { issue: 'ms 1' })
    assert.match(r.text, /^MS-1: MCP-Connector bauen\. Status In Arbeit, Priorität ohne, zuständig Claude, Projekt Multica\./)
    assert.match(r.text, /Beschreibung: Ziel fl0w will Multica per Sprache steuern\. Siehe MS-2397\./)
    assert.match(r.text, /Letzte 2 Kommentare: fl0w, vor 5 Stunden: Bitte mit OAuth\. Claude, vor einer Stunde: Ich baue das jetzt\./)
  })

  it('meldet ein unbekanntes Issue als Satz', async () => {
    const r = await callTool(client, 'get_issue', { issue: 'MS-999' })
    assert.equal(r.isError, true)
    assert.equal(r.text, 'Das Issue MS-999 finde ich nicht.')
  })

  it('meldet einen Datenbankausfall nicht als fehlendes Issue', async () => {
    h.fake.dbDown = true
    try {
      const r = await callTool(client, 'get_issue', { issue: 'MS-1' })
      assert.equal(r.isError, true)
      assert.equal(r.text, 'Multica antwortet gerade nicht richtig.')
    } finally {
      h.fake.dbDown = false
    }
  })

  it('nennt Stand von Daemon und Agenten', async () => {
    const r = await callTool(client, 'system_status')
    assert.equal(r.text, 'Der Daemon läuft, alle 2 Laufzeiten sind online. 1 von 2 Agenten arbeiten gerade: Claude. 1 Issue ist in Arbeit.')
  })

  it('listet Projekte, aktive zuerst', async () => {
    const r = await callTool(client, 'list_projects')
    assert.equal(r.text, '3 Projekte. Aktiv sind: CRM (m2s), map.multica. Weitere: Multica.')
  })

  it('schreibt beim Lesen nichts ins Audit-Log', () => {
    assert.equal(auditRows().filter((r) => r.result === 'ok').length, 0)
  })
})

describe('schreiben', () => {
  it('legt ein Issue an und protokolliert es', async () => {
    const r = await callTool(client, 'create_issue', {
      project: 'Multica',
      title: 'Test aus Claude',
      description: 'Bitte prüfen.',
      assignee: 'Builder',
    })
    assert.equal(r.isError, false)
    assert.equal(r.text, 'Angelegt: MS-100, „Test aus Claude“, im Projekt Multica. Status Backlog, zuständig Builder.')
    const w = h.fake.writes.at(-1)
    assert.deepEqual(w, {
      method: 'POST',
      path: '/api/issues',
      body: {
        title: 'Test aus Claude',
        project_id: P_MULTICA,
        status: 'backlog',
        priority: 'none',
        description: 'Bitte prüfen.',
        assignee_type: 'agent',
        assignee_id: BUILDER,
      },
    })
    const a = auditRows().at(-1)
    assert.equal(a?.action, 'tool:create_issue')
    assert.equal(a?.target, 'MS-100')
    assert.equal(a?.result, 'ok')
    assert.equal(JSON.parse(a?.detail ?? '{}').args.title, 'Test aus Claude')
  })

  it('kündigt den Agentenlauf an, wenn todo mit Agent', async () => {
    const r = await callTool(client, 'create_issue', { project: 'Multica', title: 'Sofort los', assignee: 'Builder', status: 'todo' })
    assert.match(r.text, /Builder fängt gleich an\.$/)
  })

  it('ändert Status und Zuständigen', async () => {
    const r = await callTool(client, 'update_issue', { issue: 'MS-100', status: 'cancelled', assignee: 'ich' })
    assert.equal(r.text, 'MS-100 steht auf Abgebrochen und liegt bei fl0w.')
    assert.deepEqual(h.fake.writes.at(-1)?.body, { status: 'cancelled', assignee_type: 'member', assignee_id: FLOW })
    const un = await callTool(client, 'update_issue', { issue: 'MS-100', assignee: 'niemand' })
    assert.equal(un.text, 'MS-100 hat keinen Zuständigen mehr.')
    assert.equal(auditRows().at(-1)?.action, 'tool:update_issue')
  })

  it('verlangt etwas zum Ändern', async () => {
    const r = await callTool(client, 'update_issue', { issue: 'MS-100' })
    assert.equal(r.isError, true)
    assert.equal(auditRows().at(-1)?.result, 'abgelehnt')
  })

  it('schreibt einen Kommentar', async () => {
    const r = await callTool(client, 'add_comment', { issue: 'MS-1', text: 'Sieht gut aus.' })
    assert.equal(r.text, 'Kommentar an MS-1 geschrieben.')
    assert.deepEqual(h.fake.writes.at(-1), { method: 'POST', path: '/api/issues/00000001-0000-0000-0000-000000000000/comments', body: { content: 'Sieht gut aus.' } })
  })

  it('unbekannter Zuständiger wird als Satz gemeldet, nichts angelegt', async () => {
    const before = h.fake.writes.length
    const r = await callTool(client, 'create_issue', { project: 'Multica', title: 'Neuer Test', assignee: 'Fuzz-Tester' })
    assert.equal(r.isError, true)
    assert.match(r.text, /niemanden namens „Fuzz-Tester“/)
    assert.equal(h.fake.writes.length, before)
  })
})

describe('abgelaufene Multica-Sitzung', () => {
  it('widerruft die Anmeldung, der nächste Aufruf bekommt 401', async () => {
    const t = await login(h.base)
    const c = await mcpClient(h.base, t.access)
    h.fake.expired = true
    try {
      const r = await callTool(c, 'list_projects')
      assert.equal(r.isError, true)
      assert.match(r.text, /neu verbinden/)
    } finally {
      h.fake.expired = false
      await c.close()
    }
    const res = await fetch(`${h.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert.equal(res.status, 401)
  })
})

describe('Sprachhelfer', () => {
  it('ago', () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    assert.equal(ago('2026-10-19T11:59:30Z', now), 'gerade eben')
    assert.equal(ago('2026-10-19T11:30:00Z', now), 'vor 30 Minuten')
    assert.equal(ago('2026-10-18T12:00:00Z', now), 'gestern')
    assert.equal(ago('2026-10-14T12:00:00Z', now), 'vor 5 Tagen')
  })

  it('speakable entfernt Markdown und kürzt am Satzende', () => {
    assert.equal(speakable('## Titel\n\n- **eins**\n- `zwei`\n\n```js\nx()\n```', 200), 'Titel eins zwei (Codeblock)')
    assert.equal(speakable('Erster Satz ist da. Zweiter Satz ist viel zu lang für die Grenze.', 30), 'Erster Satz ist da.')
  })
})

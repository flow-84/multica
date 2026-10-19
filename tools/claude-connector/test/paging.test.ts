// More matches than one API page: the spoken count comes from `total`, the
// page is the most recently changed one, and capped pages say "mindestens".
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type Harness, HOUR, callTool, fakeIssue, iso, login, mcpClient, startHarness } from './harness.ts'

let h: Harness
let client: Client
before(async () => {
  h = await startHarness()
  // 150 bulk issues in progress, created a month ago, last changed 20 days ago.
  for (let n = 1000; n < 1150; n++) {
    h.fake.issues.push(fakeIssue(n, { title: `Bulk ${n}`, status: 'in_progress', created_at: iso(30 * 24 * HOUR), updated_at: iso(20 * 24 * HOUR) }))
  }
  // Created long ago, changed an hour ago: newest by updated_at, oldest by created_at.
  h.fake.issues.push(fakeIssue(5, { title: 'Uralt, gerade bearbeitet', status: 'backlog', created_at: iso(300 * 24 * HOUR), updated_at: iso(HOUR) }))
  client = await mcpClient(h.base, (await login(h.base)).access)
})
after(async () => {
  await client.close()
  await h.close()
})

describe('mehr als eine Seite', () => {
  it('nennt die Gesamtzahl und zuerst das zuletzt geänderte Issue', async () => {
    const open = h.fake.issues.filter((i) => !['done', 'cancelled'].includes(i.status)).length
    assert.ok(open > 100)
    const r = await callTool(client, 'list_issues', { limit: 1 })
    assert.equal(r.text, `${open} Issues offen, zuletzt geänderte zuerst. MS-5: Uralt, gerade bearbeitet. Backlog, ohne Zuständigen, geändert vor einer Stunde. Das waren die 1 zuletzt geänderten.`)
  })

  it('zählt im Zeitraum exakt, wenn die Seite nicht voll ist', async () => {
    const r = await callTool(client, 'list_issues', { days: 7 })
    assert.match(r.text, /^3 Issues offen aus den letzten 7 Tagen/)
    assert.match(r.text, /MS-5: Uralt/)
  })

  it('sagt mindestens, wenn die volle Seite ganz im Zeitraum liegt', async () => {
    const r = await callTool(client, 'list_issues', { days: 30 })
    assert.match(r.text, /^Mindestens 100 Issues offen aus den letzten 30 Tagen/)
  })

  it('sagt mindestens, wenn die Suche ihre Obergrenze erreicht', async () => {
    const r = await callTool(client, 'list_issues', { query: 'bulk' })
    assert.match(r.text, /^Mindestens 50 Issues zu „bulk“/)
  })

  it('system_status zählt alle Issues in Arbeit', async () => {
    const r = await callTool(client, 'system_status')
    assert.match(r.text, /151 Issues sind in Arbeit\.$/)
  })
})

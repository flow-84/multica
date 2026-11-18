// Moving cards into another project through update_issue and bulk_update_issues (MS-3175).
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type Harness, P_CRM, P_MULTICA, callTool, fakeIssue, login, mcpClient, startHarness } from './harness.ts'

let h: Harness
let client: Client
before(async () => {
  h = await startHarness()
  client = await mcpClient(h.base, (await login(h.base)).access)
  h.fake.projects.push({ id: 'p-drifter', title: 'Drifter 999', status: 'in_progress' }, { id: 'p-hermes', title: 'Hermes M2S', status: 'in_progress' })
  h.fake.issues.push(
    fakeIssue(600, { title: 'Falsch einsortiert', project_id: 'p-hermes', status: 'todo' }),
    fakeIssue(601, { title: 'Phase mit Unterkarten', project_id: P_MULTICA }),
  )
  const phase = h.fake.issues.find((i) => i.identifier === 'MS-601')?.id
  h.fake.issues.push(
    fakeIssue(602, { parent_issue_id: phase, project_id: P_MULTICA }),
    fakeIssue(603, { parent_issue_id: phase, project_id: P_CRM }),
    fakeIssue(604, { project_id: P_MULTICA }),
    fakeIssue(605, { project_id: P_MULTICA }),
  )
})
after(async () => {
  await client.close()
  await h.close()
})

const card = (n: number) => h.fake.issues.find((i) => i.identifier === `MS-${n}`)
let writesBefore = 0
beforeEach(() => {
  writesBefore = h.fake.writes.length
})
const newWrites = () => h.fake.writes.slice(writesBefore)

describe('update_issue: Karte in ein anderes Projekt verschieben', () => {
  it('verschiebt die Karte und lässt alles andere, wie es ist', async () => {
    const r = await callTool(client, 'update_issue', { issue: 'MS-600', project: 'drifter 999' })
    assert.equal(r.isError, false)
    assert.equal(r.text, 'MS-600 liegt jetzt im Projekt Drifter 999.')
    assert.deepEqual(newWrites(), [{ method: 'PUT', path: `/api/issues/${card(600)?.id}`, body: { project_id: 'p-drifter' } }])
    assert.equal(card(600)?.project_id, 'p-drifter')
    assert.equal(card(600)?.status, 'todo')
  })

  it('meldet keine Änderung, wenn die Karte schon im Projekt liegt', async () => {
    const r = await callTool(client, 'update_issue', { issue: 'MS-600', project: 'Drifter 999' })
    assert.equal(r.text, 'MS-600 ist schon so, es hat sich nichts geändert.')
    assert.equal(newWrites().length, 0)
  })

  it('nennt die Unterkarten, die im bisherigen Projekt bleiben', async () => {
    const r = await callTool(client, 'update_issue', { issue: 'MS-601', project: 'CRM (m2s)', status: 'in_progress' })
    assert.equal(r.text, 'MS-601 steht auf In Arbeit und liegt jetzt im Projekt CRM (m2s). Die Unterkarte MS-602 liegt weiter im bisherigen Projekt.')
    assert.equal(card(601)?.project_id, P_CRM)
    assert.equal(card(602)?.project_id, P_MULTICA)
  })

  it('ein unbekanntes Projekt ändert gar nichts, auch nicht den Titel', async () => {
    const r = await callTool(client, 'update_issue', { issue: 'MS-604', title: 'Neuer Titel', project: 'Gibtsnicht' })
    assert.equal(r.isError, true)
    assert.match(r.text, /Ein Projekt „Gibtsnicht“ gibt es nicht/)
    assert.equal(card(604)?.project_id, P_MULTICA)
    assert.equal(newWrites().length, 0)
  })

  it('fragt bei einem mehrdeutigen Projektnamen nach', async () => {
    const r = await callTool(client, 'update_issue', { issue: 'MS-604', project: 'multica' })
    // "Multica" matches exactly, "map.multica" only partly: the exact title wins.
    assert.equal(r.text, 'MS-604 ist schon so, es hat sich nichts geändert.')
    const both = await callTool(client, 'update_issue', { issue: 'MS-604', project: 'M2S' })
    assert.equal(both.isError, true)
    assert.match(both.text, /passt auf mehrere Projekte/)
    assert.equal(newWrites().length, 0)
  })
})

describe('bulk_update_issues: mehrere Karten verschieben', () => {
  it('verschiebt eine Liste von Kennungen in ein Projekt', async () => {
    const r = await callTool(client, 'bulk_update_issues', { issues: ['MS-604', 'MS-605'], project: 'Drifter 999' })
    assert.equal(r.text, '2 Karten stehen jetzt im Projekt Drifter 999: MS-604, MS-605.')
    assert.deepEqual(newWrites(), [
      { method: 'POST', path: '/api/issues/batch-update', body: { issue_ids: [card(604)?.id, card(605)?.id], updates: { project_id: 'p-drifter' } } },
    ])
    assert.equal(card(605)?.project_id, 'p-drifter')
  })

  it('verschiebt alle offenen Unterkarten einer Oberkarte und setzt zugleich den Status', async () => {
    const r = await callTool(client, 'bulk_update_issues', { parent: 'MS-601', project: 'CRM (m2s)', status: 'backlog' })
    assert.equal(r.text, '2 Karten stehen jetzt auf Backlog und im Projekt CRM (m2s): MS-602, MS-603.')
    assert.equal(card(602)?.project_id, P_CRM)
  })

  it('ein unbekanntes Projekt ändert keine Karte', async () => {
    const r = await callTool(client, 'bulk_update_issues', { issues: ['MS-604'], project: 'Gibtsnicht', status: 'done' })
    assert.equal(r.isError, true)
    assert.match(r.text, /Ein Projekt „Gibtsnicht“ gibt es nicht/)
    assert.equal(newWrites().length, 0)
  })
})

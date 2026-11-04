// Correcting cards and comments: title, description (whole or one passage),
// priority, labels, parent and stage through update_issue, comments through
// edit_comment (MS-3170).
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { FLOW, type Harness, callTool, fakeIssue, login, mcpClient, startHarness } from './harness.ts'

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

const card = (n: number) => h.fake.issues.find((i) => i.identifier === `MS-${n}`)
let writesBefore = 0
beforeEach(() => {
  writesBefore = h.fake.writes.length
})
const newWrites = () => h.fake.writes.slice(writesBefore)

describe('update_issue: Karte korrigieren', () => {
  it('korrigiert Titel und ersetzt die ganze Beschreibung, sonst bleibt alles', async () => {
    h.fake.issues.push(fakeIssue(500, { title: 'Model to Sar Landingpage', description: 'Alt.', status: 'backlog', priority: 'low' }))
    const r = await callTool(client, 'update_issue', { issue: 'ms 500', title: 'Model to Star Landingpage', description: 'Neu und richtig.' })
    assert.equal(r.isError, false)
    assert.equal(r.text, 'MS-500 heißt jetzt „Model to Star Landingpage“ und hat eine neue Beschreibung.')
    const put = newWrites().find((w) => w.method === 'PUT')?.body as Record<string, unknown>
    assert.deepEqual(put, { title: 'Model to Star Landingpage', title_base: 'Model to Sar Landingpage', description: 'Neu und richtig.', description_base: 'Alt.' })
    assert.equal(card(500)?.status, 'backlog')
    assert.equal(card(500)?.priority, 'low')
  })

  it('ersetzt genau eine Stelle der Beschreibung', async () => {
    h.fake.issues.push(fakeIssue(501, { description: 'Kunde ist Multivers Media. Frist Freitag.' }))
    const r = await callTool(client, 'update_issue', { issue: 'MS-501', old_text: 'Multivers Media', new_text: 'Multiversemedia' })
    assert.equal(r.isError, false)
    assert.equal(r.text, 'MS-501 in der Beschreibung steht „Multiversemedia“ statt „Multivers Media“.')
    assert.equal(card(501)?.description, 'Kunde ist Multiversemedia. Frist Freitag.')
  })

  it('fragt nach, wenn die Stelle fehlt oder mehrfach vorkommt, und ändert nichts', async () => {
    h.fake.issues.push(fakeIssue(502, { description: 'ab ab' }))
    const none = await callTool(client, 'update_issue', { issue: 'MS-502', old_text: 'xy', new_text: 'z' })
    assert.equal(none.isError, true)
    assert.match(none.text, /steht nicht in der Beschreibung von MS-502/)
    const twice = await callTool(client, 'update_issue', { issue: 'MS-502', old_text: 'ab', new_text: 'z' })
    assert.match(twice.text, /kommt 2-mal/)
    const both = await callTool(client, 'update_issue', { issue: 'MS-502', description: 'x', old_text: 'ab', new_text: 'z' })
    assert.match(both.text, /nicht beides/)
    assert.equal(newWrites().length, 0)
  })

  it('setzt Priorität, Oberkarte und Stufe und nimmt sie wieder weg', async () => {
    h.fake.issues.push(fakeIssue(503, {}))
    const r = await callTool(client, 'update_issue', { issue: 'MS-503', priority: 'urgent', parent: 'MS-1', stage: 2 })
    assert.equal(r.text, 'MS-503 hat Priorität dringend, ist Unterkarte von MS-1 und liegt in Stufe 2.')
    assert.equal(card(503)?.parent_issue_id, card(1)?.id)
    assert.equal(card(503)?.stage, 2)
    const off = await callTool(client, 'update_issue', { issue: 'MS-503', parent: 'keine' })
    assert.equal(off.text, 'MS-503 ist keine Unterkarte mehr.')
    assert.equal(card(503)?.parent_issue_id, null)
    assert.equal(card(503)?.stage, null)
  })

  it('lehnt eine Stufe ohne Oberkarte und die Karte als eigene Oberkarte ab', async () => {
    h.fake.issues.push(fakeIssue(504, {}))
    assert.match((await callTool(client, 'update_issue', { issue: 'MS-504', stage: 1 })).text, /hat keine Oberkarte/)
    assert.match((await callTool(client, 'update_issue', { issue: 'MS-504', parent: 'MS-504' })).text, /eigene Oberkarte/)
    assert.equal(newWrites().length, 0)
  })

  it('setzt Labels, fügt hinzu und entfernt', async () => {
    h.fake.issues.push(fakeIssue(505, {}))
    const id = card(505)?.id ?? ''
    const set = await callTool(client, 'update_issue', { issue: 'MS-505', labels: ['Model to Star', 'Abrechnung'] })
    assert.equal(set.text, 'MS-505 hat die Labels bereich/Model to Star, Abrechnung.')
    assert.deepEqual(h.fake.issueLabels.get(id), ['l-m2s', 'l-bill'])
    const swap = await callTool(client, 'update_issue', { issue: 'MS-505', add_labels: ['Multiversemedia'], remove_labels: ['Model to Star'] })
    assert.equal(swap.text, 'MS-505 hat die Labels Abrechnung, bereich/Multiversemedia.')
    assert.deepEqual(h.fake.issueLabels.get(id), ['l-bill', 'l-mvm'])
    const clear = await callTool(client, 'update_issue', { issue: 'MS-505', labels: [] })
    assert.equal(clear.text, 'MS-505 hat keine Labels mehr.')
    assert.deepEqual(h.fake.issueLabels.get(id), [])
    // Labels alone never touch the issue row.
    assert.equal(newWrites().filter((w) => w.method === 'PUT').length, 0)
  })

  it('ein unbekanntes Label ändert gar nichts, auch nicht den Titel', async () => {
    h.fake.issues.push(fakeIssue(506, { title: 'Alt' }))
    const r = await callTool(client, 'update_issue', { issue: 'MS-506', title: 'Neuer Titel', labels: ['Gibtsnicht'] })
    assert.equal(r.isError, true)
    assert.match(r.text, /Ein Label „Gibtsnicht“ gibt es nicht/)
    assert.equal(card(506)?.title, 'Alt')
    assert.equal(newWrites().length, 0)
  })

  it('Status und Zuständiger gehen weiterhin', async () => {
    h.fake.issues.push(fakeIssue(507, {}))
    const r = await callTool(client, 'update_issue', { issue: 'MS-507', status: 'blocked', assignee: 'ich' })
    assert.equal(r.text, 'MS-507 steht auf Blockiert und liegt bei fl0w.')
  })
})

describe('edit_comment: Kommentar korrigieren', () => {
  it('ersetzt eine Stelle im jüngsten Kommentar, der sie enthält', async () => {
    const r = await callTool(client, 'edit_comment', { issue: 'MS-1', old_text: 'baue', new_text: 'teste' })
    assert.equal(r.isError, false)
    assert.match(r.text, /^Im Kommentar an MS-1 von vor einer Stunde steht jetzt „teste“ statt „baue“\.$/)
    assert.equal(h.fake.comments[1].content, 'Ich teste das jetzt.')
    const put = newWrites()[0]
    assert.equal(put.path, '/api/comments/c2bbbbbb-0000-0000-0000-000000000002')
    assert.deepEqual(put.body, { content: 'Ich teste das jetzt.', content_base: 'Ich baue das jetzt.' })
  })

  it('fasst ohne Kennung den jüngsten eigenen Kommentar neu', async () => {
    const r = await callTool(client, 'edit_comment', { issue: 'MS-1', text: 'Bitte mit OAuth und PKCE.' })
    assert.equal(r.text, 'Kommentar an MS-1 von vor 5 Stunden neu gefasst.')
    assert.equal(h.fake.comments.find((c) => c.author_id === FLOW)?.content, 'Bitte mit OAuth und PKCE.')
  })

  it('findet einen Kommentar über die ersten acht Zeichen seiner Kennung', async () => {
    const r = await callTool(client, 'edit_comment', { issue: 'MS-1', comment: 'C2BBBBBB', text: 'Fertig.' })
    assert.equal(r.isError, false)
    assert.equal(h.fake.comments[1].content, 'Fertig.')
  })

  it('fragt nach bei fehlender Stelle, fremder Kennung oder ohne neuen Text', async () => {
    assert.match((await callTool(client, 'edit_comment', { issue: 'MS-1', old_text: 'gibtsnicht', new_text: 'x' })).text, /steht in keinem Kommentar/)
    assert.match((await callTool(client, 'edit_comment', { issue: 'MS-1', comment: 'ffffffff', text: 'x' })).text, /keinen Kommentar mit dieser Kennung/)
    assert.match((await callTool(client, 'edit_comment', { issue: 'MS-1' })).text, /ganze Kommentar neu lauten/)
    assert.match((await callTool(client, 'edit_comment', { issue: 'MS-2', text: 'x' })).text, /keinen Kommentar von dir/)
    assert.equal(newWrites().length, 0)
  })

  it('meldet eine gleichzeitige Änderung an Kommentar oder Karte, statt sie zu überschreiben', async () => {
    h.fake.editConflict = true
    try {
      const c = await callTool(client, 'edit_comment', { issue: 'MS-1', comment: 'c1aaaaaa', text: 'Neu.' })
      assert.equal(c.isError, true)
      assert.match(c.text, /gerade woanders geändert/)
      const i = await callTool(client, 'update_issue', { issue: 'MS-2', title: 'Anderer Titel' })
      assert.equal(i.isError, true)
      assert.match(i.text, /MS-2 wurde gerade woanders geändert/)
    } finally {
      h.fake.editConflict = false
    }
  })
})

describe('Werkzeugliste', () => {
  it('beschreibt update_issue mit allen Feldern und bietet edit_comment an', async () => {
    const { tools } = await client.listTools()
    const upd = tools.find((t) => t.name === 'update_issue')
    for (const f of ['title', 'description', 'old_text', 'new_text', 'priority', 'labels', 'add_labels', 'remove_labels', 'parent', 'stage']) {
      assert.ok(upd?.inputSchema.properties?.[f], f)
    }
    assert.match(upd?.description ?? '', /Tippfehler/)
    assert.ok(tools.some((t) => t.name === 'edit_comment'))
  })
})

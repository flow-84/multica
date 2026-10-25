// Planning tools against the fake Multica API: projects, sub-issues, dependencies,
// labels, bulk changes and cancelling duplicates.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { BUILDER, FLOW, type Harness, P_MULTICA, callTool, fakeIssue, login, mcpClient, startHarness } from './harness.ts'

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

const lastWrite = () => h.fake.writes.at(-1)
const writesTo = (re: RegExp) => h.fake.writes.filter((w) => re.test(w.path))
const issue = (identifier: string) => {
  const i = h.fake.issues.find((x) => x.identifier === identifier)
  assert.ok(i, identifier)
  return i
}

describe('Projekte', () => {
  it('legt ein Projekt an, Standard aktiv', async () => {
    const r = await callTool(client, 'create_project', { name: 'Planungstest', description: 'Nur zum Testen.' })
    assert.equal(r.isError, false)
    assert.equal(r.text, 'Projekt Planungstest angelegt, Status aktiv. Es hat noch keine Karten.')
    assert.deepEqual(lastWrite(), { method: 'POST', path: '/api/projects', body: { title: 'Planungstest', status: 'in_progress', description: 'Nur zum Testen.' } })
  })

  it('legt kein zweites Projekt mit gleichem Namen an', async () => {
    const before = h.fake.writes.length
    const r = await callTool(client, 'create_project', { name: 'planungstest' })
    assert.equal(r.isError, true)
    assert.match(r.text, /gibt es schon/)
    assert.equal(h.fake.writes.length, before)
  })

  it('fragt bei unbekanntem Projekt, ob es angelegt werden soll', async () => {
    const r = await callTool(client, 'create_issue', { project: 'Gibtsnicht', title: 'Karte' })
    assert.equal(r.isError, true)
    assert.equal(r.text, 'Ein Projekt „Gibtsnicht“ gibt es nicht. Soll ich es anlegen?')
  })

  it('liest ein leeres Projekt', async () => {
    const r = await callTool(client, 'get_project', { project: 'Planungstest' })
    assert.equal(r.text, 'Projekt Planungstest, Status aktiv. Beschreibung: Nur zum Testen. Noch keine Karten.')
  })

  it('zählt Karten je Status und nennt die zuletzt geänderte', async () => {
    const r = await callTool(client, 'get_project', { project: 'Multica' })
    assert.match(r.text, /^Projekt Multica, Status geplant\. Keine Beschreibung\. 3 Karten: 1 Backlog, 1 In Arbeit, 1 Erledigt\./)
    assert.match(r.text, /Zuletzt geändert vor einer Stunde: MS-3, Alter Bug\.$/)
  })

  it('benennt um, ändert die Beschreibung und archiviert', async () => {
    const r = await callTool(client, 'update_project', { project: 'Planungstest', name: 'Planungstest 2', description: 'Neu.' })
    assert.equal(r.text, 'Das Projekt Planungstest heißt jetzt Planungstest 2 und hat eine neue Beschreibung.')
    const id = h.fake.projects.find((p) => p.title === 'Planungstest 2')?.id
    assert.deepEqual(lastWrite(), { method: 'PUT', path: `/api/projects/${id}`, body: { title: 'Planungstest 2', description: 'Neu.' } })
    const ar = await callTool(client, 'update_project', { project: 'Planungstest 2', archive: true })
    assert.equal(ar.text, 'Das Projekt Planungstest 2 ist archiviert, die Karten bleiben erhalten.')
    assert.deepEqual(lastWrite()?.body, { status: 'cancelled' })
  })

  it('verlangt eine Änderung und lehnt einen vergebenen Namen ab', async () => {
    assert.equal((await callTool(client, 'update_project', { project: 'Multica' })).isError, true)
    const clash = await callTool(client, 'update_project', { project: 'Multica', name: 'crm (m2s)' })
    assert.equal(clash.isError, true)
    assert.match(clash.text, /CRM \(m2s\) gibt es schon/)
  })
})

describe('Unterkarten, Abhängigkeiten und Labels', () => {
  it('legt eine Unterkarte im Projekt der Oberkarte an, mit Stufe und Labels', async () => {
    const r = await callTool(client, 'create_issue', {
      parent: 'MS-1',
      stage: 2,
      title: 'Phase zwei',
      labels: ['bereich/model to star'],
    })
    assert.equal(r.isError, false)
    assert.match(r.text, /^Angelegt: MS-\d+, „Phase zwei“, im Projekt Multica, als Unterkarte von MS-1 in Stufe 2\. Status Backlog, ohne Zuständigen, Labels bereich\/Model to Star\.$/)
    assert.deepEqual(lastWrite()?.body, {
      title: 'Phase zwei',
      project_id: P_MULTICA,
      status: 'backlog',
      priority: 'none',
      parent_issue_id: issue('MS-1').id,
      stage: 2,
      label_ids: ['l-m2s'],
    })
  })

  it('nennt Ober- und Unterkarten beim Lesen', async () => {
    const parent = await callTool(client, 'get_issue', { issue: 'MS-1' })
    assert.match(parent.text, /Eine Unterkarte, davon 0 abgeschlossen: MS-\d+\./)
    const child = h.fake.issues.find((i) => i.title === 'Phase zwei')
    const r = await callTool(client, 'get_issue', { issue: child?.identifier ?? '' })
    assert.match(r.text, /Unterkarte von MS-1, Stufe 2\./)
  })

  it('listet die Unterkarten einer Oberkarte, auch erledigte', async () => {
    h.fake.issues.push(fakeIssue(50, { title: 'Erledigte Unterkarte', status: 'done', parent_issue_id: issue('MS-1').id }))
    const r = await callTool(client, 'list_issues', { parent: 'ms 1' })
    assert.match(r.text, /^2 Issues unter MS-1, zuletzt geänderte zuerst\./)
    assert.match(r.text, /MS-50: Erledigte Unterkarte\. Erledigt/)
    const open = await callTool(client, 'list_issues', { parent: 'MS-1', status: ['backlog'] })
    assert.match(open.text, /^1 Issue mit Status Backlog unter MS-1/)
  })

  it('lehnt ein unbekanntes Label ab und legt nichts an', async () => {
    const before = h.fake.writes.length
    const r = await callTool(client, 'create_issue', { project: 'Multica', title: 'Mit Label', labels: ['Marketing'] })
    assert.equal(r.isError, true)
    assert.match(r.text, /^Ein Label „Marketing“ gibt es nicht\. Vorhanden sind zum Beispiel bereich\/Model to Star/)
    assert.equal(h.fake.writes.length, before)
  })

  it('lehnt eine unbekannte Oberkarte und eine Stufe ohne Oberkarte ab', async () => {
    const before = h.fake.writes.length
    assert.equal((await callTool(client, 'create_issue', { parent: 'MS-999', title: 'Waise' })).text, 'Das Issue MS-999 finde ich nicht.')
    assert.match((await callTool(client, 'create_issue', { project: 'Multica', title: 'Stufe', stage: 1 })).text, /nur zusammen mit einer Oberkarte/)
    assert.match((await callTool(client, 'create_issue', { title: 'Ohne alles' })).text, /In welchem Projekt/)
    assert.equal(h.fake.writes.length, before)
  })

  it('wartet auf eine offene Karte: Zeile in der Beschreibung und Wecker für den Agenten', async () => {
    const r = await callTool(client, 'create_issue', { project: 'Multica', title: 'Danach', assignee: 'Builder', blocked_by: ['MS-2'] })
    assert.equal(r.isError, false)
    const waiter = h.fake.issues.find((i) => i.title === 'Danach')
    assert.ok(waiter)
    assert.match(r.text, /Wartet auf MS-2\.$/)
    assert.equal(waiter.description, `Wartet auf: [MS-2](mention://issue/${issue('MS-2').id})`)
    const wake = writesTo(/\/wakeups$/).at(-1)
    assert.deepEqual(wake, {
      method: 'POST',
      path: `/api/issues/${waiter.id}/wakeups`,
      body: {
        agent_id: BUILDER,
        kind: 'event',
        mode: 'once',
        instruction: `MS-2 ist erledigt. ${waiter.identifier} hat darauf gewartet und kann jetzt bearbeitet werden.`,
        condition: { type: 'other_issue', issue_id: issue('MS-2').id, state: 'done' },
      },
    })
  })

  it('trägt zwei Vorgänger nacheinander ein, ohne den ersten zu überschreiben', async () => {
    h.fake.issues.push(fakeIssue(60, { title: 'Vorgänger A', status: 'todo' }), fakeIssue(61, { title: 'Vorgänger B', status: 'in_review' }))
    const r = await callTool(client, 'create_issue', { project: 'Multica', title: 'Zwei Vorgänger', description: 'Text.', blocked_by: ['MS-60', 'MS-61'], assignee: 'ich' })
    const waiter = h.fake.issues.find((i) => i.title === 'Zwei Vorgänger')
    assert.equal(waiter?.description, `Text.\n\nWartet auf: [MS-60](mention://issue/${issue('MS-60').id})\n\nWartet auf: [MS-61](mention://issue/${issue('MS-61').id})`)
    assert.match(r.text, /Wartet auf MS-60, MS-61\. MS-\d+ hat keinen Agenten, dort startet nach dem Warten nichts von selbst\.$/)
  })

  it('blocks: die genannte Karte wartet auf die neue', async () => {
    const r = await callTool(client, 'create_issue', { project: 'Multica', title: 'Zuerst', blocks: ['MS-2'] })
    const first = h.fake.issues.find((i) => i.title === 'Zuerst')
    assert.ok(first)
    assert.match(r.text, new RegExp(`MS-2 wartet jetzt auf ${first.identifier}\\.$`))
    assert.match(issue('MS-2').description ?? '', new RegExp(`Wartet auf: \\[${first.identifier}\\]`))
    const wake = writesTo(/\/wakeups$/).at(-1)
    assert.equal(wake?.path, `/api/issues/${issue('MS-2').id}/wakeups`)
    assert.deepEqual((wake?.body as { condition: unknown }).condition, { type: 'other_issue', issue_id: first.id, state: 'done' })
  })

  it('wartet nicht auf erledigte Karten', async () => {
    const wakes = writesTo(/\/wakeups$/).length
    const r = await callTool(client, 'create_issue', { project: 'Multica', title: 'Nach Erledigtem', assignee: 'Builder', blocked_by: ['MS-3'] })
    assert.match(r.text, /MS-3 ist schon abgeschlossen, darauf muss nicht gewartet werden\.$/)
    assert.equal(writesTo(/\/wakeups$/).length, wakes)
    assert.equal(h.fake.issues.find((i) => i.title === 'Nach Erledigtem')?.description, null)
  })

  it('lehnt todo mit Agent ab, solange ein Vorgänger offen ist', async () => {
    const before = h.fake.writes.length
    const r = await callTool(client, 'create_issue', { project: 'Multica', title: 'Zu früh', assignee: 'Builder', status: 'todo', blocked_by: ['MS-2'] })
    assert.equal(r.isError, true)
    assert.match(r.text, /^MS-2 ist noch nicht erledigt\. Eine wartende Karte bitte mit Status backlog anlegen/)
    assert.equal(h.fake.writes.length, before)
  })

  it('meldet eine nicht eingetragene Abhängigkeit, statt die angelegte Karte zu verschweigen', async () => {
    h.fake.wakeupsFail = true
    try {
      const r = await callTool(client, 'create_issue', { project: 'Multica', title: 'Ohne Wecker', assignee: 'Builder', blocked_by: ['MS-2'] })
      assert.equal(r.isError, false)
      assert.match(r.text, /^Angelegt: MS-\d+/)
      assert.match(r.text, /Nicht eingetragen werden konnte: MS-\d+ wartet auf MS-2\.$/)
    } finally {
      h.fake.wakeupsFail = false
    }
  })
})

describe('mehrere Karten auf einmal', () => {
  it('setzt alle offenen Unterkarten einer Oberkarte, abgeschlossene bleiben', async () => {
    const parent = fakeIssue(70, { title: 'Phase' })
    h.fake.issues.push(
      parent,
      fakeIssue(71, { status: 'backlog', parent_issue_id: parent.id, assignee_type: 'agent', assignee_id: BUILDER }),
      fakeIssue(72, { status: 'backlog', parent_issue_id: parent.id }),
      fakeIssue(73, { status: 'done', parent_issue_id: parent.id }),
    )
    const r = await callTool(client, 'bulk_update_issues', { parent: 'MS-70', status: 'todo' })
    assert.equal(r.text, '2 Karten stehen jetzt auf Zu erledigen: MS-71, MS-72. Eine schon abgeschlossene Unterkarte blieb, wie sie war. Für eine Karte startet jetzt ein Agentenlauf.')
    assert.deepEqual(lastWrite(), {
      method: 'POST',
      path: '/api/issues/batch-update',
      body: { issue_ids: [issue('MS-71').id, issue('MS-72').id], updates: { status: 'todo' } },
    })
    assert.equal(issue('MS-73').status, 'done')
  })

  it('setzt eine Liste von Kennungen auf einen Zuständigen', async () => {
    const r = await callTool(client, 'bulk_update_issues', { issues: ['MS-71', 'ms 72', 'MS-71'], assignee: 'ich', status: 'cancelled' })
    assert.equal(r.text, '2 Karten stehen jetzt auf Abgebrochen und bei fl0w: MS-71, MS-72.')
    assert.deepEqual((lastWrite()?.body as { updates: unknown }).updates, { status: 'cancelled', assignee_type: 'member', assignee_id: FLOW })
  })

  it('ändert nichts bei unbekannter Kennung oder ohne Änderung', async () => {
    const before = h.fake.writes.length
    assert.equal((await callTool(client, 'bulk_update_issues', { issues: ['MS-71', 'MS-998'], status: 'done' })).text, 'Das Issue MS-998 finde ich nicht.')
    assert.match((await callTool(client, 'bulk_update_issues', { issues: ['MS-71'] })).text, /Was soll sich bei allen ändern/)
    assert.match((await callTool(client, 'bulk_update_issues', { status: 'done' })).text, /Welche Karten/)
    assert.match((await callTool(client, 'bulk_update_issues', { parent: 'MS-3', status: 'done' })).text, /MS-3 hat keine offenen Unterkarten/)
    assert.equal(h.fake.writes.length, before)
  })
})

describe('Duplikate', () => {
  it('bricht eine Karte als Duplikat ab, ohne zu löschen', async () => {
    const r = await callTool(client, 'archive_issue', { issue: 'MS-72', duplicate_of: 'MS-71' })
    assert.equal(r.text, 'MS-72 ist abgebrochen und als Duplikat von MS-71 markiert. Sie bleibt in Multica sichtbar und lässt sich wieder öffnen.')
    assert.deepEqual(lastWrite(), { method: 'PUT', path: `/api/issues/${issue('MS-72').id}`, body: { status: 'cancelled', duplicate_of_issue_id: issue('MS-71').id } })
    assert.equal(h.fake.writes.some((w) => w.method === 'DELETE'), false)
  })

  it('lehnt ein Duplikat von sich selbst ab', async () => {
    const r = await callTool(client, 'archive_issue', { issue: 'MS-72', duplicate_of: 'ms-72' })
    assert.equal(r.isError, true)
  })
})

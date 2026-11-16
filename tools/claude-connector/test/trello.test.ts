// Trello mirror (MS-3182): push, comment mirror, manual pull, against an
// in-memory Trello and an in-memory Multica.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Comment, type Issue, type MulticaApi, MulticaError } from '../src/multica.ts'
import type { Pair } from '../src/trello/config.ts'
import { PULL_MARK, Sync, SyncStore, dateFromDue, dueFromDate, openSyncDb, relevantIssue } from '../src/trello/sync.ts'
import { Trello } from '../src/trello/trello.ts'

const PROJECT = '1a1103de-c928-486b-b0ed-d730b6d0e550'
const BUILDER = '1d76643a-7409-477f-9436-d29e0ffd2275'
const PAIR: Pair = {
  projectId: PROJECT,
  projectName: 'Drifter 999',
  board: 'zTDfk3TC',
  lists: { backlog: 'Backlog', todo: 'To-Do', in_progress: 'In Arbeit', in_review: 'Review / Marketing', done: 'Erledigt', blocked: 'Blockiert' },
  members: {},
}

interface FCard {
  id: string
  name: string
  desc: string
  idList: string
  idLabels: string[]
  idMembers: string[]
  due: string | null
  closed: boolean
  shortUrl: string
  dateLastActivity: string
  comments: { id: string; date: string; text: string; who: string }[]
}

function fakeTrello() {
  let n = 0
  const id = () => `t${String(++n).padStart(4, '0')}`
  const board = { id: 'board1', name: 'Drifter', url: 'https://trello.com/b/zTDfk3TC/drifter' }
  const lists = [
    { id: 'l-ideen', name: 'Ideen', pos: 1024, closed: false },
    { id: 'l-todo', name: 'To-Do', pos: 2048, closed: false },
    { id: 'l-arbeit', name: 'In Arbeit', pos: 4096, closed: false },
    { id: 'l-review', name: 'Review / Marketing', pos: 8192, closed: false },
    { id: 'l-erledigt', name: 'Erledigt', pos: 16384, closed: false },
  ]
  const labels = [{ id: 'lab-blue', name: '', color: 'blue' }]
  const cards: FCard[] = []
  const writes: string[] = []
  const f = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input))
    const q = Object.fromEntries(u.searchParams)
    const m = init?.method ?? 'GET'
    const path = u.pathname.replace(/^\/1/, '')
    if (m !== 'GET') writes.push(`${m} ${path}`)
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    const card = (cid: string) => cards.find((c) => c.id === cid)
    const pub = (c: FCard) => ({ ...c, comments: undefined })
    let r: RegExpExecArray | null
    if (m === 'GET' && path === '/boards/zTDfk3TC') return ok(board)
    if (m === 'GET' && path === '/boards/board1/lists') return ok(lists)
    if (m === 'POST' && path === '/lists') {
      const l = { id: id(), name: q.name, pos: q.pos === 'bottom' ? Math.max(...lists.map((x) => x.pos)) + 1024 : Number(q.pos), closed: false }
      lists.push(l)
      return ok(l)
    }
    if (m === 'GET' && path === '/boards/board1/labels') return ok(labels)
    if (m === 'POST' && path === '/labels') {
      const l = { id: id(), name: q.name, color: q.color }
      labels.push(l)
      return ok(l)
    }
    if (m === 'GET' && path === '/boards/board1/cards/all') return ok(cards.map(pub))
    if (m === 'POST' && path === '/cards') {
      const cid = id()
      const c: FCard = {
        id: cid,
        name: q.name,
        desc: q.desc ?? '',
        idList: q.idList,
        idLabels: q.idLabels ? q.idLabels.split(',') : [],
        idMembers: q.idMembers ? q.idMembers.split(',') : [],
        due: q.due ?? null,
        closed: false,
        shortUrl: `https://trello.com/c/${cid}`,
        dateLastActivity: new Date().toISOString(),
        comments: [],
      }
      cards.push(c)
      return ok(pub(c))
    }
    if ((r = /^\/cards\/([^/]+)$/.exec(path))) {
      const c = card(r[1])
      if (!c) return new Response('not found', { status: 404 })
      if (m === 'GET') return ok(pub(c))
      if (q.name !== undefined) c.name = q.name
      if (q.desc !== undefined) c.desc = q.desc
      if (q.idList !== undefined) c.idList = q.idList
      if (q.idLabels !== undefined) c.idLabels = q.idLabels ? q.idLabels.split(',') : []
      if (q.due !== undefined) c.due = q.due === 'null' ? null : q.due
      if (q.closed !== undefined) c.closed = q.closed === 'true'
      return ok(pub(c))
    }
    if ((r = /^\/cards\/([^/]+)\/actions$/.exec(path))) {
      return ok(card(r[1])!.comments.map((x) => ({ id: x.id, date: x.date, data: { text: x.text }, memberCreator: { fullName: x.who } })))
    }
    if ((r = /^\/cards\/([^/]+)\/actions\/comments$/.exec(path)) && m === 'POST') {
      const x = { id: id(), date: new Date().toISOString(), text: q.text, who: 'M S' }
      card(r[1])!.comments.push(x)
      return ok({ id: x.id })
    }
    return new Response(`unhandled ${m} ${path}`, { status: 500 })
  }) as typeof fetch
  return { f, lists, labels, cards, writes, board }
}

function fakeMultica() {
  let n = 3000
  const issues: Issue[] = []
  const comments: (Comment & { issue_id: string })[] = []
  const add = (o: Partial<Issue>): Issue => {
    n++
    const i: Issue = {
      id: `0000${n}-0000-0000-0000-000000000000`,
      identifier: `MS-${n}`,
      title: `Karte ${n}`,
      description: null,
      status: 'backlog',
      priority: 'none',
      assignee_type: null,
      assignee_id: null,
      project_id: PROJECT,
      due_date: null,
      created_at: new Date(Date.now() - 100_000 + n).toISOString(),
      updated_at: new Date().toISOString(),
      ...o,
    }
    issues.push(i)
    return i
  }
  const get = (ref: string) => {
    const i = issues.find((x) => x.id === ref || x.identifier === ref)
    if (!i) throw new MulticaError(404, 'not found')
    return i
  }
  const api = {
    agents: async () => [{ id: BUILDER, name: 'Builder', status: 'idle', archived_at: null, runtime_id: null }],
    members: async () => [{ user_id: 'u1', name: 'fl0w', email: 'x@y' }],
    getIssue: async (ref: string) => ({ ...get(ref) }),
    projectIssues: async (pid: string) => issues.filter((i) => i.project_id === pid).map((i) => ({ ...i })),
    commentsSince: async (iid: string, since: string) => comments.filter((c) => c.issue_id === iid && c.created_at >= since),
    createIssue: async (b: Record<string, unknown>) => add(b as Partial<Issue>),
    updateIssue: async (iid: string, b: Record<string, unknown>) => Object.assign(get(iid), b),
    addComment: async (iid: string, content: string) => {
      const c = { id: `c${comments.length + 1}`, issue_id: iid, author_type: 'member', author_id: 'u1', content, created_at: new Date().toISOString() }
      comments.push(c)
      return c
    },
  }
  return { api: api as unknown as MulticaApi, issues, comments, add }
}

function setup() {
  const t = fakeTrello()
  const m = fakeMultica()
  const store = new SyncStore(openSyncDb(':memory:'))
  const sync = new Sync({
    api: () => m.api,
    trello: new Trello(t.f, () => ({ key: 'k', token: 't' }), 'https://api.trello.test/1'),
    store,
    pairs: [PAIR],
    multicaWebUrl: 'https://multica.test/m2s',
  })
  return { t, m, store, sync }
}

const listOf = (t: ReturnType<typeof fakeTrello>, name: string) => t.lists.find((l) => l.name === name)!.id

test('Berlin time: due dates keep their calendar day in winter and summer', () => {
  assert.equal(dueFromDate('2026-11-20'), '2026-11-20T11:00:00.000Z')
  assert.equal(dueFromDate('2026-07-01'), '2026-07-01T10:00:00.000Z')
  assert.equal(dateFromDue('2026-11-20T11:00:00.000Z'), '2026-11-20')
  assert.equal(dateFromDue('2026-11-20T23:30:00.000Z'), '2026-11-21')
  assert.equal(dueFromDate(null), null)
})

test('initial sync: missing lists in order, one card per issue, cancelled skipped, second pass writes nothing', async () => {
  const { t, m, sync } = setup()
  m.add({ title: 'Roadmap', status: 'backlog', priority: 'medium', assignee_type: 'agent', assignee_id: BUILDER, description: 'Text [@Builder](mention://agent/x)' })
  m.add({ title: 'Whitepaper', status: 'in_review', priority: 'urgent', due_date: '2026-11-20' })
  m.add({ title: 'Weg', status: 'cancelled' })
  m.add({ title: 'Fertig', status: 'done' })
  const c = await sync.reconcile(PAIR)
  assert.equal(c.created, 3)
  assert.equal(c.skipped, 1)
  const open = t.lists.filter((l) => !l.closed).sort((a, b) => a.pos - b.pos).map((l) => l.name)
  assert.deepEqual(open, ['Ideen', 'Backlog', 'To-Do', 'In Arbeit', 'Review / Marketing', 'Erledigt', 'Blockiert'])
  const roadmap = t.cards.find((x) => x.name === 'MS-3001: Roadmap')!
  assert.equal(roadmap.idList, listOf(t, 'Backlog'))
  assert.match(roadmap.desc, /^Text @Builder\n\n---\nMultica: MS-3001 \(https:\/\/multica\.test\/m2s\/issues\/MS-3001\)\nZuständig: Builder$/)
  assert.deepEqual(roadmap.idLabels, [t.labels.find((l) => l.name === 'Priorität: mittel')!.id])
  const wp = t.cards.find((x) => x.name === 'MS-3002: Whitepaper')!
  assert.equal(wp.idList, listOf(t, 'Review / Marketing'))
  assert.equal(wp.due, '2026-11-20T11:00:00.000Z')
  assert.equal(t.cards.find((x) => x.name === 'MS-3004: Fertig')!.idList, listOf(t, 'Erledigt'))

  t.writes.length = 0
  const again = await sync.reconcile(PAIR)
  assert.equal(again.created, 0)
  assert.equal(again.unchanged, 3)
  assert.deepEqual(t.writes, [])
})

test('changes in Multica move, rename, relabel and archive the card; foreign labels stay', async () => {
  const { t, m, sync } = setup()
  const i = m.add({ title: 'Roadmap', priority: 'low' })
  await sync.pushIssue(i.id)
  const card = t.cards[0]
  card.idLabels.push('lab-blue')
  Object.assign(i, { status: 'in_progress', title: 'Roadmap v2', priority: 'high', assignee_type: 'agent', assignee_id: BUILDER })
  assert.equal(await sync.pushIssue(i.id), 'updated')
  assert.equal(card.idList, listOf(t, 'In Arbeit'))
  assert.equal(card.name, 'MS-3001: Roadmap v2')
  assert.match(card.desc, /Zuständig: Builder$/)
  const hoch = t.labels.find((l) => l.name === 'Priorität: hoch')!.id
  assert.deepEqual(card.idLabels.sort(), ['lab-blue', hoch].sort())
  i.status = 'blocked'
  await sync.pushIssue(i.id)
  assert.equal(card.idList, listOf(t, 'Blockiert'))
  i.status = 'cancelled'
  assert.equal(await sync.pushIssue(i.id), 'archived')
  assert.equal(card.closed, true)
  assert.equal(card.idList, listOf(t, 'Blockiert'))
  i.status = 'todo'
  await sync.pushIssue(i.id)
  assert.equal(card.closed, false)
  assert.equal(card.idList, listOf(t, 'To-Do'))
})

test('an issue moved to another project or deleted archives its card', async () => {
  const { t, m, sync } = setup()
  const i = m.add({ title: 'A' })
  await sync.pushIssue(i.id)
  i.project_id = 'other'
  assert.equal(await sync.pushIssue(i.id), 'archived')
  assert.equal(t.cards[0].closed, true)
  m.issues.splice(0, 1)
  assert.equal(await sync.pushIssue(i.id), 'unchanged')
})

test('new Multica comments go to Trello once, pulled comments never go back', async () => {
  const { t, m, sync } = setup()
  const i = m.add({ title: 'A' })
  await m.api.addComment(i.id, 'alt, vor der Verknüpfung')
  await new Promise((r) => setTimeout(r, 5))
  await sync.pushIssue(i.id)
  await new Promise((r) => setTimeout(r, 5))
  await m.api.addComment(i.id, 'Neu [@Builder](mention://agent/x)')
  await m.api.addComment(i.id, `${PULL_MARK}Fabian, 04.11.2026, 15:00:\n\nhallo`)
  await sync.pushIssue(i.id)
  await sync.pushIssue(i.id)
  const texts = t.cards[0].comments.map((c) => c.text)
  assert.equal(texts.length, 1)
  assert.match(texts[0], /^fl0w in Multica, \d\d\.\d\d\.\d{4}, \d\d:\d\d:\n\nNeu @Builder$/)
})

test('a card deleted on Trello is created again', async () => {
  const { t, m, sync } = setup()
  const i = m.add({ title: 'A' })
  await sync.pushIssue(i.id)
  t.cards.splice(0, 1)
  i.title = 'B'
  await sync.pushIssue(i.id)
  assert.equal(t.cards.length, 1)
  assert.equal(t.cards[0].name, 'MS-3001: B')
})

test('pull: preview writes nothing, apply creates a backlog issue without assignee and mirrors it back', async () => {
  const { t, m, sync, store } = setup()
  await sync.reconcile(PAIR)
  t.cards.push({
    id: 'tc1',
    name: 'Whitepaper schreiben',
    desc: 'Erste Fassung',
    idList: listOf(t, 'To-Do'),
    idLabels: [],
    idMembers: [],
    due: '2026-11-20T14:00:00.000Z',
    closed: false,
    shortUrl: 'https://trello.com/c/AbCd1234',
    dateLastActivity: '',
    comments: [{ id: 'act1', date: '2026-11-04T13:00:00.000Z', text: 'Bitte bis Freitag', who: 'Fabian Schuck' }],
  })
  t.writes.length = 0
  const plan = await sync.planPull(PAIR)
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].kind, 'new')
  assert.deepEqual(t.writes, [])
  assert.equal(m.issues.length, 0)

  await sync.applyPull(plan)
  assert.equal(m.issues.length, 1)
  const i = m.issues[0]
  assert.equal(i.status, 'backlog')
  assert.equal(i.assignee_id, null)
  assert.equal(i.title, 'Whitepaper schreiben')
  assert.equal(i.description, 'Erste Fassung')
  assert.equal(i.due_date, '2026-11-20')
  assert.equal(m.comments.length, 1)
  assert.equal(m.comments[0].content, `${PULL_MARK}Fabian Schuck, 04.11.2026, 14:00:\n\nBitte bis Freitag`)
  const card = t.cards.find((c) => c.id === 'tc1')!
  assert.equal(card.name, `${i.identifier}: Whitepaper schreiben`)
  assert.equal(card.idList, listOf(t, 'Backlog'))
  assert.equal(card.comments.length, 1, 'the imported comment is not mirrored back')
  assert.ok(store.byCard('tc1'))
  assert.equal((await sync.planPull(PAIR)).items.length, 0)
})

test('pull: Trello edits on a linked card update Multica, only that card when asked', async () => {
  const { t, m, sync } = setup()
  const a = m.add({ title: 'Roadmap', status: 'backlog', assignee_type: 'agent', assignee_id: BUILDER })
  const b = m.add({ title: 'Andere' })
  await sync.reconcile(PAIR)
  const ca = t.cards.find((c) => c.name.startsWith(a.identifier))!
  const cb = t.cards.find((c) => c.name.startsWith(b.identifier))!
  ca.name = `${a.identifier}: Roadmap 2027`
  ca.desc = ca.desc.replace(/^/, 'Neuer Text\n\n')
  ca.idList = listOf(t, 'To-Do')
  ca.comments.push({ id: 'act9', date: new Date().toISOString(), text: 'ok', who: 'Fabian' })
  cb.name = 'Andere neu'

  const one = await sync.planPull(PAIR, 'ms 3001')
  assert.equal(one.items.length, 1)
  const said = one.items[0].changes.join(', ')
  assert.match(said, /Titel wird „Roadmap 2027“/)
  assert.match(said, /Beschreibung wird übernommen/)
  assert.match(said, /Status wird Zu erledigen, dabei startet der zuständige Agent/)
  assert.match(said, /1 neuer Kommentar/)
  await sync.applyPull(one)
  assert.equal(a.title, 'Roadmap 2027')
  assert.equal(a.description, 'Neuer Text')
  assert.equal(a.status, 'todo')
  assert.equal(b.title, 'Andere')
  assert.match(ca.desc, /^Neuer Text\n\n---\nMultica: /)

  const rest = await sync.planPull(PAIR)
  assert.equal(rest.items.length, 1)
  assert.equal(rest.items[0].issue?.identifier, b.identifier)
  await sync.applyPull(rest)
  assert.equal(b.title, 'Andere neu')
  assert.equal(cb.name, `${b.identifier}: Andere neu`)
})

test('pull: a card in a list without status keeps the status and goes back', async () => {
  const { t, m, sync } = setup()
  const a = m.add({ title: 'A', status: 'todo' })
  await sync.pushIssue(a.id)
  t.cards[0].idList = listOf(t, 'Ideen')
  const plan = await sync.planPull(PAIR)
  assert.match(plan.items[0].changes[0], /Liste Ideen, die zu keinem Status gehört/)
  await sync.applyPull(plan)
  assert.equal(a.status, 'todo')
  assert.equal(t.cards[0].idList, listOf(t, 'To-Do'))
})

test('events: only mirrored projects and linked issues wake the sync', () => {
  const ids = new Set([PROJECT])
  const linked = (id: string) => id === 'L'
  assert.equal(relevantIssue({ type: 'issue:created', payload: { issue: { id: 'X', project_id: PROJECT } } }, ids, linked), 'X')
  assert.equal(relevantIssue({ type: 'issue:updated', payload: { issue: { id: 'Y', project_id: 'other' } } }, ids, linked), null)
  assert.equal(relevantIssue({ type: 'issue:updated', payload: { issue: { id: 'L', project_id: 'other' } } }, ids, linked), 'L')
  assert.equal(relevantIssue({ type: 'issue:deleted', payload: { issue_id: 'L' } }, ids, linked), 'L')
  assert.equal(relevantIssue({ type: 'comment:created', payload: { comment: { issue_id: 'Z' } } }, ids, linked), null)
  assert.equal(relevantIssue({ type: 'comment:created', payload: { comment: { issue_id: 'L' } } }, ids, linked), 'L')
})

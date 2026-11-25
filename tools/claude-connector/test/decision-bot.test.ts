// Decision bot @multicafl0wbot (MS-4379): detection, buttons, text answers, Bemerkung,
// comment format, next step and the owner check, against a fake board and a fake Telegram.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Comment, Issue, Project } from '../src/multica.ts'
import { DecisionBot, type Board } from '../src/decision-bot/bot.ts'
import { extractQuestion, parseFrageStyle } from '../src/decision-bot/detect.ts'
import { Store } from '../src/decision-bot/store.ts'
import type { Keyboard, Tg, TgUpdate } from '../src/decision-bot/telegram.ts'
import { parseTextAnswer, tomorrowNine } from '../src/decision-bot/texts.ts'

const FLOW = '46ece536-d531-4ef9-a493-be97b0118e06'
const OWNER = 111222333
const STRANGER = 999
const AGENT = 'ef45b219-f4a1-48fc-afb9-d0e21fb7550b'
const P_ACTIVE = 'p-active'
const P_PAUSED = 'p-paused'

const MS4276 = `Frage: Unter welchen Konten werden die Anzeigen gepostet?

Hintergrund: Die Liste der nötigen Konten je Kanal kommt aus Karte 2.3.

Optionen:
(a) nur Agentur-Konten „model2star“, fehlende legst du an
(b) Agentur-Konten, wo es geht, sonst dein persönliches Konto
(c) nur Kanäle nutzen, für die es schon ein Konto gibt

Empfehlung: (a). Der Auftritt bleibt einheitlich.

Antwort als Kommentar, danach die Karte auf done.`

const BLOCK = `Beleg und Auswirkung.

## Entscheidung

**Worum es geht:** Der Hermes-Bot ist aus dem Discord-Server verschwunden.

**Zu entscheiden:** Soll der Bot wieder eingeladen oder Discord abgeschaltet werden?

**Empfehlung:** Wieder einladen, weil alles fertig gebaut ist.

**Option A (empfohlen):** Du lädst den Bot wieder ein.

**Option B:** Ich schalte Discord ab.`

function issue(n: number, o: Partial<Issue>): Issue {
  return {
    id: `issue-${n}`,
    identifier: `MS-${n}`,
    title: `Karte ${n}`,
    description: null,
    status: 'backlog',
    priority: 'none',
    assignee_type: 'member',
    assignee_id: FLOW,
    project_id: P_ACTIVE,
    created_at: '2026-11-25T10:00:00Z',
    updated_at: '2026-11-25T10:00:00Z',
    ...o,
  }
}

class FakeBoard implements Board {
  issues: Issue[] = []
  comments_: Map<string, Comment[]> = new Map()
  projects_: Project[] = [
    { id: P_ACTIVE, title: 'model2star.com', status: 'in_progress' },
    { id: P_PAUSED, title: 'Fansly', status: 'paused' },
  ]
  written: { issueId: string; content: string }[] = []
  updates: { issueId: string; body: Record<string, unknown> }[] = []
  failComments = false
  /** Number of updateIssue calls that throw before it works again. */
  failUpdates = 0
  async projects() {
    return this.projects_
  }
  async listIssues(q: { statuses?: string[]; limit: number; offset?: number }) {
    const all = this.issues.filter((i) => !q.statuses || q.statuses.includes(i.status))
    const off = q.offset ?? 0
    return { issues: all.slice(off, off + q.limit), total: all.length }
  }
  async getIssue(ref: string) {
    const i = this.issues.find((x) => x.id === ref || x.identifier === ref)
    if (!i) throw new Error('not found')
    return i
  }
  async comments(id: string) {
    return this.comments_.get(id) ?? []
  }
  async addComment(issueId: string, content: string) {
    if (this.failComments) throw new Error('multica down')
    this.written.push({ issueId, content })
    const c = { id: `c${this.written.length}`, author_type: 'member', author_id: FLOW, content, created_at: new Date().toISOString() }
    this.comments_.set(issueId, [...(this.comments_.get(issueId) ?? []), c])
    const i = this.issues.find((x) => x.id === issueId)
    if (i) (i as Issue & { last_activity_at?: string }).last_activity_at = c.created_at + this.written.length
    return c
  }
  async updateIssue(issueId: string, body: Record<string, unknown>) {
    if (this.failUpdates > 0) {
      this.failUpdates--
      throw new Error('multica update down')
    }
    this.updates.push({ issueId, body })
    const i = this.issues.find((x) => x.id === issueId)!
    Object.assign(i, body)
    return i
  }
}

interface Sent {
  id: number
  chat: number
  text: string
  keyboard: Keyboard | undefined
  forceReply: boolean
}

class FakeTg implements Tg {
  sent: Sent[] = []
  edits: { id: number; text: string; keyboard: Keyboard | undefined }[] = []
  callbacks: { id: string; text?: string }[] = []
  next = 100
  async send(chat: number, text: string, keyboard?: Keyboard, forceReply = false) {
    const id = this.next++
    this.sent.push({ id, chat, text, keyboard, forceReply })
    return id
  }
  async edit(_chat: number, id: number, text: string, keyboard?: Keyboard) {
    this.edits.push({ id, text, keyboard })
  }
  async answerCallback(id: string, text?: string) {
    this.callbacks.push({ id, text })
  }
  lastEdit(id: number) {
    return this.edits.filter((e) => e.id === id).at(-1)
  }
}

function setup() {
  let now = Date.parse('2026-11-25T14:00:00Z')
  const board = new FakeBoard()
  const tg = new FakeTg()
  const store = new Store(':memory:')
  store.setKv('begruesst', '1')
  const bot = new DecisionBot({
    board: () => board,
    tg,
    store,
    ownerChatId: OWNER,
    flowUserId: FLOW,
    link: (k) => `https://host.test/m2s/issues/${k}`,
    now: () => now,
    graceMs: 120_000,
  })
  const advance = (ms: number) => {
    now += ms
  }
  let upd = 1
  const press = (data: string, from = OWNER) =>
    bot.handle({ update_id: upd++, callback_query: { id: `cb${upd}`, from: { id: from }, message: { message_id: 1, chat: { id: from } }, data } })
  const say = (text: string, from = OWNER, replyTo?: number): Promise<void> =>
    bot.handle({
      update_id: upd++,
      message: { message_id: 5000 + upd, chat: { id: from, type: 'private' }, from: { id: from }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) },
    } as TgUpdate)
  const buttons = (s: Sent) => (s.keyboard ?? []).flat().map((b) => b.text)
  const data = (s: Sent) => (s.keyboard ?? []).flat().map((b) => ('callback_data' in b ? b.callback_data : `url:${b.url}`))
  return { bot, board, tg, store, advance, press, say, buttons, data }
}

async function ask(t: ReturnType<typeof setup>) {
  await t.bot.scan()
  await t.bot.sendDue()
}

test('Testfrage: Kopf, Frage, Knöpfe Ja, Nein, Bemerkung, Später, Karte öffnen', async () => {
  const t = setup()
  t.board.issues.push(issue(1, { title: 'Entscheidung: Testkarte für den Bot', description: 'Frage: Soll der Test laufen?' }))
  await ask(t)
  assert.equal(t.tg.sent.length, 1)
  const m = t.tg.sent[0]
  assert.equal(m.chat, OWNER)
  assert.match(m.text, /^Entscheidung für MS-1 \(model2star\.com\)\n\nSoll der Test laufen\?/)
  assert.deepEqual(t.buttons(m), ['Ja', 'Nein', 'Bemerkung', 'Später', 'Karte öffnen'])
  assert.ok(t.data(m).includes('url:https://host.test/m2s/issues/MS-1'))
})

test('Karte mit Optionen (a), (b), (c) bekommt einen Knopf je Option und die Empfehlung', async () => {
  const t = setup()
  t.board.issues.push(issue(4276, { title: 'E5 Konten für öffentliche Stellenanzeigen', description: MS4276 }))
  await ask(t)
  const m = t.tg.sent[0]
  assert.match(m.text, /Unter welchen Konten werden die Anzeigen gepostet\?/)
  assert.match(m.text, /Empfehlung: \(a\)\. Der Auftritt bleibt einheitlich\./)
  const b = t.buttons(m)
  assert.deepEqual(b.slice(0, 3), ['Ja', 'Nein', 'Bemerkung'])
  assert.equal(b.filter((x) => /^\([abc]\) /.test(x)).length, 3)
  assert.deepEqual(b.slice(-2), ['Später', 'Karte öffnen'])
})

test('Knopf: Antwort, Knöpfe weg, Bestätigung, nach der Wartezeit Kommentar im Format, Karte auf done', async () => {
  const t = setup()
  t.board.issues.push(issue(4276, { title: 'E5 Konten', description: MS4276 }))
  await ask(t)
  const qid = t.tg.sent[0].id
  await t.press('a:1:oa')
  const frozen = t.tg.lastEdit(qid)!
  assert.deepEqual(frozen.keyboard, null, 'Knöpfe der Frage entfernt')
  assert.match(frozen.text, /Antwort .*Option \(a\)/)
  const confirm = t.tg.sent.at(-1)!
  assert.match(confirm.text, /^Verstanden für MS-4276: Option \(a\): nur Agentur-Konten/)
  assert.match(confirm.text, /Frage: Unter welchen Konten/)

  assert.equal(await t.bot.flush(), 0, 'wartet auf eine mögliche Bemerkung')
  t.advance(121_000)
  assert.equal(await t.bot.flush(), 1)
  const c = t.board.written[0]
  assert.equal(c.issueId, 'issue-4276')
  assert.match(c.content, /^Antwort von fl0w per Telegram \(Bot @multicafl0wbot, 25\.11\.2026, 15:00 Uhr Berlin, per Knopf\): \*\*Option \(a\): nur Agentur-Konten/)
  assert.match(c.content, /\n\nFrage: Unter welchen Konten werden die Anzeigen gepostet\?/)
  assert.deepEqual(t.board.updates, [{ issueId: 'issue-4276', body: { status: 'done' } }], 'Karte sieht done vor')
})

test('Doppelt drücken schreibt nichts doppelt, dieselbe Frage kommt nie zweimal', async () => {
  const t = setup()
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Ja oder nein?' }))
  await ask(t)
  await t.press('a:1:j')
  await t.press('a:1:n')
  assert.match(t.tg.callbacks.at(-1)!.text!, /Schon beantwortet: Ja/)
  t.advance(121_000)
  await t.bot.flush()
  await ask(t)
  await ask(t)
  assert.equal(t.board.written.length, 1)
  assert.equal(t.tg.sent.filter((s) => s.text.startsWith('Entscheidung für')).length, 1)
})

test('Freie Textantwort „ja“ wird angenommen, nie mit „Bitte tipp auf einen Knopf“ abgewiesen', async () => {
  const t = setup()
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Machen wir das?' }))
  await ask(t)
  await t.say('ja')
  const all = t.tg.sent.map((s) => s.text).join('\n')
  assert.doesNotMatch(all, /tipp auf/i)
  assert.match(t.tg.sent.at(-1)!.text, /^Verstanden für MS-1: Ja\./)
  t.advance(121_000)
  await t.bot.flush()
  assert.match(t.board.written[0].content, /per Text\): \*\*Ja\*\*/)
})

test('Textantworten: ok, nein mit Satz, Buchstabe, freier Satz', () => {
  const abc = ['a', 'b', 'c'].map((code) => ({ code, label: `(${code})`, text: code }))
  assert.deepEqual(parseTextAnswer('ok', abc), { kind: 'ja', option: null, bemerkung: null })
  assert.deepEqual(parseTextAnswer('Nein, lieber nächste Woche', abc), { kind: 'nein', option: null, bemerkung: 'lieber nächste Woche' })
  assert.deepEqual(parseTextAnswer('b', abc), { kind: 'option', option: 'b', bemerkung: null })
  assert.deepEqual(parseTextAnswer('Option C, aber nur testweise', abc), { kind: 'option', option: 'c', bemerkung: 'aber nur testweise' })
  assert.deepEqual(parseTextAnswer('aber nur mit Vornamen', abc), { kind: 'bemerkung', option: null, bemerkung: 'aber nur mit Vornamen' })
  assert.deepEqual(parseTextAnswer('Alle drei einschalten', abc), { kind: 'bemerkung', option: null, bemerkung: 'Alle drei einschalten' })
})

test('Freitext mit Anfangsbuchstabe ist nur dann eine Option, wenn die Karte sie anbietet (MS-4382)', () => {
  const ab = [
    { code: 'a', label: '(a)', text: 'eins' },
    { code: 'b', label: '(b)', text: 'zwei' },
  ]
  const abcde = ['a', 'b', 'c', 'd', 'e'].map((code) => ({ code, label: code.toUpperCase(), text: code }))
  assert.deepEqual(parseTextAnswer('E-Mail an ihn schicken', []), { kind: 'bemerkung', option: null, bemerkung: 'E-Mail an ihn schicken' })
  assert.deepEqual(parseTextAnswer('D.h. wir warten noch', []), { kind: 'bemerkung', option: null, bemerkung: 'D.h. wir warten noch' })
  assert.deepEqual(parseTextAnswer('E-Mail an ihn schicken', ab), { kind: 'bemerkung', option: null, bemerkung: 'E-Mail an ihn schicken' })
  assert.deepEqual(parseTextAnswer('c', ab), { kind: 'bemerkung', option: null, bemerkung: 'c' })
  // Even an offered letter is no option when it starts a word ("E-Mail", "D.h.").
  assert.deepEqual(parseTextAnswer('E-Mail an ihn schicken', abcde), { kind: 'bemerkung', option: null, bemerkung: 'E-Mail an ihn schicken' })
  assert.deepEqual(parseTextAnswer('D.h. wir warten noch', abcde), { kind: 'bemerkung', option: null, bemerkung: 'D.h. wir warten noch' })
  assert.deepEqual(parseTextAnswer('b, weil schneller', ab), { kind: 'option', option: 'b', bemerkung: 'weil schneller' })
  assert.deepEqual(parseTextAnswer('e.', abcde), { kind: 'option', option: 'e', bemerkung: null })
})

test('Freitext „E-Mail …“ auf eine Karte ohne Optionen landet als Bemerkung, nicht als „Option E“ (MS-4382)', async () => {
  const t = setup()
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Wie erreichen wir ihn?' }))
  await ask(t)
  await t.say('E-Mail an ihn schicken')
  t.advance(121_000)
  await t.bot.flush()
  assert.equal(t.board.written.length, 1)
  assert.match(t.board.written[0].content, /\*\*Bemerkung\*\*/)
  assert.doesNotMatch(t.board.written[0].content, /Option E/)
  assert.match(t.board.written[0].content, /Bemerkung: E-Mail an ihn schicken/)
})

test('Nächster Schritt scheitert einmal: genau ein Kommentar, danach der Schritt (MS-4382)', async () => {
  const t = setup()
  t.board.issues.push(issue(2, { title: 'Entscheidung: Discord', description: BLOCK, assignee_type: 'agent', assignee_id: AGENT, status: 'blocked' }))
  await ask(t)
  await t.say('a')
  t.board.failUpdates = 1
  t.advance(121_000)
  assert.equal(await t.bot.flush(), 0)
  assert.equal(t.store.get(1)!.state, 'beantwortet')
  // A Bemerkung after the comment is on the card goes as Nachtrag, never lost.
  await t.say('und bitte heute noch')
  assert.match(t.tg.sent.at(-1)!.text, /als Nachtrag an der Karte/)
  // /offen must not claim the answer is still on its way to the card.
  await t.say('/offen')
  assert.match(t.tg.sent.at(-1)!.text, /steht an der Karte, nächster Schritt folgt/)
  assert.equal(await t.bot.flush(), 1)
  assert.equal(t.store.get(1)!.state, 'weitergegeben')
  const answers = t.board.written.filter((w) => w.content.startsWith('Antwort von fl0w'))
  assert.equal(answers.length, 1, 'Antwort-Kommentar genau einmal')
  assert.equal(t.board.written.filter((w) => w.content.startsWith('Nachtrag von fl0w')).length, 1)
  assert.deepEqual(t.board.updates, [{ issueId: 'issue-2', body: { status: 'todo' } }])
})

test('Bemerkung-Knopf öffnet eine Antwort-Eingabe, der Text geht als Bemerkung zur Karte', async () => {
  const t = setup()
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Machen wir das?' }))
  await ask(t)
  await t.press('b:1')
  const prompt = t.tg.sent.at(-1)!
  assert.equal(prompt.forceReply, true)
  await t.say('erst nach dem Wochenende', OWNER, prompt.id)
  assert.match(t.tg.sent.at(-1)!.text, /^Verstanden für MS-1: Bemerkung: „erst nach dem Wochenende“/)
  t.advance(121_000)
  await t.bot.flush()
  assert.match(t.board.written[0].content, /\*\*Bemerkung\*\*\n\nFrage: Machen wir das\?\nBemerkung: erst nach dem Wochenende$/)
})

test('Nach Ja kann eine Bemerkung nachgeschoben werden: vor der Weitergabe im selben Kommentar, danach als Nachtrag', async () => {
  const t = setup()
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Machen wir das?' }))
  await ask(t)
  await t.press('a:1:j')
  await t.say('aber nur mit Vornamen')
  t.advance(121_000)
  await t.bot.flush()
  assert.equal(t.board.written.length, 1)
  assert.match(t.board.written[0].content, /\*\*Ja\*\*\n\nFrage: Machen wir das\?\nBemerkung: aber nur mit Vornamen$/)
  const confirm = t.tg.sent.find((s) => s.text.startsWith('Verstanden für MS-1: Ja'))!
  await t.say('und bitte bis Freitag', OWNER, confirm.id)
  assert.equal(t.board.written.length, 2)
  assert.match(t.board.written[1].content, /^Nachtrag von fl0w per Telegram .*\n\nFrage: Machen wir das\?\nBemerkung: und bitte bis Freitag$/)
})

test('Später: Knöpfe weg, Frage kommt am nächsten Tag um 9 Uhr wieder', async () => {
  const t = setup()
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Machen wir das?' }))
  await ask(t)
  await t.press('s:1')
  assert.deepEqual(t.tg.lastEdit(t.tg.sent[0].id)!.keyboard, null)
  t.advance(60 * 60_000)
  await ask(t)
  assert.equal(t.tg.sent.length, 1, 'nicht vor morgen')
  t.advance(20 * 60 * 60_000)
  await ask(t)
  assert.equal(t.tg.sent.length, 2)
  assert.match(t.tg.sent[1].text, /^Entscheidung für MS-1/)
  assert.equal(new Date(tomorrowNine(Date.parse('2026-11-25T14:00:00Z'))).toISOString(), '2026-11-26T08:00:00.000Z')
})

test('Fremde Chat-IDs werden ignoriert: kein Knopf, kein Text, keine Antwort', async () => {
  const t = setup()
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Machen wir das?' }))
  await ask(t)
  const before = t.tg.sent.length
  await t.press('a:1:j', STRANGER)
  await t.say('ja', STRANGER)
  await t.say('/offen', STRANGER)
  assert.equal(t.tg.sent.length, before)
  assert.equal(t.tg.callbacks.length, 0)
  assert.equal(t.store.get(1)!.state, 'gesendet')
})

test('/offen listet alle offenen Entscheidungen aktiver Projekte, pausierte nicht', async () => {
  const t = setup()
  t.board.issues.push(
    issue(1, { title: 'Entscheidung: Eins', description: 'Frage: Erste Frage?' }),
    issue(2, { title: 'Entscheidung: Zwei', description: BLOCK, assignee_type: 'agent', assignee_id: AGENT, status: 'blocked' }),
    issue(3, { title: 'Entscheidung: Fansly', description: 'Frage: Pausiert?', project_id: P_PAUSED }),
    issue(4, { title: 'Normale Karte', description: 'Nichts zu entscheiden' }),
  )
  await t.say('/offen')
  const list = t.tg.sent.at(-1)!
  assert.match(list.text, /^Offene Entscheidungen \(2\):/)
  assert.match(list.text, /MS-1 \(model2star\.com\): Erste Frage\?/)
  assert.match(list.text, /MS-2 \(model2star\.com\): Soll der Bot wieder eingeladen/)
  assert.doesNotMatch(list.text, /MS-3|MS-4/)
})

test('Agentenkarte: Kommentar weckt den Agenten, blocked geht auf todo', async () => {
  const t = setup()
  t.board.issues.push(issue(2, { title: 'Entscheidung: Discord', description: BLOCK, assignee_type: 'agent', assignee_id: AGENT, status: 'blocked' }))
  await ask(t)
  const b = t.buttons(t.tg.sent[0])
  assert.ok(b.some((x) => x.startsWith('A Du lädst')) && b.some((x) => x.startsWith('B Ich schalte')))
  await t.say('a')
  t.advance(121_000)
  await t.bot.flush()
  assert.match(t.board.written[0].content, /\*\*Option A: Du lädst den Bot wieder ein\.\*\*/)
  assert.deepEqual(t.board.updates, [{ issueId: 'issue-2', body: { status: 'todo' } }])
})

test('Blockierte Karte mit Entscheidungsblock im letzten Agentenkommentar wird gefragt', async () => {
  const t = setup()
  t.board.issues.push(issue(7, { title: 'sec-hub: Backup-Aufbewahrung', description: 'Technik', status: 'blocked', assignee_type: 'agent', assignee_id: AGENT }))
  t.board.comments_.set('issue-7', [{ id: 'x', author_type: 'agent', author_id: AGENT, content: BLOCK, created_at: '2026-11-25T11:00:00Z' }])
  await ask(t)
  assert.match(t.tg.sent[0].text, /^Entscheidung für MS-7 .*\n\nSoll der Bot wieder eingeladen/)
})

test('Hat fl0w zuletzt kommentiert, wird nicht gefragt; beantwortet er in Multica, verschwinden die Knöpfe', async () => {
  const t = setup()
  const i = issue(1, { title: 'Entscheidung: X', description: 'Frage: Machen wir das?' }) as Issue & { last_activity_at?: string }
  t.board.issues.push(i)
  await ask(t)
  t.board.comments_.set('issue-1', [{ id: 'y', author_type: 'member', author_id: FLOW, content: 'Ja, machen.', created_at: '2026-11-25T14:05:00Z' }])
  i.last_activity_at = '2026-11-25T14:05:00Z'
  await ask(t)
  assert.equal(t.store.get(1)!.state, 'erledigt')
  assert.deepEqual(t.tg.lastEdit(t.tg.sent[0].id)!.keyboard, null)
  assert.match(t.tg.lastEdit(t.tg.sent[0].id)!.text, /Erledigt, in Multica beantwortet/)
})

test('Frage von außen (model2star Jobs) ersetzt die erkannte Frage derselben Karte', async () => {
  const t = setup()
  t.board.issues.push(issue(4276, { title: 'E5 Konten', description: MS4276 }))
  await t.bot.scan()
  const r = await t.bot.addExternal('MS-4276', 'Sollen die Facebook-Gruppen über dein Profil laufen?', [], null, 'model2star Jobs')
  assert.equal(r.added, true)
  await t.bot.sendDue()
  await ask(t)
  const asked = t.tg.sent.filter((s) => s.text.startsWith('Entscheidung für'))
  assert.equal(asked.length, 1)
  assert.match(asked[0].text, /Facebook-Gruppen/)
  assert.match(asked[0].text, /Gefragt von: model2star Jobs/)
  assert.equal((await t.bot.addExternal('MS-4276', 'Sollen die Facebook-Gruppen über dein Profil laufen?', [], null, null)).added, false)
})

test('Weitergabe scheitert: Antwort bleibt, nach 30 Minuten ein Hinweis, danach geht sie raus', async () => {
  const t = setup()
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Machen wir das?' }))
  await ask(t)
  await t.press('a:1:n')
  t.board.failComments = true
  t.advance(121_000)
  await t.bot.flush()
  assert.equal(t.store.get(1)!.state, 'beantwortet')
  t.advance(30 * 60_000)
  await t.bot.flush()
  assert.match(t.tg.sent.at(-1)!.text, /seit 30 Minuten nicht in Multica angekommen/)
  t.board.failComments = false
  await t.bot.flush()
  assert.equal(t.store.get(1)!.state, 'weitergegeben')
  assert.match(t.board.written[0].content, /\*\*Nein\*\*/)
})

test('Keine offene Frage: Text bekommt einen Satz, keine Knopf-Schleife', async () => {
  const t = setup()
  await t.say('ja')
  assert.match(t.tg.sent[0].text, /^Gerade ist keine Entscheidung offen/)
})

test('Erkennung an echten Kartenformen', () => {
  const q = extractQuestion({ title: 'E5 Konten', description: MS4276, status: 'backlog' }, [], FLOW)!
  assert.equal(q.frage, 'Unter welchen Konten werden die Anzeigen gepostet?')
  assert.deepEqual(q.optionen.map((o) => o.label), ['(a)', '(b)', '(c)'])
  assert.equal(q.doneAfterAnswer, true)
  const t = extractQuestion({ title: '6 Entscheidung fl0w: Welcher Zweitzugang als Backup', description: 'Kontext ohne Frage', status: 'todo' }, [], FLOW)!
  assert.equal(t.frage, 'Welcher Zweitzugang als Backup')
  assert.equal(extractQuestion({ title: 'Normale Karte', description: 'Text', status: 'todo' }, [], FLOW), null)
  assert.equal(extractQuestion({ title: 'Entscheidung: X', description: null, status: 'in_progress' }, [], FLOW), null)
  assert.equal(parseFrageStyle('Kein Fragezeichen hier (c) nur so'), null)
})

test('Go-live: einmal Begrüßung; lehnt Telegram ab, meldet sendHealth den Fehler, bis fl0w Start tippt', async () => {
  const t = setup()
  t.store.setKv('begruesst', null)
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Machen wir das?' }))
  const send = t.tg.send.bind(t.tg)
  t.tg.send = async () => {
    throw new Error("Forbidden: bot can't initiate conversation with a user")
  }
  await ask(t)
  assert.match(t.bot.sendHealth()!.error, /initiate conversation/)
  t.tg.send = send
  await t.say('/start')
  await t.bot.sendDue()
  assert.equal(t.bot.sendHealth(), null)
  const texts = t.tg.sent.map((x) => x.text)
  assert.equal(texts.filter((x) => x.startsWith('Der Entscheidungs-Bot ist live.')).length, 1)
  assert.equal(texts.filter((x) => x.startsWith('Entscheidung für MS-1')).length, 1)
  await t.bot.sendDue()
  assert.equal(t.tg.sent.filter((x) => x.text.startsWith('Der Entscheidungs-Bot ist live.')).length, 1)
})

test('Go-live wird genau einmal gemeldet, mit der Zahl offener Fragen', async () => {
  const t = setup()
  t.store.setKv('begruesst', null)
  const calls: number[] = []
  const bot = new DecisionBot({ board: () => t.board, tg: t.tg, store: t.store, ownerChatId: OWNER, flowUserId: FLOW, link: (k) => k, onLive: async (n) => void calls.push(n) })
  t.board.issues.push(issue(1, { title: 'Entscheidung: X', description: 'Frage: Machen wir das?' }))
  await bot.scan()
  await bot.sendDue()
  await bot.sendDue()
  assert.deepEqual(calls, [1])
})

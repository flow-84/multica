// Which open cards carry a decision for fl0w, and what exactly is asked (MS-4379).
// Pure functions: the bot feeds them an issue plus its comments and gets back the
// question to send, or null.
//
// A card is a decision card when it is open (backlog, todo, blocked) and
//   - its title starts with "Entscheidung" (an optional short prefix like "6 " or "E5 " is allowed),
//   - or its description has a line "Frage: ..." or a "## Entscheidung" block,
//   - or it is blocked and its latest comment is an agent's "## Entscheidung" block
//     (the workspace-wide format agents use when they stop for a decision).
// When the latest comment comes from fl0w the ball is with the agent: nothing is asked.
import { createHash } from 'node:crypto'
import type { Comment, Issue } from '../multica.ts'

export const OPEN_STATUSES = ['backlog', 'todo', 'blocked'] as const
/** Project statuses whose cards are never asked (paused projects, MS-4379 "Grenzen"). */
export const INACTIVE_PROJECT_STATUSES = new Set(['paused', 'cancelled', 'completed', 'archived'])

export interface Option {
  /** Lower-case letter used in callback data and text answers. */
  code: string
  /** How the card names it: "(a)" or "A". */
  label: string
  text: string
}

export type Source = 'kommentar' | 'beschreibung' | 'titel' | 'extern'

export interface Question {
  frage: string
  empfehlung: string | null
  optionen: Option[]
  source: Source
  /** The card asks to be set to done once the answer is there ("Antwort als Kommentar, danach die Karte auf done"). */
  doneAfterAnswer: boolean
  /** Stable key: the same question on the same card is asked once. */
  hash: string
}

const MAX_FRAGE = 700
const MAX_EMPFEHLUNG = 500
const MAX_OPTION = 300

const TITLE_RE = /^\s*(?:\S{1,4}\s+)?Entscheidung\b/i
const FRAGE_LINE_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?Frage(?:\*\*)?:(?:\*\*)?\s*(.*)$/im
const BLOCK_RE = /^##\s*Entscheidung\b[^\n]*$/im
const DONE_RE = /antwort\w*[^.\n]{0,80}Karte\s+auf\s+[„"`*]*done/i

const clean = (s: string) =>
  s
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

export function isFromFlow(c: Pick<Comment, 'author_type' | 'author_id'>, flowUserId: string): boolean {
  return c.author_type === 'member' && c.author_id === flowUserId
}

export function questionHash(frage: string, optionen: Option[]): string {
  return createHash('sha256')
    .update(JSON.stringify([clean(frage).toLowerCase(), optionen.map((o) => o.code + clean(o.text).toLowerCase())]))
    .digest('hex')
    .slice(0, 16)
}

/** Text of the "## Entscheidung" block: from the heading to the next "## " heading. */
function blockText(md: string): string | null {
  const m = BLOCK_RE.exec(md)
  if (!m) return null
  const rest = md.slice(m.index + m[0].length)
  const next = rest.search(/^##\s/m)
  return next >= 0 ? rest.slice(0, next) : rest
}

/** Fields of the workspace "## Entscheidung" block (Zu entscheiden, Empfehlung, Option A/B/...). */
export function parseBlock(block: string): Omit<Question, 'source' | 'doneAfterAnswer' | 'hash'> | null {
  const field = (name: string) => {
    const m = new RegExp(`^\\s*\\*\\*${name}:?\\*\\*:?\\s*(.+)$`, 'im').exec(block)
    return m ? clean(m[1]) : null
  }
  const optionen: Option[] = []
  for (const m of block.matchAll(/^\s*(?:[-*]\s*)?\*\*Option\s+([A-E])(?:\s*\([^)]*\))?:?\*\*:?\s*(.+)$/gim)) {
    const code = m[1].toLowerCase()
    if (!optionen.some((o) => o.code === code)) optionen.push({ code, label: m[1].toUpperCase(), text: cap(clean(m[2]), MAX_OPTION) })
  }
  let frage = field('Zu entscheiden')
  if (!frage) {
    // A free-form block ("## Entscheidung fl0w"): its first prose line is the question.
    const line = block
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^\*\*(Empfehlung|Option|Für dich zu tun|Worum es geht)/i.test(l) && !l.startsWith('|'))
    frage = line ? clean(line.replace(/^[-*]\s*/, '')) : null
  }
  if (!frage) return null
  const empfehlung = field('Empfehlung')
  return { frage: cap(frage, MAX_FRAGE), empfehlung: empfehlung ? cap(empfehlung, MAX_EMPFEHLUNG) : null, optionen }
}

/** "Frage: ..." style (MS-4276): question line, "(a) ..." option lines, "Empfehlung: ..." line. */
export function parseFrageStyle(md: string): Omit<Question, 'source' | 'doneAfterAnswer' | 'hash'> | null {
  const m = FRAGE_LINE_RE.exec(md)
  if (!m) return null
  let frage = clean(m[1])
  if (!frage) {
    const after = md.slice(m.index + m[0].length).split('\n').map((l) => l.trim()).find(Boolean)
    frage = after ? clean(after) : ''
  }
  if (!frage) return null
  const optionen: Option[] = []
  for (const o of md.matchAll(/^\s*(?:[-*]\s*)?\(([a-e])\)\s+(.+)$/gim)) {
    const code = o[1].toLowerCase()
    if (!optionen.some((x) => x.code === code)) optionen.push({ code, label: `(${code})`, text: cap(clean(o[2]), MAX_OPTION) })
  }
  // Only a run that starts at (a) counts; a stray "(c)" in prose is not an option list.
  if (optionen[0]?.code !== 'a') optionen.length = 0
  const e = /^\s*(?:[-*]\s*)?(?:\*\*)?Empfehlung(?:\*\*)?:(?:\*\*)?\s*(.+)$/im.exec(md)
  return { frage: cap(frage, MAX_FRAGE), empfehlung: e ? cap(clean(e[1]), MAX_EMPFEHLUNG) : null, optionen }
}

function titleQuestion(title: string): string {
  return clean(title.replace(/^\s*(?:\S{1,4}\s+)?Entscheidung(?:\s+(?:für\s+)?fl0w)?\s*[:\-–]?\s*/i, '')) || clean(title)
}

function finish(q: Omit<Question, 'source' | 'doneAfterAnswer' | 'hash'>, source: Source, doneText: string): Question {
  return { ...q, source, doneAfterAnswer: DONE_RE.test(doneText), hash: questionHash(q.frage, q.optionen) }
}

/** Whether a card can carry a decision at all; cheap pre-filter before comments are read. */
export function isCandidate(issue: Pick<Issue, 'title' | 'description' | 'status'>): boolean {
  if (!(OPEN_STATUSES as readonly string[]).includes(issue.status)) return false
  if (issue.status === 'blocked') return true
  const d = issue.description ?? ''
  return TITLE_RE.test(issue.title) || FRAGE_LINE_RE.test(d) || BLOCK_RE.test(d)
}

/**
 * The question a card asks fl0w right now, or null.
 * `comments` are all comments of the card, oldest first.
 */
export function extractQuestion(
  issue: Pick<Issue, 'title' | 'description' | 'status'>,
  comments: Pick<Comment, 'author_type' | 'author_id' | 'content'>[],
  flowUserId: string,
): Question | null {
  if (!isCandidate(issue)) return null
  const last = comments.at(-1)
  if (last && isFromFlow(last, flowUserId)) return null
  const d = issue.description ?? ''

  if (issue.status === 'blocked' && last?.author_type === 'agent') {
    const block = blockText(last.content)
    const q = block ? parseBlock(block) : null
    if (q) return finish(q, 'kommentar', `${last.content}\n${d}`)
  }
  const titled = TITLE_RE.test(issue.title)
  const block = blockText(d)
  const fromBlock = block ? parseBlock(block) : null
  if (fromBlock) return finish(fromBlock, 'beschreibung', d)
  const fromFrage = parseFrageStyle(d)
  if (fromFrage) return finish(fromFrage, 'beschreibung', d)
  if (titled) return finish({ frage: cap(titleQuestion(issue.title), MAX_FRAGE), empfehlung: null, optionen: [] }, 'titel', d)
  return null
}

/** A question handed in from outside (CLI `frage`), e.g. by the "model2star Jobs" daily loop. */
export function externalQuestion(frage: string, optionen: string[], empfehlung: string | null): Question {
  const opts = optionen
    .map((t) => clean(t))
    .filter(Boolean)
    .slice(0, 5)
    .map((text, i) => ({ code: String.fromCharCode(97 + i), label: String.fromCharCode(65 + i), text: cap(text, MAX_OPTION) }))
  const f = cap(clean(frage), MAX_FRAGE)
  return { frage: f, empfehlung: empfehlung ? cap(clean(empfehlung), MAX_EMPFEHLUNG) : null, optionen: opts, source: 'extern', doneAfterAnswer: false, hash: questionHash(f, opts) }
}

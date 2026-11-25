// Messages, buttons, answer parsing and the Multica comment of the decision bot (MS-4379).
// Wording and comment format follow the "model2star Jobs" bot (MS-4373).
import type { Option } from './detect.ts'

export const BOT_NAME = '@multicafl0wbot'
const BERLIN = 'Europe/Berlin'
const berlinFmt = new Intl.DateTimeFormat('de-DE', { timeZone: BERLIN, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** "25.11.2026, 15:40" */
export const berlin = (ms: number) => berlinFmt.format(new Date(ms))

/** Midnight-independent "tomorrow 09:00 Berlin" as epoch ms: when a postponed question comes back. */
export function tomorrowNine(nowMs: number): number {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: BERLIN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs + 24 * 3_600_000))
  // 09:00 Berlin is 07:00 or 08:00 UTC; pick the UTC hour whose Berlin hour is 9.
  for (const utc of [7, 8]) {
    const t = Date.parse(`${day}T0${utc}:00:00Z`)
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: BERLIN, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t))
    if (h === '09') return t
  }
  return Date.parse(`${day}T08:00:00Z`)
}

export type AnswerKind = 'ja' | 'nein' | 'option' | 'bemerkung'
export type Via = 'knopf' | 'text'

export interface AskedQuestion {
  identifier: string
  project: string | null
  frage: string
  empfehlung: string | null
  optionen: Option[]
  quelle: string | null
}

export interface Answer {
  kind: AnswerKind
  option: string | null
  bemerkung: string | null
}

const YES = /^(ja|jo|jep|jap|yes|ok|okay|passt|einverstanden|gerne|klar|mach das|mach)\b/i
const NO = /^(nein|nee|nö|no|lieber nicht|nicht)\b/i
// A letter followed by punctuation that runs into a word ("E-Mail", "D.h.") starts a word, not an option.
const OPTION = /^(?:option\s+)?\(?([a-e])\)?(?=$|\s|[,.;:!?\-](?!\p{L}))/iu
const MAX_BEMERKUNG = 2000

const rest = (t: string, n: number) => t.slice(n).replace(/^[\s,.;:!?)\-]+/, '').trim() || null

/**
 * A free text answer is never rejected: "ja"/"ok" → Ja, "nein" → Nein, "a"/"Option B" → option
 * (only letters the card offers), anything else → Bemerkung. Text after the keyword is the Bemerkung.
 */
export function parseTextAnswer(text: string, optionen: Pick<Option, 'code'>[]): Answer {
  const t = text.trim().slice(0, MAX_BEMERKUNG)
  const o = OPTION.exec(t)
  // "a" alone or "Option a": a bare German word starting with a letter (e.g. "aber") never matches.
  if (o && optionen.some((x) => x.code === o[1].toLowerCase())) return { kind: 'option', option: o[1].toLowerCase(), bemerkung: rest(t, o[0].length) }
  for (const [re, kind] of [[YES, 'ja'], [NO, 'nein']] as const) {
    const m = re.exec(t)
    if (m) return { kind, option: null, bemerkung: rest(t, m[0].length) }
  }
  return { kind: 'bemerkung', option: null, bemerkung: t || null }
}

export function optionLabel(optionen: Option[], code: string): string {
  return optionen.find((o) => o.code === code)?.label ?? `Option ${code.toUpperCase()}`
}

/** "Ja", "Nein", "Option (a): nur Agentur-Konten …", "Bemerkung". */
export function answerHead(q: Pick<AskedQuestion, 'optionen'>, a: Pick<Answer, 'kind' | 'option'>): string {
  if (a.kind === 'ja') return 'Ja'
  if (a.kind === 'nein') return 'Nein'
  if (a.kind === 'bemerkung') return 'Bemerkung'
  const o = q.optionen.find((x) => x.code === a.option)
  const label = optionLabel(q.optionen, a.option ?? '?')
  const named = label.startsWith('Option') ? label : `Option ${label}`
  return o ? `${named}: ${o.text}` : named
}

export function header(q: Pick<AskedQuestion, 'identifier' | 'project'>): string {
  return `Entscheidung für ${q.identifier}${q.project ? ` (${q.project})` : ''}`
}

/** The question message (plain text, no parse mode). */
export function questionText(q: AskedQuestion): string {
  const lines = [header(q), '', q.frage]
  if (q.empfehlung) lines.push('', `Empfehlung: ${q.empfehlung}`)
  if (q.optionen.length) lines.push('', ...q.optionen.map((o) => `${o.label} ${o.text}`))
  if (q.quelle) lines.push('', `Gefragt von: ${q.quelle}`)
  const letters = q.optionen.map((o) => o.code).join(', ')
  lines.push('', `Antwort per Knopf oder als Text (ja, nein${letters ? `, ${letters}` : ''} oder ein Satz).`)
  return lines.join('\n').slice(0, 4000)
}

export type Button = { text: string; callback_data: string } | { text: string; url: string }

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

export function questionKeyboard(id: number, q: Pick<AskedQuestion, 'optionen'>, link: string): Button[][] {
  const rows: Button[][] = [
    [
      { text: 'Ja', callback_data: `a:${id}:j` },
      { text: 'Nein', callback_data: `a:${id}:n` },
      { text: 'Bemerkung', callback_data: `b:${id}` },
    ],
  ]
  for (const o of q.optionen) rows.push([{ text: short(`${o.label} ${o.text}`, 48), callback_data: `a:${id}:o${o.code}` }])
  rows.push([
    { text: 'Später', callback_data: `s:${id}` },
    { text: 'Karte öffnen', url: link },
  ])
  return rows
}

export function confirmKeyboard(id: number, link: string): Button[][] {
  return [[{ text: 'Bemerkung nachschieben', callback_data: `b:${id}` }, { text: 'Karte öffnen', url: link }]]
}

export function answerLine(q: Pick<AskedQuestion, 'optionen'>, a: Answer): string {
  const head = answerHead(q, a)
  if (a.kind === 'bemerkung') return `Bemerkung: „${a.bemerkung ?? ''}“`
  return a.bemerkung ? `${head}, Bemerkung: „${a.bemerkung}“` : head
}

export function confirmText(q: AskedQuestion, a: Answer, graceSec: number): string {
  const wann = graceSec >= 60 ? `in ${Math.round(graceSec / 60)} Minuten` : `in ${graceSec} Sekunden`
  return [
    `Verstanden für ${q.identifier}: ${answerLine(q, a)}.`,
    `Frage: ${q.frage}`,
    '',
    `Das geht ${wann} als Kommentar an die Karte. Eine Bemerkung dazu kannst du bis dahin und auch danach nachschieben: Knopf „Bemerkung nachschieben“ oder einfach auf diese Nachricht antworten.`,
  ].join('\n')
}

/** Multica comment, same shape as the "model2star Jobs" bot (MS-4373). */
export function commentText(q: AskedQuestion, a: Answer, via: Via, answeredAtMs: number): string {
  const lines = [
    `Antwort von fl0w per Telegram (Bot ${BOT_NAME}, ${berlin(answeredAtMs)} Uhr Berlin, per ${via === 'knopf' ? 'Knopf' : 'Text'}): **${answerHead(q, a)}**`,
    '',
    `Frage: ${q.frage}`,
  ]
  if (a.bemerkung) lines.push(`Bemerkung: ${a.bemerkung}`)
  return lines.join('\n')
}

export function nachtragText(q: Pick<AskedQuestion, 'frage'>, bemerkung: string, atMs: number): string {
  return `Nachtrag von fl0w per Telegram (Bot ${BOT_NAME}, ${berlin(atMs)} Uhr Berlin, per Text) zur Entscheidung oben.\n\nFrage: ${q.frage}\nBemerkung: ${bemerkung}`
}

export const NONE_OPEN_TEXT = 'Gerade ist keine Entscheidung offen, auf die sich deine Nachricht beziehen kann. /offen zeigt alle offenen Entscheidungen.'
export const HELP_TEXT = [
  'Hier kommen alle Entscheidungen aus Multica an, eine Nachricht je Karte.',
  'Antworten: per Knopf oder als Text (ja, nein, ok, a, b oder ein Satz). Ein Text gilt für die Frage, auf die du antwortest, sonst für die zuletzt gestellte.',
  '„Später“ stellt die Frage morgen um 9 Uhr noch einmal.',
  '/offen zeigt alle offenen Entscheidungen.',
].join('\n')

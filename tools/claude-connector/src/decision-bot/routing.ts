// Where the decision bot posts questions and what happens to them after the answer
// (MS-4379, prepared for the private group with topics of MS-4383). Stored in the bot's
// SQLite state (kv "ziel"), so `decision-bot-main.ts ziel ...` takes effect on the next
// send without a restart.
import type { Store } from './store.ts'
import type { Target } from './telegram.ts'

/** behalten: message stays, buttons gone; loeschen: question and confirmation deleted; verschieben: summary into `beantwortet`, originals deleted. */
export type AfterAnswer = 'behalten' | 'loeschen' | 'verschieben'
export const AFTER_ANSWER: readonly AfterAnswer[] = ['behalten', 'loeschen', 'verschieben']

export interface Routing {
  /** Chat and topic for new questions; null = fl0w's private chat. */
  fragen: Target | null
  nachAntwort: AfterAnswer
  /** Target for "verschieben" (e.g. the topic "Beantwortet"). */
  beantwortet: Target | null
}

export const DEFAULT_ROUTING: Routing = { fragen: null, nachAntwort: 'behalten', beantwortet: null }
const KEY = 'ziel'

const isChat = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n !== 0
const isThread = (n: unknown): n is number | null => n === null || (typeof n === 'number' && Number.isSafeInteger(n) && n > 0)

/** Throws with a German sentence when the setting cannot work. */
export function validateRouting(r: Routing): Routing {
  for (const [name, t] of [['fragen', r.fragen], ['beantwortet', r.beantwortet]] as const) {
    if (t === null) continue
    if (!isChat(t.chat)) throw new Error(`Ziel ${name}: Chat-ID muss eine ganze Zahl ungleich 0 sein (Gruppen beginnen mit -100).`)
    if (!isThread(t.thread)) throw new Error(`Ziel ${name}: Thema muss eine positive ganze Zahl sein.`)
  }
  if (!AFTER_ANSWER.includes(r.nachAntwort)) throw new Error(`Nach der Antwort: erlaubt sind ${AFTER_ANSWER.join(', ')}.`)
  if (r.nachAntwort === 'verschieben' && !r.beantwortet) throw new Error('„verschieben“ braucht ein Ziel für beantwortete Fragen (--beantwortet-thema, ggf. --beantwortet-chat).')
  return r
}

export function readRouting(store: Store): Routing {
  const raw = store.getKv(KEY)
  if (!raw) return DEFAULT_ROUTING
  try {
    return validateRouting({ ...DEFAULT_ROUTING, ...(JSON.parse(raw) as Partial<Routing>) })
  } catch {
    // A broken setting must never stop the questions: fl0w's private chat always works.
    return DEFAULT_ROUTING
  }
}

export function writeRouting(store: Store, r: Routing): Routing {
  store.setKv(KEY, JSON.stringify(validateRouting(r)))
  return r
}

export interface RoutingFlags {
  chat?: string
  thema?: string
  nachAntwort?: string
  beantwortetChat?: string
  beantwortetThema?: string
  privat?: boolean
}

const num = (s: string, what: string): number => {
  const n = Number(s.trim())
  if (!Number.isSafeInteger(n)) throw new Error(`${what}: „${s}“ ist keine ganze Zahl.`)
  return n
}

/**
 * Apply CLI flags to the current setting. `privat` resets everything to fl0w's private chat.
 * `--beantwortet-thema` alone uses the chat of the questions (topics of the same group).
 */
export function applyFlags(cur: Routing, f: RoutingFlags): Routing {
  if (f.privat) return DEFAULT_ROUTING
  const next: Routing = { ...cur }
  if (f.chat !== undefined) next.fragen = { chat: num(f.chat, 'Chat'), thread: null }
  if (f.thema !== undefined) {
    if (!next.fragen) throw new Error('Ein Thema braucht eine Chat-ID (--chat).')
    next.fragen = { ...next.fragen, thread: f.thema === '' || f.thema === 'keins' ? null : num(f.thema, 'Thema') }
  }
  if (f.nachAntwort !== undefined) next.nachAntwort = f.nachAntwort as AfterAnswer
  if (f.beantwortetChat !== undefined || f.beantwortetThema !== undefined) {
    const chat = f.beantwortetChat !== undefined ? num(f.beantwortetChat, 'Chat für beantwortete Fragen') : (cur.beantwortet?.chat ?? next.fragen?.chat)
    if (chat === undefined) throw new Error('Ziel für beantwortete Fragen braucht eine Chat-ID (--beantwortet-chat oder --chat).')
    const thread = f.beantwortetThema !== undefined ? (f.beantwortetThema === 'keins' ? null : num(f.beantwortetThema, 'Thema für beantwortete Fragen')) : (cur.beantwortet?.thread ?? null)
    next.beantwortet = { chat, thread }
  }
  return validateRouting(next)
}

// Decision bot @multicafl0wbot (MS-4379), started by the LaunchAgent
// com.fl0w.multica-decision-bot. Without a token it waits and checks the secret
// file every minute, so the bot goes live by itself once fl0w has uploaded it.
//
//   node src/decision-bot-main.ts                       service (long polling, scan every 2 min)
//   node src/decision-bot-main.ts frage <Karte> "<Frage>" [--option "<Text>"]... [--empfehlung "<Text>"] [--quelle "<Wer fragt>"]
//       hands a question to the running bot. Exit 0 = the bot takes it, 4 = bot not live (caller keeps its own way).
//   node src/decision-bot-main.ts status                live, token, open questions
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MulticaApi } from './multica.ts'
import { DecisionBot } from './decision-bot/bot.ts'
import { Store } from './decision-bot/store.ts'
import { TelegramApi, TelegramError } from './decision-bot/telegram.ts'

const env = process.env
const home = homedir()
const stateDir = env.DECISION_BOT_STATE?.trim() || join(home, '.local/state/multica-decision-bot')
const tokenFile = env.DECISION_BOT_TOKEN_FILE?.trim() || join(home, '.secrets/multicafl0wbot-token')
const chatFile = env.DECISION_BOT_CHAT_ID_FILE?.trim() || join(home, '.secrets/telegram_chat_id')
const multicaUrl = (env.MULTICA_API_URL?.trim() || 'http://localhost:8080').replace(/\/+$/, '')
const workspaceId = env.MULTICA_WORKSPACE_ID?.trim() || '50b08bfb-a5fe-426f-b012-5da67a25d153'
const flowUserId = env.DECISION_BOT_FLOW_USER_ID?.trim() || '46ece536-d531-4ef9-a493-be97b0118e06'
const appUrl = (env.DECISION_BOT_APP_URL?.trim() || 'https://macbook-air-von-fl0w.taildc41c0.ts.net:8446').replace(/\/+$/, '')
const slug = env.DECISION_BOT_WORKSPACE_SLUG?.trim() || 'm2s'
const goLiveCard = env.DECISION_BOT_GOLIVE_CARD?.trim() || ''
const scanMs = Number(env.DECISION_BOT_SCAN_SEC ?? 120) * 1000
const graceMs = Number(env.DECISION_BOT_GRACE_SEC ?? 120) * 1000
const telegramUrl = (env.DECISION_BOT_TELEGRAM_URL?.trim() || 'https://api.telegram.org').replace(/\/+$/, '')
const multicaTokenFile = env.MULTICA_TOKEN_FILE?.trim() || join(home, '.multica/profiles/desktop-localhost-8080/config.json')
/** Touched on every poll; callers treat the bot as live while it is younger than this. */
const LIVE_FILE = join(stateDir, 'live')
const LIVE_MAX_AGE_MS = 10 * 60_000

mkdirSync(stateDir, { recursive: true, mode: 0o700 })
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`)

function readMulticaToken(): string {
  const t = (JSON.parse(readFileSync(multicaTokenFile, 'utf8')) as { token?: string }).token
  if (!t) throw new Error(`kein token in ${multicaTokenFile}`)
  return t
}

/** The token file may hold the bare token or a line like TELEGRAM_BOT_TOKEN=...; take the token pattern. */
export function readBotToken(path = tokenFile): string | null {
  if (!existsSync(path)) return null
  const m = /\d{6,}:[A-Za-z0-9_-]{30,}/.exec(readFileSync(path, 'utf8'))
  return m ? m[0] : null
}

function readChatId(): number {
  const n = Number(readFileSync(chatFile, 'utf8').trim())
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`keine Chat-ID in ${chatFile}`)
  return n
}

function isLive(): boolean {
  try {
    return Date.now() - statSync(LIVE_FILE).mtimeMs < LIVE_MAX_AGE_MS
  } catch {
    return false
  }
}

function touchLive(username: string): void {
  if (!existsSync(LIVE_FILE)) writeFileSync(LIVE_FILE, `${username}\n`, { mode: 0o600 })
  const now = new Date()
  utimesSync(LIVE_FILE, now, now)
}

/** Alarm intake of the workspace (same as the connector watchdog). true = delivered. */
function alarm(text: string, resolved: boolean): boolean {
  const intake = env.ALARM_INTAKE?.trim() || join(home, '.claude/scripts/alarm-digest.py')
  if (!existsSync(intake)) return false
  const args = [intake, 'melden', 'multica-decision-bot', 'senden-abgelehnt', text, '--objekt', 'telegram', '--schwere', 'warning', '--project', 'Multica', ...(resolved ? ['--geloest'] : [])]
  const r = spawnSync('/usr/bin/python3', args, { encoding: 'utf8', timeout: 60_000 })
  log(`alarm ${resolved ? 'geloest' : 'gemeldet'}: exit ${r.status}`)
  return r.status === 0
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const board = () => new MulticaApi(fetch, multicaUrl, workspaceId, readMulticaToken())
const link = (identifier: string) => `${appUrl}/${encodeURIComponent(slug)}/issues/${encodeURIComponent(identifier)}`

function makeBot(tg: TelegramApi | null, store: Store): DecisionBot {
  const none = async () => {
    throw new Error('kein Telegram in diesem Aufruf')
  }
  return new DecisionBot({
    board,
    tg: tg ?? { send: none, edit: none, answerCallback: none },
    store,
    ownerChatId: tg ? readChatId() : 0,
    flowUserId,
    link,
    graceMs,
    log,
    onLive: async (open) => {
      if (!goLiveCard) return
      // The fl0w mention keeps the comment from starting a run of the card's agent.
      await board().addComment(goLiveCard, `[@fl0w](mention://member/${flowUserId}) Der Entscheidungs-Bot @multicafl0wbot ist live: Die Begrüßung ist in deinem Telegram-Chat angekommen, ${open} offene Entscheidungen gehen jetzt als eigene Nachrichten raus.`)
    },
  })
}

async function serve(): Promise<void> {
  const store = new Store(join(stateDir, 'bot.db'))
  let waitingLogged = false
  for (;;) {
    const token = readBotToken()
    if (!token) {
      if (!waitingLogged) log(`warte auf den Token in ${tokenFile}`)
      waitingLogged = true
      await sleep(60_000)
      continue
    }
    const tg = new TelegramApi(token, telegramUrl)
    let me
    try {
      me = await tg.getMe()
      await tg.deleteWebhook()
      await tg.setCommands().catch(() => {})
    } catch (err) {
      log(`token abgelehnt oder Telegram nicht erreichbar: ${(err as Error).message}`)
      await sleep(60_000)
      continue
    }
    waitingLogged = false
    log(`live als @${me.username}`)
    touchLive(me.username ?? '')
    const bot = makeBot(tg, store)

    // One worker: polling, scan and flush never touch the same question concurrently.
    let chain: Promise<unknown> = Promise.resolve()
    const serial = (what: string, fn: () => Promise<unknown>) => {
      chain = chain.then(fn).catch((err) => log(`fehler ${what}: ${(err as Error).message}`))
      return chain
    }
    const scanTick = () => serial('scan', async () => {
      const r = await bot.scan()
      if (r.added || r.closed) log(`scan: ${r.added} neu, ${r.closed} erledigt`)
      await bot.sendDue()
    })
    let alarmed = false
    const flushTick = () => serial('flush', async () => {
      await bot.flush()
      await bot.sendDue()
      // Telegram refuses for 30 minutes (e.g. fl0w never pressed Start): alarm intake, once; resolved when it works again.
      const h = bot.sendHealth()
      if (h && !alarmed && Date.now() - h.since > 30 * 60_000) {
        alarmed = alarm(`Entscheidungs-Bot @multicafl0wbot kann fl0w seit 30 Minuten nicht schreiben: ${h.error}. Steht dort "can't initiate conversation", in Telegram den Bot @multicafl0wbot öffnen und Start tippen.`, false)
      } else if (!h && alarmed) {
        alarmed = !alarm('Entscheidungs-Bot @multicafl0wbot schreibt fl0w wieder.', true)
      }
    })
    void scanTick()
    const timers = [setInterval(scanTick, scanMs), setInterval(flushTick, 15_000)]

    let offset = Number(store.getKv('offset') ?? 0)
    let stop = false
    while (!stop) {
      try {
        const updates = await tg.getUpdates(offset, 30)
        touchLive(me.username ?? '')
        for (const u of updates) {
          offset = u.update_id + 1
          store.setKv('offset', String(offset))
          await serial('update', () => bot.handle(u))
        }
      } catch (err) {
        if (err instanceof TelegramError && err.code === 401) {
          log('token ungültig geworden, warte auf einen neuen')
          stop = true
        } else {
          log(`getUpdates: ${(err as Error).message}`)
          await sleep(err instanceof TelegramError && err.code === 409 ? 30_000 : 5_000)
        }
      }
    }
    timers.forEach(clearInterval)
    await chain
    await sleep(60_000)
  }
}

function flag(args: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}` && args[i + 1] !== undefined) out.push(args[++i])
  return out
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd || cmd === 'server') return serve()
  if (cmd === 'status') {
    const store = new Store(join(stateDir, 'bot.db'))
    const rows = store.inState('neu', 'gesendet', 'spaeter', 'beantwortet')
    console.log(JSON.stringify({ live: isLive(), token: !!readBotToken(), offen: rows.map((r) => ({ id: r.id, karte: r.identifier, state: r.state, frage: r.frage.slice(0, 80) })) }, null, 2))
    return
  }
  if (cmd === 'frage') {
    const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
    const [karte, frage] = positional
    if (!karte || !frage) throw new Error('Aufruf: frage <Karte> "<Frage>" [--option "<Text>"]... [--empfehlung "<Text>"] [--quelle "<Wer>"]')
    if (!isLive()) {
      console.error('Bot @multicafl0wbot ist nicht live, Frage nicht übernommen.')
      process.exit(4)
    }
    const store = new Store(join(stateDir, 'bot.db'))
    const r = await makeBot(null, store).addExternal(karte, frage, flag(args, 'option'), flag(args, 'empfehlung')[0] ?? null, flag(args, 'quelle')[0] ?? null)
    console.log(r.added ? `Frage für ${r.identifier} übernommen, sie geht binnen einer Minute an fl0w (@multicafl0wbot).` : `Dieselbe Frage für ${r.identifier} gab es schon, nicht erneut gestellt.`)
    return
  }
  throw new Error(`unbekannter Befehl ${cmd}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error((err as Error).message)
    process.exit(1)
  })
}

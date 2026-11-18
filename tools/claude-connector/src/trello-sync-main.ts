// Multica -> Trello mirror daemon (MS-3182), started by the LaunchAgent
// com.fl0w.multica-trello-sync. Listens on the Multica WebSocket for issue and
// comment events of the mirrored projects and pushes the affected card a few
// seconds later. A full pass runs at start (initial sync) and every
// TRELLO_SYNC_RECONCILE_MIN minutes, so a missed event heals on its own.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MulticaApi } from './multica.ts'
import { NetError } from './net-retry.ts'
import { loadSyncFile, syncEnv } from './trello/config.ts'
import { Outage } from './trello/outage.ts'
import { Sync, SyncStore, type WsFrame, openSyncDb, relevantIssue } from './trello/sync.ts'
import { Trello, readTrelloCreds } from './trello/trello.ts'

const env = syncEnv()
const multicaUrl = (process.env.MULTICA_API_URL?.trim() || 'http://localhost:8080').replace(/\/+$/, '')
const workspaceId = process.env.MULTICA_WORKSPACE_ID?.trim()
if (!workspaceId) throw new Error('MULTICA_WORKSPACE_ID fehlt')
// The CLI profile of the local daemon holds fl0w's personal access token; it is
// read on every use so a renewed token is picked up without a restart.
const tokenFile = process.env.MULTICA_TOKEN_FILE?.trim() || join(homedir(), '.multica/profiles/desktop-localhost-8080/config.json')
const readToken = () => {
  const t = (JSON.parse(readFileSync(tokenFile, 'utf8')) as { token?: string }).token
  if (!t) throw new Error(`kein token in ${tokenFile}`)
  return t
}
const reconcileMs = Number(process.env.TRELLO_SYNC_RECONCILE_MIN ?? 10) * 60_000
const DEBOUNCE_MS = 3_000
// A pass cut short by a request without response is repeated after this delay.
const CATCH_UP_MS = 60_000
// Only a stretch without response longer than this counts as an error.
const OUTAGE_ERROR_MS = 30 * 60_000

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`)
const file = loadSyncFile(env.syncFile)
const store = new SyncStore(openSyncDb(env.syncDb))
const sync = new Sync({
  api: () => new MulticaApi(fetch, multicaUrl, workspaceId, readToken()),
  trello: new Trello(fetch, () => readTrelloCreds(env.trelloEnvFile)),
  store,
  pairs: file.pairs,
  multicaWebUrl: file.multicaWebUrl,
  log,
})

// One worker: events and full passes never push the same card concurrently.
const pending = new Set<string>()
let timer: NodeJS.Timeout | null = null
let chain: Promise<unknown> = Promise.resolve()
const serial = (fn: () => Promise<void>) => {
  chain = chain.then(fn, fn).catch((err) => log(`fehler: ${(err as Error).message}`))
  return chain
}

const outage = new Outage(OUTAGE_ERROR_MS)
let catchUp: NodeJS.Timeout | null = null

/** A request got no response: the full pass after CATCH_UP_MS pushes every card again. */
function netFailed(what: string, err: NetError): void {
  const { error, minutes } = outage.failed(Date.now())
  if (error) log(`fehler bei ${what}: seit ${minutes} min keine Antwort, ${err.message}`)
  else log(`verschoben (${what}): ${err.message}; neuer abgleich in ${CATCH_UP_MS / 1000} s`)
  if (!catchUp) {
    catchUp = setTimeout(() => {
      catchUp = null
      void reconcileAll('nachholen')
    }, CATCH_UP_MS)
  }
}

function enqueue(issueId: string): void {
  pending.add(issueId)
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const ids = [...pending]
    pending.clear()
    void serial(async () => {
      for (const id of ids) {
        try {
          await sync.pushIssue(id)
        } catch (err) {
          if (err instanceof NetError) {
            netFailed(id, err)
            return
          }
          log(`fehler bei ${id}: ${(err as Error).message}`)
        }
      }
    })
  }, DEBOUNCE_MS)
}

// A queued pass that has not started yet covers every later request, so
// reconnects in quick succession (WebSocket flapping under load) queue one pass.
let passQueued = false
async function reconcileAll(reason: string): Promise<void> {
  if (passQueued) return
  passQueued = true
  await serial(async () => {
    passQueued = false
    for (const pair of file.pairs) {
      const t0 = Date.now()
      try {
        const c = await sync.reconcile(pair)
        log(`abgleich ${pair.projectName} (${reason}, ${Date.now() - t0} ms): ${JSON.stringify(c)}`)
      } catch (err) {
        if (!(err instanceof NetError)) throw err
        netFailed(`abgleich ${pair.projectName}`, err)
        return
      }
    }
    const minutes = outage.recovered(Date.now())
    if (minutes !== null) log(`wieder erreichbar: verschobenes nach ${minutes} min nachgeholt`)
  })
}

const projectIds = new Set(file.pairs.map((p) => p.projectId))

let backoff = 1_000
function connect(): void {
  const url = `${multicaUrl.replace(/^http/, 'ws')}/ws?workspace_id=${workspaceId}`
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch (err) {
    log(`ws: ${(err as Error).message}`)
    setTimeout(connect, backoff)
    return
  }
  let authed = false
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', payload: { token: readToken() } })))
  ws.addEventListener('message', (ev) => {
    let f: WsFrame
    try {
      f = JSON.parse(String(ev.data)) as WsFrame
    } catch {
      return
    }
    if (!authed) {
      if (f.type === 'auth_ack' || f.type === 'auth_ok' || !f.type?.startsWith('auth')) {
        authed = true
        backoff = 1_000
        log('ws: verbunden')
        // Events may have been missed while disconnected.
        void reconcileAll('wiederverbunden')
      } else {
        log(`ws: anmeldung abgelehnt (${f.type})`)
        ws.close()
        return
      }
    }
    const id = relevantIssue(f, projectIds, (i) => !!store.byIssue(i))
    if (id) enqueue(id)
  })
  ws.addEventListener('close', () => {
    log(`ws: getrennt, neuer versuch in ${backoff / 1000} s`)
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 60_000)
  })
  ws.addEventListener('error', () => {
    // close follows
  })
}

log(`start: ${file.pairs.map((p) => `${p.projectName} -> ${p.board}`).join(', ')}`)
connect()
setInterval(() => void reconcileAll('intervall'), reconcileMs)
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0))

// Entry point, started by the LaunchAgent com.fl0w.multica-claude-connector.
import { loadConfig } from './config.ts'
import { createApp } from './http.ts'
import { openDb, systemClock } from './store.ts'
import type { TrelloDeps } from './tools.ts'
import { loadSyncFile, syncEnv } from './trello/config.ts'
import { SyncStore, openSyncDb } from './trello/sync.ts'
import { Trello, readTrelloCreds } from './trello/trello.ts'

const config = loadConfig()
const db = openDb(config.dbPath)

// The pull shares the mirror's state (card links, comment ids) with the sync daemon.
function trelloDeps(): TrelloDeps | undefined {
  const env = syncEnv()
  try {
    const file = loadSyncFile(env.syncFile)
    return {
      trello: new Trello(fetch, () => readTrelloCreds(env.trelloEnvFile)),
      store: new SyncStore(openSyncDb(env.syncDb)),
      pairs: file.pairs,
      multicaWebUrl: file.multicaWebUrl,
    }
  } catch (err) {
    console.log(`connector: trello_pull aus (${(err as Error).message})`)
    return undefined
  }
}

const server = createApp({ config, db, now: systemClock, fetch, trello: trelloDeps() })

server.listen(config.port, config.host, () => {
  console.log(`connector: listening on http://${config.host}:${config.port}, public ${config.publicUrl}/mcp`)
})

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
  })
}

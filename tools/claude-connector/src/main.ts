// Entry point, started by the LaunchAgent com.fl0w.multica-claude-connector.
import { loadConfig } from './config.ts'
import { createApp } from './http.ts'
import { openDb, systemClock } from './store.ts'

const config = loadConfig()
const db = openDb(config.dbPath)
const server = createApp({ config, db, now: systemClock, fetch })

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

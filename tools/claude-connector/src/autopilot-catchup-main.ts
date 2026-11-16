// One catch-up pass for missed autopilot slots (MS-3771), started every ten
// minutes by the LaunchAgent com.fl0w.multica-autopilot-catchup.
// AUTOPILOT_CATCHUP_DRY_RUN=1 only logs what it would start.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { catchUpMissedSlots } from './autopilot-catchup.ts'
import { MulticaApi } from './multica.ts'

const url = (process.env.MULTICA_API_URL?.trim() || 'http://localhost:8080').replace(/\/+$/, '')
const workspaceId = process.env.MULTICA_WORKSPACE_ID?.trim()
if (!workspaceId) throw new Error('MULTICA_WORKSPACE_ID fehlt')
const tokenFile = process.env.MULTICA_TOKEN_FILE?.trim() || join(homedir(), '.multica/profiles/desktop-localhost-8080/config.json')
const token = (JSON.parse(readFileSync(tokenFile, 'utf8')) as { token?: string }).token
if (!token) throw new Error(`kein token in ${tokenFile}`)

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`)
const dryRun = process.env.AUTOPILOT_CATCHUP_DRY_RUN === '1'
const r = await catchUpMissedSlots(new MulticaApi(fetch, url, workspaceId, token), new Date(), log, dryRun)
if (r.started.length) log(`geprüft ${r.checked}, nachgeholt ${r.started.length}`)

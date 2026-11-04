// Project-to-board pairs for the Trello mirror (MS-3182). The file is
// trello-sync.json beside package.json; it holds no secrets.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const MIRRORED_STATUS = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'] as const

const pairSchema = z.object({
  /** Multica project id. */
  projectId: z.string().uuid(),
  /** Display name, used to find the pair by spoken project name. */
  projectName: z.string().min(1),
  /** Trello board short link or id. */
  board: z.string().min(1),
  /** Trello list name per Multica status; missing lists are created. Cancelled cards are archived. */
  lists: z.object(Object.fromEntries(MIRRORED_STATUS.map((s) => [s, z.string().min(1)])) as Record<(typeof MIRRORED_STATUS)[number], z.ZodString>),
  /** Optional: Multica member user id to Trello member id. Without entries the sync leaves card members alone. */
  members: z.record(z.string(), z.string()).default({}),
})

const fileSchema = z.object({
  /** Base of the back link on every card, e.g. https://host/m2s */
  multicaWebUrl: z.string().url(),
  pairs: z.array(pairSchema).min(1),
})

export type Pair = z.infer<typeof pairSchema>
export type SyncFile = z.infer<typeof fileSchema>

export function loadSyncFile(path: string): SyncFile {
  return fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

export interface SyncEnv {
  syncFile: string
  trelloEnvFile: string
  syncDb: string
}

export function syncEnv(env: NodeJS.ProcessEnv = process.env, appDir = join(import.meta.dirname, '..', '..')): SyncEnv {
  return {
    syncFile: env.TRELLO_SYNC_FILE?.trim() || join(appDir, 'trello-sync.json'),
    trelloEnvFile: env.TRELLO_ENV_FILE?.trim() || join(homedir(), '.secrets/trello-crm.env'),
    syncDb: env.TRELLO_SYNC_DB?.trim() || join(homedir(), '.local/state/multica-trello-sync/sync.db'),
  }
}

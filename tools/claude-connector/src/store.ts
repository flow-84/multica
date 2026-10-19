// SQLite state of the connector: OAuth clients, codes, tokens, grants and the
// audit log. One file under ~/.local/state, mode 0600.
//
// Only SHA-256 hashes of codes and tokens are stored. The one plaintext
// credential is the Multica session token of a grant (the JWT Multica issued
// when fl0w entered the login code); the connector needs it to call the API
// on fl0w's behalf. Revoking the grant deletes it.
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Clock = () => number

/** Seconds since epoch. */
export const systemClock: Clock = () => Math.floor(Date.now() / 1000)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  grant_id      TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  multica_token TEXT,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE TABLE IF NOT EXISTS codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  grant_id       TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id    TEXT NOT NULL,
  grant_id     TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens (grant_id);
CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  grant_id  TEXT,
  client_id TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  result    TEXT NOT NULL,
  detail    TEXT
);
`

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  if (path !== ':memory:') chmodSync(path, 0o600)
  return db
}

export interface AuditEntry {
  grantId?: string | null
  clientId?: string | null
  action: string
  target?: string | null
  result: 'ok' | 'fehler' | 'abgelehnt'
  detail?: Record<string, unknown>
}

export function audit(db: DatabaseSync, now: Clock, e: AuditEntry): void {
  db.prepare('INSERT INTO audit (at, grant_id, client_id, action, target, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    now(),
    e.grantId ?? null,
    e.clientId ?? null,
    e.action,
    e.target ?? null,
    e.result,
    e.detail ? JSON.stringify(e.detail) : null,
  )
}

// SQLite state of the decision bot (MS-4379), one file under ~/.local/state, mode 0600.
//
// Every question has one explicit state:
//   neu          detected, not yet in Telegram
//   gesendet     message with buttons is in Telegram (group topic Offen/Dringend, or fl0w's private chat)
//   spaeter      fl0w tapped "Später"; sent again once `snooze_until` has passed (in the group it waits in topic Später)
//   beantwortet  answer recorded, comment waits for the grace period (a Bemerkung can still join it);
//                `commented_at` set = comment is on the card, only the next step is still due
//   weitergegeben comment is on the card, next step triggered; a later Bemerkung goes as Nachtrag
//   erledigt     the card no longer asks (status, project paused, fl0w answered in Multica)
// The same question on the same card (issue_id + hash) exists once, so it is never asked twice.
// Where a message sits: `chat_key` 0 (or null) = fl0w's private chat, otherwise the group's chat id (MS-4383).
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Option, Source } from './detect.ts'
import type { AnswerKind, Via } from './texts.ts'

export type State = 'neu' | 'gesendet' | 'spaeter' | 'beantwortet' | 'weitergegeben' | 'erledigt'
export const ACTIVE: readonly State[] = ['neu', 'gesendet', 'spaeter']

export interface Row {
  id: number
  issue_id: string
  identifier: string
  project: string | null
  hash: string
  source: Source
  frage: string
  empfehlung: string | null
  optionen: Option[]
  quelle: string | null
  done_after_answer: boolean
  state: State
  created_at: number
  sent_at: number | null
  message_id: number | null
  snooze_until: number | null
  answer_kind: AnswerKind | null
  answer_option: string | null
  bemerkung: string | null
  via: Via | null
  answered_at: number | null
  last_input_at: number | null
  confirm_message_id: number | null
  commented_at: number | null
  posted_at: number | null
  next_step: string | null
  post_error: string | null
  post_alarm_at: number | null
  closed_reason: string | null
  priority: string | null
  chat_key: number | null
  thread_id: number | null
  confirm_chat: number | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS questions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id           TEXT NOT NULL,
  identifier         TEXT NOT NULL,
  project            TEXT,
  hash               TEXT NOT NULL,
  source             TEXT NOT NULL,
  frage              TEXT NOT NULL,
  empfehlung         TEXT,
  optionen           TEXT NOT NULL DEFAULT '[]',
  quelle             TEXT,
  done_after_answer  INTEGER NOT NULL DEFAULT 0,
  state              TEXT NOT NULL DEFAULT 'neu',
  created_at         INTEGER NOT NULL,
  sent_at            INTEGER,
  message_id         INTEGER,
  snooze_until       INTEGER,
  answer_kind        TEXT,
  answer_option      TEXT,
  bemerkung          TEXT,
  via                TEXT,
  answered_at        INTEGER,
  last_input_at      INTEGER,
  confirm_message_id INTEGER,
  commented_at       INTEGER,
  posted_at          INTEGER,
  next_step          TEXT,
  post_error         TEXT,
  post_alarm_at      INTEGER,
  closed_reason      TEXT,
  UNIQUE (issue_id, hash)
);
CREATE TABLE IF NOT EXISTS messages (
  chat_key    INTEGER NOT NULL DEFAULT 0,
  message_id  INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_key, message_id)
);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
/** Columns added after the first release; databases created before get them on open. */
const ADDED_COLUMNS = [
  ['commented_at', 'INTEGER'],
  ['priority', 'TEXT'],
  ['chat_key', 'INTEGER'],
  ['thread_id', 'INTEGER'],
  ['confirm_chat', 'INTEGER'],
] as const

type Raw = Record<string, unknown>

function norm(r: Raw | undefined): Row | null {
  if (!r) return null
  return {
    ...(r as unknown as Row),
    optionen: JSON.parse(String(r.optionen ?? '[]')) as Option[],
    done_after_answer: Number(r.done_after_answer) === 1,
  }
}

export class Store {
  readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
    const have = new Set((this.db.prepare('PRAGMA table_info(questions)').all() as { name: string }[]).map((c) => c.name))
    for (const [col, type] of ADDED_COLUMNS) if (!have.has(col)) this.db.exec(`ALTER TABLE questions ADD COLUMN ${col} ${type}`)
    // Message ids are only unique per chat; the first release keyed them alone (all in the private chat).
    const msgCols = new Set((this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name))
    if (!msgCols.has('chat_key')) {
      this.db.exec(`ALTER TABLE messages RENAME TO messages_v1;
        CREATE TABLE messages (chat_key INTEGER NOT NULL DEFAULT 0, message_id INTEGER NOT NULL, question_id INTEGER NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (chat_key, message_id));
        INSERT INTO messages SELECT 0, message_id, question_id, kind, created_at FROM messages_v1;
        DROP TABLE messages_v1;`)
    }
  }

  get(id: number): Row | null {
    return norm(this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Raw | undefined)
  }

  byKey(issueId: string, hash: string): Row | null {
    return norm(this.db.prepare('SELECT * FROM questions WHERE issue_id = ? AND hash = ?').get(issueId, hash) as Raw | undefined)
  }

  inState(...states: State[]): Row[] {
    const marks = states.map(() => '?').join(',')
    return (this.db.prepare(`SELECT * FROM questions WHERE state IN (${marks}) ORDER BY id`).all(...states) as Raw[]).map((r) => norm(r)!)
  }

  insert(q: Omit<Row, 'id' | 'state' | 'sent_at' | 'message_id' | 'snooze_until' | 'answer_kind' | 'answer_option' | 'bemerkung' | 'via' | 'answered_at' | 'last_input_at' | 'confirm_message_id' | 'commented_at' | 'posted_at' | 'next_step' | 'post_error' | 'post_alarm_at' | 'closed_reason' | 'chat_key' | 'thread_id' | 'confirm_chat'>): Row | null {
    const r = this.db
      .prepare(
        `INSERT INTO questions (issue_id, identifier, project, hash, source, frage, empfehlung, optionen, quelle, done_after_answer, created_at, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (issue_id, hash) DO NOTHING`,
      )
      .run(q.issue_id, q.identifier, q.project, q.hash, q.source, q.frage, q.empfehlung, JSON.stringify(q.optionen), q.quelle, q.done_after_answer ? 1 : 0, q.created_at, q.priority)
    return r.changes ? this.get(Number(r.lastInsertRowid)) : null
  }

  /** Update fields of one question; `from` guards the state transition (null = any state). */
  update(id: number, fields: Partial<Omit<Row, 'id'>>, from: State[] | null = null): boolean {
    const keys = Object.keys(fields)
    const vals = keys.map((k) => {
      const v = (fields as Record<string, unknown>)[k]
      if (k === 'optionen') return JSON.stringify(v)
      if (typeof v === 'boolean') return v ? 1 : 0
      return v === undefined ? null : (v as string | number | null)
    })
    let sql = `UPDATE questions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
    const args: (string | number | null)[] = [...vals, id]
    if (from) {
      sql += ` AND state IN (${from.map(() => '?').join(',')})`
      args.push(...from)
    }
    return this.db.prepare(sql).run(...args).changes === 1
  }

  remember(chatKey: number, messageId: number, questionId: number, kind: 'frage' | 'bestaetigung' | 'bemerkung', at: number): void {
    this.db.prepare('INSERT OR REPLACE INTO messages (chat_key, message_id, question_id, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(chatKey, messageId, questionId, kind, at)
  }

  byMessage(chatKey: number, messageId: number): { row: Row; kind: string } | null {
    const m = this.db.prepare('SELECT question_id, kind FROM messages WHERE chat_key = ? AND message_id = ?').get(chatKey, messageId) as { question_id: number; kind: string } | undefined
    const row = m ? this.get(m.question_id) : null
    return row && m ? { row, kind: m.kind } : null
  }

  getKv(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value ?? null
  }

  setKv(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
    else this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value)
  }
}

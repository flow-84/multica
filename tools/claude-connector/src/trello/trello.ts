// Minimal Trello REST client for the Multica mirror (MS-3182). Credentials
// come from the existing secrets file (~/.secrets/trello-crm.env, account
// msx100) and are read at call time, never stored in the repo or a plist.
import { readFileSync } from 'node:fs'
import { withNetRetry } from '../net-retry.ts'

export interface TrelloCreds {
  key: string
  token: string
}

/** Reads TRELLO_API_KEY / TRELLO_TOKEN from a dotenv-style file. */
export function readTrelloCreds(path: string): TrelloCreds {
  const env: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  const key = env.TRELLO_API_KEY ?? env.TRELLO_KEY
  const token = env.TRELLO_TOKEN
  if (!key || !token) throw new Error(`TRELLO_API_KEY oder TRELLO_TOKEN fehlt in ${path}`)
  return { key, token }
}

export class TrelloError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface TList {
  id: string
  name: string
  pos: number
  closed: boolean
}

export interface TLabel {
  id: string
  name: string
  color: string | null
}

export interface TCard {
  id: string
  name: string
  desc: string
  idList: string
  idLabels: string[]
  idMembers: string[]
  due: string | null
  closed: boolean
  shortUrl: string
  dateLastActivity: string
}

export interface TComment {
  id: string
  date: string
  text: string
  author: string
}

export interface TBoard {
  id: string
  name: string
  url: string
}

type Fetch = typeof fetch

export class Trello {
  private readonly f: Fetch
  private readonly creds: () => TrelloCreds
  private readonly base: string

  constructor(f: Fetch, creds: () => TrelloCreds, base = 'https://api.trello.com/1') {
    this.f = f
    this.creds = creds
    this.base = base
  }

  private async req<T>(method: string, path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const { key, token } = this.creds()
    const auth = new URLSearchParams({ key, token })
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, v)
    // Reads carry their parameters in the query string. Writes send them as a
    // form body: a long comment or description in the URL hits Trello's URL
    // length limit (HTTP 414, MS-3771).
    const read = method === 'GET'
    const url = `${this.base}${path}?${read ? new URLSearchParams([...auth, ...p]) : auth}`
    const body = read ? undefined : p.toString()
    const headers = read ? undefined : { 'content-type': 'application/x-www-form-urlencoded' }
    for (let attempt = 0; ; attempt++) {
      const { res, text } = await withNetRetry(method, async () => {
        const res = await this.f(url, { method, headers, body, signal: AbortSignal.timeout(20_000) })
        return { res, text: await res.text() }
      })
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      if (!res.ok) throw new TrelloError(res.status, `${method} ${path}: ${res.status} ${text.slice(0, 200)}`)
      return (text ? JSON.parse(text) : null) as T
    }
  }

  board(ref: string): Promise<TBoard> {
    return this.req('GET', `/boards/${ref}`, { fields: 'name,url' })
  }

  lists(boardId: string): Promise<TList[]> {
    return this.req('GET', `/boards/${boardId}/lists`, { filter: 'all', fields: 'name,pos,closed' })
  }

  createList(boardId: string, name: string, pos: string): Promise<TList> {
    return this.req('POST', '/lists', { idBoard: boardId, name, pos })
  }

  labels(boardId: string): Promise<TLabel[]> {
    return this.req('GET', `/boards/${boardId}/labels`, { fields: 'name,color', limit: '1000' })
  }

  createLabel(boardId: string, name: string, color: string): Promise<TLabel> {
    return this.req('POST', '/labels', { idBoard: boardId, name, color })
  }

  /** Open and archived cards of the board. */
  cards(boardId: string): Promise<TCard[]> {
    return this.req('GET', `/boards/${boardId}/cards/all`, { fields: 'name,desc,idList,idLabels,idMembers,due,closed,shortUrl,dateLastActivity' })
  }

  card(id: string): Promise<TCard> {
    return this.req('GET', `/cards/${id}`, { fields: 'name,desc,idList,idLabels,idMembers,due,closed,shortUrl,dateLastActivity' })
  }

  createCard(fields: Record<string, string | undefined>): Promise<TCard> {
    return this.req('POST', '/cards', fields)
  }

  updateCard(id: string, fields: Record<string, string | undefined>): Promise<TCard> {
    return this.req('PUT', `/cards/${id}`, fields)
  }

  async comments(cardId: string): Promise<TComment[]> {
    const raw = await this.req<{ id: string; date: string; data?: { text?: string }; memberCreator?: { fullName?: string; username?: string } }[]>(
      'GET',
      `/cards/${cardId}/actions`,
      { filter: 'commentCard', limit: '1000' },
    )
    return raw
      .map((a) => ({ id: a.id, date: a.date, text: a.data?.text ?? '', author: a.memberCreator?.fullName || a.memberCreator?.username || 'Trello' }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  async addComment(cardId: string, text: string): Promise<string> {
    const r = await this.req<{ id: string }>('POST', `/cards/${cardId}/actions/comments`, { text })
    return r.id
  }
}

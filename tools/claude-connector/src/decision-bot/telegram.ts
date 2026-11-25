// Minimal Telegram Bot API client for the decision bot (MS-4379). Long polling with
// getUpdates, so nothing on this Mac has to be reachable from outside.
import type { Button } from './texts.ts'

export class TelegramError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export interface TgUser {
  id: number
  username?: string
}

export interface TgMessage {
  message_id: number
  /** Topic of a forum group; plain topic messages also "reply" to the topic's first message. */
  message_thread_id?: number
  chat: { id: number; type: string }
  from?: TgUser
  text?: string
  reply_to_message?: { message_id: number }
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: { id: string; from: TgUser; message?: { message_id: number; message_thread_id?: number; chat: { id: number } }; data?: string }
}

export type Keyboard = Button[][] | null

/** What the bot needs from Telegram; the fake in the tests implements the same. */
export interface Tg {
  send(chatId: number, text: string, keyboard?: Keyboard, forceReply?: boolean, threadId?: number | null): Promise<number>
  edit(chatId: number, messageId: number, text: string, keyboard?: Keyboard): Promise<void>
  answerCallback(id: string, text?: string): Promise<void>
  delete(chatId: number, messageId: number): Promise<void>
  /** Creates a forum topic and returns its message_thread_id. */
  createTopic(chatId: number, name: string, iconColor?: number): Promise<number>
}

export class TelegramApi implements Tg {
  private readonly base: string
  constructor(token: string, base = 'https://api.telegram.org') {
    this.base = `${base}/bot${token}`
  }

  async call<T>(method: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number }
    if (!j.ok) throw new TelegramError(j.error_code ?? res.status, j.description ?? `HTTP ${res.status}`)
    return j.result as T
  }

  getMe(): Promise<TgUser> {
    return this.call('getMe', {})
  }

  deleteWebhook(): Promise<unknown> {
    return this.call('deleteWebhook', { drop_pending_updates: false })
  }

  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 15) * 1000)
  }

  async setCommands(): Promise<void> {
    await this.call('setMyCommands', { commands: [{ command: 'offen', description: 'Alle offenen Entscheidungen' }, { command: 'hilfe', description: 'So antwortest du' }] })
  }

  async send(chatId: number, text: string, keyboard?: Keyboard, forceReply = false, threadId: number | null = null): Promise<number> {
    const body: Record<string, unknown> = { chat_id: chatId, text, link_preview_options: { is_disabled: true } }
    if (threadId) body.message_thread_id = threadId
    if (forceReply) body.reply_markup = { force_reply: true, input_field_placeholder: 'Bemerkung' }
    else if (keyboard?.length) body.reply_markup = { inline_keyboard: keyboard }
    const m = await this.call<{ message_id: number }>('sendMessage', body)
    return m.message_id
  }

  async edit(chatId: number, messageId: number, text: string, keyboard: Keyboard = null): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard ?? [] },
      })
    } catch (err) {
      // Same text and markup again is not an error worth reporting.
      if (!(err instanceof TelegramError && /not modified/i.test(err.message))) throw err
    }
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', text ? { callback_query_id: id, text } : { callback_query_id: id })
  }

  async delete(chatId: number, messageId: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: messageId })
  }

  async createTopic(chatId: number, name: string, iconColor?: number): Promise<number> {
    const t = await this.call<{ message_thread_id: number }>('createForumTopic', iconColor ? { chat_id: chatId, name, icon_color: iconColor } : { chat_id: chatId, name })
    return t.message_thread_id
  }
}

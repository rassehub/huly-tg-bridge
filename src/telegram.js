/**
 * Minimal Telegram Bot API client: long-poll + forum topic ops + rate limiting
 * + media download (getFile, <=20MB bot limit) and upload (sendPhoto/sendDocument).
 */
const MAX_TG_DOWNLOAD = 20 * 1024 * 1024

/** pure: extract the best media payload from a message, or null */
export function pickTgMedia (msg) {
  if (msg == null) return null
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const p = msg.photo[msg.photo.length - 1] // largest size
    return { kind: 'photo', fileId: p.file_id, name: `photo_${msg.message_id}.jpg`, mime: 'image/jpeg' }
  }
  const d = msg.document ?? msg.video ?? msg.animation ?? msg.audio ?? msg.voice ?? msg.sticker
  if (d != null) {
    const mime = d.mime_type ?? 'application/octet-stream'
    return {
      kind: mime.startsWith('image/') && mime !== 'image/gif' ? 'photo' : 'document',
      fileId: d.file_id,
      name: d.file_name ?? `file_${msg.message_id}`,
      mime
    }
  }
  return null
}

export class Telegram {
  constructor (token, chatId, { perMin = 18, log = () => {} } = {}) {
    this.token = token
    this.chatId = chatId
    this.log = log
    this.perMin = perMin
    this.sentAt = []
    this.me = null
  }

  async init () {
    this.me = await this.call('getMe', {})
    await this.call('deleteWebhook', { drop_pending_updates: false }).catch((e) => this.log(`deleteWebhook: ${e.message}`))
    return this.me
  }

  /** rate-limited Bot API call (JSON body); 429 -> wait retry_after once */
  async call (method, params, { timeoutMs = 35000 } = {}) {
    return await this.post(method, JSON.stringify(params), { 'content-type': 'application/json' }, timeoutMs)
  }

  /** rate-limited Bot API call (multipart body, e.g. media upload) */
  async callForm (method, formData, { timeoutMs = 60000 } = {}) {
    return await this.post(method, formData, undefined, timeoutMs)
  }

  async post (method, body, headers, timeoutMs) {
    await this.slot()
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      })
      const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))
      if (data.ok === true) return data.result
      if (data.error_code === 429 && attempt === 1) {
        const wait = ((data.parameters?.retry_after ?? 5) * 1000) + 500
        this.log(`${method}: 429, waiting ${wait}ms`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw new Error(`${method}: ${data.error_code ?? res.status} ${data.description ?? ''}`.trim())
    }
  }

  /** sliding window limiter */
  async slot () {
    for (;;) {
      const now = Date.now()
      this.sentAt = this.sentAt.filter((t) => now - t < 60000)
      if (this.sentAt.length < this.perMin) { this.sentAt.push(now); return }
      await new Promise((r) => setTimeout(r, 60000 - (now - this.sentAt[0]) + 50))
    }
  }

  createTopic (name) {
    return this.call('createForumTopic', { chat_id: this.chatId, name: String(name).slice(0, 120) })
  }

  renameTopic (topicId, name) {
    return this.call('editForumTopic', { chat_id: this.chatId, message_thread_id: topicId, name: String(name).slice(0, 120) })
  }

  sendToTopic (topicId, text) {
    return this.call('sendMessage', { chat_id: this.chatId, message_thread_id: topicId, text })
  }

  editInTopic (topicId, messageId, text) {
    return this.call('editMessageText', {
      chat_id: this.chatId, message_thread_id: topicId, message_id: messageId, text
    })
  }

  deleteFromTopic (topicId, messageId) {
    return this.call('deleteMessage', { chat_id: this.chatId, message_id: messageId })
  }

  /** photo (non-gif images) via sendPhoto, everything else as document */
  async sendMediaToTopic (topicId, { buffer, name, mime, caption }) {
    const isPhoto = mime.startsWith('image/') && mime !== 'image/gif'
    const form = new FormData()
    form.append('chat_id', String(this.chatId))
    form.append('message_thread_id', String(topicId))
    if (caption != null && caption !== '') form.append('caption', caption)
    form.append(isPhoto ? 'photo' : 'document', new Blob([buffer], { type: mime }), name)
    return await this.callForm(isPhoto ? 'sendPhoto' : 'sendDocument', form)
  }

  /** download a file by file_id (Telegram bots: hard 20MB limit) */
  async downloadFile (fileId, maxBytes = MAX_TG_DOWNLOAD) {
    const res = await this.call('getFile', { file_id: fileId })
    const url = `https://api.telegram.org/file/bot${this.token}/${res.file_path}`
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
    if (!r.ok) throw new Error(`download ${res.file_path}: HTTP ${r.status}`)
    const len = Number(r.headers.get('content-length') ?? 0)
    if (len > maxBytes) throw new Error(`file too large: ${len}B > ${maxBytes}B (Telegram bot download limit)`)
    const buffer = Buffer.from(await r.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error(`file too large: ${buffer.length}B > ${maxBytes}B (Telegram bot download limit)`)
    const mime = r.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream'
    return { buffer, mime }
  }

  async getUpdates (offset) {
    return await this.call('getUpdates', {
      offset,
      timeout: 25,
      allowed_updates: ['message', 'edited_message']
    }, { timeoutMs: 40000 })
  }
}

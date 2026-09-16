/**
 * Huly side: connect via @hcengineering/api-client (verified by spike), poll
 * chunter channels/messages by watermark, write messages as the bot user,
 * and bridge media via blob storage + attachment.class.Attachment.
 *
 * CJS interop note: these packages are CommonJS — import default and
 * destructure at runtime.
 */
import { randomUUID } from 'node:crypto'
import { imageSize } from 'image-size'
import { paragraphContent } from './markup.js'
import apiClientPkg from '@hcengineering/api-client'
import chunterPluginPkg from '@hcengineering/chunter'

const apiClient = apiClientPkg.default ?? apiClientPkg
const { connect, connectStorage, NodeWebSocketFactory } = apiClient

const chunter = chunterPluginPkg.default ?? chunterPluginPkg
const ChannelClass = chunter.class.Channel
const ChatMessageClass = chunter.class.ChatMessage
const ATTACHMENT_COLLECTION = 'attachments'
const MAX_HULY_BLOB = 25 * 1024 * 1024

// class refs are plain string ids — no package dependency needed
// native UI posts use plain Attachment — inline rendering is driven by
// image/* type + metadata.{originalWidth,originalHeight,pixelRatio}
const AttachmentClass = 'attachment:class:Attachment'

export class Huly {
  constructor (cfg, log = () => {}) {
    this.cfg = cfg
    this.log = log
    this.client = null
    this.storage = null
    this.botSocialId = null
  }

  /** retry-connect forever with capped backoff; returns only when connected */
  async connectLoop (shouldStop = () => false) {
    let delay = 5000
    while (!shouldStop()) {
      try {
        this.client = await connect(this.cfg.hulyUrl, {
          workspace: this.cfg.workspace,
          email: this.cfg.email,
          password: this.cfg.password,
          socketFactory: NodeWebSocketFactory
        })
        const account = await this.client.getAccount()
        this.botSocialId = account.primarySocialId
        this.log(`connected, bot social id ${this.botSocialId}`)
        try {
          await this.connectStorage()
        } catch (e) {
          this.storage = null
          this.log(`blob storage unavailable — MEDIA BRIDGING DISABLED (${e.message})`)
        }
        delay = 5000
        return this.client
      } catch (e) {
        this.log(`connect failed (${e.message}), retry in ${delay}ms`)
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 60000)
      }
    }
  }

  async connectStorage () {
    this.storage = await connectStorage(this.cfg.hulyUrl, {
      email: this.cfg.email,
      password: this.cfg.password,
      workspace: this.cfg.workspace
    })
    this.log('blob storage connected')
  }

  get connected () { return this.client != null }

  async close () {
    try { await this.client?.close() } catch { /* noop */ }
    this.client = null
  }

  async listChannels () {
    return await this.client.findAll(ChannelClass, {})
  }

  /** messages changed after watermark (ms epoch), oldest first */
  async pollMessages (channelId, watermark) {
    const hits = await this.client.findAll(ChatMessageClass, {
      attachedTo: channelId,
      modifiedOn: { $gt: watermark }
    })
    return [...hits].sort((a, b) => a.modifiedOn - b.modifiedOn)
  }

  /** all message ids currently in channel (for delete reconciliation) */
  async messageIds (channelId) {
    const hits = await this.client.findAll(ChatMessageClass, { attachedTo: channelId })
    return hits.map((m) => m._id)
  }

  async listAttachments (msgId) {
    return await this.client.findAll(AttachmentClass, { attachedTo: msgId })
  }

  /** download a Huly blob to a Buffer (streamed, size-capped) */
  async readBlob (blobId) {
    const stream = await this.storage.get(blobId)
    const chunks = []
    let total = 0
    for await (const chunk of stream) {
      total += chunk.length
      if (total > MAX_HULY_BLOB) throw new Error(`blob ${blobId} exceeds ${MAX_HULY_BLOB}B`)
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  /** create as bot user; returns new message id; empty string -> single empty paragraph */
  async sendMessage (channelId, plainText) {
    return await this.addMessage(channelId, this.toDoc(plainText))
  }

  async editMessage (channelId, msgId, plainText) {
    await this.client.updateDoc(ChatMessageClass, channelId, msgId, { message: this.toDoc(plainText) })
  }

  async deleteMessage (channelId, msgId) {
    await this.client.removeDoc(ChatMessageClass, channelId, msgId)
  }

  /** TG->Huly media: uuid blob key + real mime + dimension metadata (inline render) */
  async attachFile (channelId, msgId, { name, buffer, mime }) {
    if (this.storage == null) throw new Error('blob storage not connected')
    const key = randomUUID() // native uploads use uuid blob ids; put() echoes the key
    const blob = await this.storage.put(key, buffer, mime)
    const attrs = {
      name,
      file: blob._id ?? key,
      size: buffer.length,
      type: mime,
      lastModified: Date.now()
    }
    if (mime.startsWith('image/')) {
      try {
        const { width, height } = imageSize(buffer)
        if (width != null && height != null) {
          attrs.metadata = { originalWidth: width, originalHeight: height, pixelRatio: 1 }
        }
      } catch { /* undecodable image -> file-style attachment */ }
    }
    return await this.client.addCollection(
      AttachmentClass, channelId, msgId, ChatMessageClass, ATTACHMENT_COLLECTION, attrs
    )
  }

  toDoc (plainText) {
    const content = []
    for (const line of String(plainText ?? '').split('\n')) {
      content.push(line === '' ? { type: 'paragraph' } : { type: 'paragraph', content: paragraphContent(line) })
    }
    if (content.length === 0) content.push({ type: 'paragraph' })
    return JSON.stringify({ type: 'doc', content })
  }

  async addMessage (channelId, messageJson) {
    return await this.client.addCollection(
      ChatMessageClass, channelId, channelId, ChannelClass, 'messages',
      { message: messageJson }
    )
  }
}

export { ChannelClass, ChatMessageClass, AttachmentClass }

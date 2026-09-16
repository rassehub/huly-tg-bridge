import fs from 'node:fs'
import path from 'node:path'

/**
 * Persistent bridge state. JSON file with atomic write (tmp + rename).
 * Deliberate deviation from the original SQLite plan: <100 KB of data here,
 * node:sqlite is still experimental and better-sqlite3 needs a native build
 * chain in the container. Interface is narrow on purpose.
 *
 * channels: Map<hulyChannelId, { hulyId, name, topicId, private }>
 * msgs:    Map<hulyMsgId, { hulyId, tgMsgId, topicId, channelId, modifiedOn }>
 * meta:    { watermarks: { [channelId]: number }, tgOffset: number }
 */
export class State {
  constructor (file) {
    this.file = file
    this.channels = new Map()
    this.msgs = new Map()
    this.meta = { watermarks: {}, tgOffset: 0 }
    this.load()
  }

  load () {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const c of d.channels ?? []) this.channels.set(c.hulyId, c)
      for (const m of d.messages ?? []) this.msgs.set(m.hulyId, m)
      this.meta = { watermarks: {}, tgOffset: 0, ...d.meta }
    } catch { /* fresh state */ }
  }

  persist () {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({
      channels: [...this.channels.values()],
      messages: [...this.msgs.values()],
      meta: this.meta
    }))
    fs.renameSync(tmp, this.file)
  }

  // channels
  channelByTopic (topicId) {
    for (const c of this.channels.values()) if (c.topicId === topicId) return c
    return null
  }

  upsertChannel (hulyId, name, topicId, isPrivate) {
    const prev = this.channels.get(hulyId)
    this.channels.set(hulyId, { hulyId, name, topicId: topicId ?? prev?.topicId, private: isPrivate === true })
  }

  // messages
  mapMessage (hulyId, tgMsgId, topicId, channelId, modifiedOn) {
    this.msgs.set(hulyId, { hulyId, tgMsgId, topicId, channelId, modifiedOn })
  }

  byTgMsgId (tgMsgId) {
    for (const m of this.msgs.values()) if (m.tgMsgId === tgMsgId) return m
    return null
  }

  touchMessage (hulyId, modifiedOn) {
    const m = this.msgs.get(hulyId)
    if (m != null) m.modifiedOn = modifiedOn
  }

  /** additional TG message ids (media) belonging to one Huly message */
  addExtraTgIds (hulyId, ids) {
    const m = this.msgs.get(hulyId)
    if (m != null && ids.length > 0) m.extraTgIds = [...(m.extraTgIds ?? []), ...ids]
  }

  /** all TG message ids mapped to one Huly message (main + media) */
  allTgIds (hulyId) {
    const m = this.msgs.get(hulyId)
    return m == null ? [] : [m.tgMsgId, ...(m.extraTgIds ?? [])]
  }

  dropMessage (hulyId) {
    this.msgs.delete(hulyId)
  }

  messagesForChannel (channelId) {
    return [...this.msgs.values()].filter((m) => m.channelId === channelId)
  }

  // watermarks / offset
  getWatermark (channelId) {
    return this.meta.watermarks[channelId]
  }

  setWatermark (channelId, ts) {
    this.meta.watermarks[channelId] = ts
  }

  get offset () { return this.meta.tgOffset }
  set offset (v) { this.meta.tgOffset = v }
}

/**
 * Pure decision for a polled Huly message.
 * @returns {'echo'|'new'|'edit'} — echo = created by the bridge bot itself.
 */
export function classifyHulyMessage (msg, state, botSocialId) {
  if (msg.createdBy === botSocialId) return 'echo'
  return state.msgs.has(msg._id) ? 'edit' : 'new'
}

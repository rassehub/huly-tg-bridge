import { classifyHulyMessage } from './state.js'
import { captionText } from './markup.js'
import { PeopleResolver, withPrefix } from './people.js'
import { parseIam } from './iam.js'
import { pickTgMedia } from './telegram.js'

/**
 * Orchestration:
 *  - channel <-> topic mapping (create on discovery, rename propagation)
 *  - Huly -> TG: watermark polling per channel, echo-suppressed by createdBy
 *  - TG -> Huly: getUpdates long-poll, writes as bot user with '@author:' prefix
 *  - reconciliation: periodic id set-diff for deletes + channel re-sync
 */
export class Bridge {
  constructor ({ cfg, state, tg, huly, log = () => {} }) {
    this.cfg = cfg
    this.state = state
    this.tg = tg
    this.huly = huly
    this.log = log
    this.stopping = false
    this.people = new PeopleResolver(cfg.peopleMapPath, log)
    this.loops = []
  }

  async start () {
    const me = await this.tg.init()
    this.log(`telegram bot @${me.username} (id ${me.id})`)
    await this.huly.connectLoop(() => this.stopping)
    await this.syncChannels()
    this.initWatermarks()
    await this.refreshPeople()
    this.state.persist()
    this.loops = [
      this.hulyLoop(),
      this.tgLoop(),
      this.reconcileLoop(),
      this.deleteSyncLoop()
    ]
    await Promise.all(this.loops)
  }

  async stop () {
    this.stopping = true
    await this.huly.close()
    this.state.persist()
  }

  /** map every visible channel to a forum topic; propagate renames */
  async syncChannels () {
    const channels = await this.huly.listChannels()
    for (const ch of channels) {
      const known = this.state.channels.get(ch._id)
      if (known == null) {
        const topic = await this.tg.createTopic(ch.name)
        this.state.upsertChannel(ch._id, ch.name, topic.message_thread_id, ch.isPrivate)
        this.state.persist() // persist immediately: a crash here must not duplicate topics
        this.log(`topic created: '${ch.name}' -> ${topic.message_thread_id}`)
      } else if (known.name !== ch.name) {
        await this.tg.renameTopic(known.topicId, ch.name)
        this.state.upsertChannel(ch._id, ch.name, known.topicId, ch.isPrivate)
        this.state.persist()
        this.log(`topic renamed: '${known.name}' -> '${ch.name}'`)
      }
    }
  }

  /** new channels start at 'now' — no history backfill on first mapping */
  initWatermarks () {
    const now = Date.now()
    for (const chId of this.state.channels.keys()) {
      if (this.state.getWatermark(chId) == null) this.state.setWatermark(chId, now)
    }
  }

  /** PersonId->name refresh; degradation is non-fatal (prefixes just vanish) */
  async refreshPeople () {
    try {
      await this.people.refreshHuly(this.huly.client)
    } catch (e) {
      this.log(`people refresh failed (author prefixes disabled): ${e.message}`)
    }
  }

  async hulyLoop () {
    while (!this.stopping) {
      let ok = true
      for (const [chId, ch] of this.state.channels) {
        const wm = this.state.getWatermark(chId) ?? 0
        let msgs
        try {
          msgs = await this.huly.pollMessages(chId, wm)
        } catch (e) {
          this.log(`huly poll failed (${e.message}) — reconnecting`)
          ok = false
          break
        }
        for (const m of msgs) {
          const kind = classifyHulyMessage(m, this.state, this.huly.botSocialId)
          if (kind === 'echo') { /* our own TG->Huly write */ } else if (kind === 'new') {
            try {
              await this.hulyToTelegram(ch, m)
            } catch (e) { this.log(`tg send failed for ${m._id}: ${e.message}`) }
          } else { // edit: text edits only (media edits not synced in v1)
            const known = this.state.msgs.get(m._id)
            if (known != null && m.modifiedOn > known.modifiedOn) {
              const text = withPrefix(this.people.hulyName(m.createdBy), captionText(m.message))
              try {
                if (text !== '') await this.tg.editInTopic(ch.topicId, known.tgMsgId, text)
                this.state.touchMessage(m._id, m.modifiedOn)
              } catch (e) {
                if (!/message is not modified/.test(e.message)) this.log(`tg edit failed for ${m._id}: ${e.message}`)
                this.state.touchMessage(m._id, m.modifiedOn)
              }
            }
          }
          this.state.setWatermark(chId, Math.max(wm, m.modifiedOn))
        }
      }
      if (ok) this.state.persist()
      if (this.stopping) return
      if (!ok) await this.reconnectHuly()
      else await sleep(this.cfg.pollSec * 1000)
    }
  }

  /** Huly -> TG for one new message: text + each attachment as its own TG message */
  async hulyToTelegram (ch, m) {
    const caption = captionText(m.message)
    const prefixed = withPrefix(this.people.hulyName(m.createdBy), caption)
    const hasMedia = (m.attachments ?? 0) > 0
    const ids = []

    if (prefixed !== '' || !hasMedia) {
      const sent = await this.tg.sendToTopic(ch.topicId, hasMedia && prefixed === '' ? '[attachment]' : prefixed)
      ids.push(sent.message_id)
    }
    if (hasMedia) {
      const atts = await this.huly.listAttachments(m._id)
      for (const att of atts) {
        try {
          const buffer = await this.huly.readBlob(att.file)
          const sent = await this.tg.sendMediaToTopic(ch.topicId, {
            buffer, name: att.name, mime: att.type ?? 'application/octet-stream', caption: undefined
          })
          ids.push(sent.message_id)
        } catch (e) { this.log(`media forward failed for ${att.name} on ${m._id}: ${e.message}`) }
      }
    }
    this.state.mapMessage(m._id, ids[0], ch.topicId, m.space ?? ch.hulyId, m.modifiedOn)
    this.state.addExtraTgIds(m._id, ids.slice(1))
  }

  async reconnectHuly () {
    await this.huly.close()
    await this.huly.connectLoop(() => this.stopping)
    await this.syncChannels().catch((e) => this.log(`channel re-sync failed: ${e.message}`))
  }

  async tgLoop () {
    while (!this.stopping) {
      let updates
      try {
        updates = await this.tg.getUpdates(this.state.offset)
      } catch (e) {
        this.log(`getUpdates failed: ${e.message}`)
        await sleep(5000)
        continue
      }
      for (const u of updates) {
        this.state.offset = u.update_id + 1
        try {
          await this.handleTgUpdate(u)
        } catch (e) { this.log(`tg update ${u.update_id} failed: ${e.message}`) }
      }
      if (updates.length > 0) this.state.persist()
    }
  }

  async handleTgUpdate (u) {
    const msg = u.message ?? u.edited_message
    if (msg == null) return
    if (msg.from?.id === this.tg.me?.id) return
    const media = pickTgMedia(msg)
    const text = msg.text ?? msg.caption ?? (media != null ? '' : null)
    if (text == null || text === '') {
      if (media == null) return
    }
    if (msg.from?.is_bot === true) return
    const thread = msg.message_thread_id ?? msg.reply_to_message?.message_thread_id

    // /iam Real Name — self-service people.json entry (works in any topic, incl. General)
    const name = parseIam(text)
    if (name != null && msg.from?.id != null) {
      try {
        this.people.setTgName(msg.from, name)
        if (thread != null) await this.tg.sendToTopic(thread, `✓ bridged as "${name}"`)
      } catch (e) { this.log(`/iam failed: ${e.message}`) }
      return
    }
    if (thread == null) return
    const ch = this.state.channelByTopic(thread)
    if (ch == null) return
    const body = withPrefix(this.people.tgName(msg.from), text)

    if (u.edited_message != null) {
      const known = this.state.byTgMsgId(msg.message_id)
      if (known != null) {
        await this.huly.editMessage(ch.hulyId, known.hulyId, body)
        return
      }
      // edit of a pre-bridge message -> create as new
    }
    const hulyId = await this.huly.sendMessage(ch.hulyId, body)
    if (media != null) {
      try {
        // mime from message metadata (download response headers are octet-stream)
        const { buffer } = await this.tg.downloadFile(media.fileId)
        await this.huly.attachFile(ch.hulyId, hulyId, { name: media.name, buffer, mime: media.mime })
      } catch (e) { this.log(`tg media forward failed (${msg.message_id}): ${e.message}`) }
    }
    this.state.mapMessage(hulyId, msg.message_id, thread, ch.hulyId, Date.now())
  }

  /** Huly deletes -> remove mapped TG messages (main + media). Bot API can only
   *  delete TG messages <=48h old; older ones fail and the mapping is dropped. */
  async reconcileDeletes () {
    for (const [chId, ch] of this.state.channels) {
      const live = new Set(await this.huly.messageIds(chId))
      for (const m of this.state.messagesForChannel(chId)) {
        if (live.has(m.hulyId)) continue
        for (const tgId of this.state.allTgIds(m.hulyId)) {
          try {
            await this.tg.deleteFromTopic(ch.topicId, tgId)
          } catch (e) { this.log(`tg delete failed (${e.message}) — dropping mapping anyway`) }
        }
        this.state.dropMessage(m.hulyId)
        this.log(`huly message removed, deleted mirror in topic ${ch.topicId}`)
      }
    }
    this.state.persist()
  }

  /** fast loop: near-real-time Huly->TG delete propagation */
  async deleteSyncLoop () {
    while (!this.stopping) {
      await sleep(this.cfg.deleteSyncSec * 1000)
      if (this.stopping) return
      try {
        await this.reconcileDeletes()
      } catch (e) { this.log(`delete sync failed: ${e.message}`) }
    }
  }

  /** periodic slower loop: people refresh + channel add/rename + deletes */
  async reconcileLoop () {
    while (!this.stopping) {
      await sleep(this.cfg.fullSyncSec * 1000)
      if (this.stopping) return
      try {
        await this.refreshPeople()
        await this.syncChannels()
        await this.reconcileDeletes()
      } catch (e) { this.log(`reconcile failed: ${e.message}`) }
    }
  }
}

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

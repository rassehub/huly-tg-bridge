#!/usr/bin/env node
/**
 * huly-tg-bridge one-shot cleanup: delete every forum topic the bridge created.
 * Topic ids are recovered from the unit journal ("topic created: 'x' -> N").
 * With the bridge env sourced:
 *   set -a; . ./.env; set +a
 *   node cleanup-topics.mjs            # dry run
 *   node cleanup-topics.mjs --delete   # actually delete
 */
import { execFileSync } from 'node:child_process'

const token = process.env.TG_BOT_TOKEN
const chatId = Number(process.env.TG_CHAT_ID)
if (!token || !chatId) {
  console.error('set TG_BOT_TOKEN and TG_CHAT_ID (source ./.env)')
  process.exit(1)
}
const doDelete = process.argv.includes('--delete')

let ids = []
try {
  const log = execFileSync('journalctl', ['--user', '-u', 'huly-tg-bridge', '--no-pager'], { encoding: 'utf8' })
  ids = [...new Set([...log.matchAll(/topic created: '.*' -> (\d+)/g)].map((m) => Number(m[1])))]
} catch (e) {
  console.error(`journalctl failed: ${e.message}`)
  process.exit(1)
}
ids = ids.filter((id) => id !== 1) // "General" topic is undeletable
if (ids.length === 0) {
  console.log('no bridge-created topics found in journal')
  process.exit(0)
}

console.log(`topics to ${doDelete ? 'DELETE' : 'dry-run (re-run with --delete)'}: ${ids.join(', ')}`)
if (!doDelete) process.exit(0)

for (const id of ids) {
  const res = await fetch(`https://api.telegram.org/bot${token}/deleteForumTopic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_thread_id: id })
  }).then((r) => r.json())
  console.log(`  topic ${id}: ${res.ok === true ? 'deleted' : `FAILED ${res.error_code} ${res.description ?? ''}`}`)
  await new Promise((r) => setTimeout(r, 1500))
}

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { docToText, textToDoc, truncate, toTelegramText, captionText, paragraphContent } from '../src/markup.js'
import { pickTgMedia } from '../src/telegram.js'
import { State, classifyHulyMessage } from '../src/state.js'
import { buildSocialMap, resolveTgName, withPrefix, formatPersonName } from '../src/people.js'

test('markup: docToText extracts plain text with newlines', () => {
  const doc = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world', marks: [{ type: 'bold' }] }] },
      { type: 'paragraph', content: [{ type: 'hard_break' }, { type: 'text', text: 'second' }] }
    ]
  })
  assert.equal(docToText(doc), 'hello world\nsecond')
})

test('markup: docToText garbage and attachment-only bodies', () => {
  assert.equal(docToText('not json'), '')
  assert.equal(docToText(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })), '')
  assert.equal(toTelegramText(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })), '[attachment]')
})

test('markup: textToDoc builds valid prosemirror doc', () => {
  const parsed = JSON.parse(textToDoc('a\n\nb'))
  assert.equal(parsed.type, 'doc')
  assert.deepEqual(parsed.content.map((p) => p.type), ['paragraph', 'paragraph', 'paragraph'])
  assert.equal(parsed.content[0].content[0].text, 'a')
  assert.equal(parsed.content[2].content[0].text, 'b')
})

test('markup: truncate caps length with ellipsis', () => {
  assert.equal(truncate('x'.repeat(5000)).length, 4000)
  assert.equal(truncate('short'), 'short')
})

test('state: persist/load round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
  const file = path.join(dir, 'state.json')
  const s = new State(file)
  s.upsertChannel('ch1', 'general', 11, false)
  s.mapMessage('m1', 100, 11, 'ch1', 12345)
  s.setWatermark('ch1', 12345)
  s.offset = 77
  s.persist()
  const s2 = new State(file)
  assert.equal(s2.channels.get('ch1').name, 'general')
  assert.equal(s2.msgs.get('m1').tgMsgId, 100)
  assert.equal(s2.getWatermark('ch1'), 12345)
  assert.equal(s2.offset, 77)
})

test('state: channelByTopic and byTgMsgId lookups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
  const s = new State(path.join(dir, 'state.json'))
  s.upsertChannel('ch1', 'general', 11, false)
  s.upsertChannel('ch2', 'random', 22, true)
  s.mapMessage('m1', 100, 11, 'ch1', 1)
  assert.equal(s.channelByTopic(22).hulyId, 'ch2')
  assert.equal(s.byTgMsgId(100).hulyId, 'm1')
  assert.equal(s.channelByTopic(999), null)
})

test('dedup: classifyHulyMessage echo/new/edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
  const s = new State(path.join(dir, 'state.json'))
  s.mapMessage('m1', 100, 11, 'ch1', 1)
  const msg = (id, by) => ({ _id: id, createdBy: by })
  assert.equal(classifyHulyMessage(msg('m1', 'bot'), s, 'bot'), 'echo')
  assert.equal(classifyHulyMessage(msg('m2', 'alice'), s, 'bot'), 'new')
  assert.equal(classifyHulyMessage(msg('m1', 'alice'), s, 'bot'), 'edit')
})

test('people: buildSocialMap resolves PersonId to Person.name', () => {
  const persons = [{ _id: 'p1', name: 'Ada Lovelace' }, { _id: 'p2', name: 'Alan Turing' }]
  const sis = [{ _id: '1209', attachedTo: 'p1' }, { _id: '1210', attachedTo: 'p2' }, { _id: '1211', attachedTo: 'gone' }]
  const m = buildSocialMap(sis, persons)
  assert.equal(m.get('1209'), 'Ada Lovelace')
  assert.equal(m.get('1211'), null)
  assert.equal(m.get('nope'), undefined)
})

test('people: resolveTgName fallback chain (id wins over username)', () => {
  const map = { jdoe: 'John Doe', '99881': 'Mapped ById' }
  assert.equal(resolveTgName(map, { username: 'jdoe', id: 99881, first_name: 'X' }), 'Mapped ById')
  assert.equal(resolveTgName(map, { username: 'jdoe', id: 1, first_name: 'X' }), 'John Doe')
  assert.equal(resolveTgName(map, { username: 'zzz', id: 2, first_name: 'Jane' }), 'Jane')
  assert.equal(resolveTgName(map, { username: 'zzz', id: 2 }), '@zzz')
  assert.equal(resolveTgName({}, null), 'telegram')
})

test('people: formatPersonName reorders LAST_NAME_FIRST storage', () => {
  assert.equal(formatPersonName('Turing,Alan'), 'Alan Turing')
  assert.equal(formatPersonName('Lovelace, Ada'), 'Ada Lovelace')
  assert.equal(formatPersonName('Plain Name'), 'Plain Name')
  assert.equal(formatPersonName(null), null)
})

test('bridge: /iam command regex', async () => {
  const { parseIam } = await import('../src/iam.js')
  assert.equal(parseIam('/iam Alan Turing'), 'Alan Turing')
  assert.equal(parseIam('/iam@MyHulyBridgeBot Ada Lovelace'), 'Ada Lovelace')
  assert.equal(parseIam('/nimi Grace Hopper'), 'Grace Hopper')
  assert.equal(parseIam('/iam   spaced   name '), 'spaced   name')
  assert.equal(parseIam('/list'), null)
  assert.equal(parseIam('hello /iam x'), null)
})

test('markup: captionText has no [attachment] placeholder', () => {
  assert.equal(captionText(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })), '')
  assert.equal(captionText(textToDoc('hi')), 'hi')
})

test('tg: pickTgMedia extracts largest photo, documents, and null for text-only', () => {
  const photo = pickTgMedia({ message_id: 1, photo: [{ file_id: 'a' }, { file_id: 'b' }] })
  assert.deepEqual(photo, { kind: 'photo', fileId: 'b', name: 'photo_1.jpg', mime: 'image/jpeg' })
  const doc = pickTgMedia({ message_id: 2, document: { file_id: 'd', file_name: 'x.pdf', mime_type: 'application/pdf' } })
  assert.deepEqual(doc, { kind: 'document', fileId: 'd', name: 'x.pdf', mime: 'application/pdf' })
  const imgDoc = pickTgMedia({ message_id: 3, document: { file_id: 'p', file_name: 'y.png', mime_type: 'image/png' } })
  assert.equal(imgDoc.kind, 'photo')
  assert.equal(pickTgMedia({ message_id: 4, text: 'hi' }), null)
  assert.equal(pickTgMedia(null), null)
})

test('state: extraTgIds accumulate and allTgIds returns main + extras', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
  const s = new State(path.join(dir, 'state.json'))
  s.mapMessage('m1', 100, 11, 'ch1', 1)
  s.addExtraTgIds('m1', [101, 102])
  s.addExtraTgIds('m1', [103])
  assert.deepEqual(s.allTgIds('m1'), [100, 101, 102, 103])
  assert.deepEqual(s.allTgIds('nope'), [])
  s.persist()
  const s2 = new State(path.join(dir, 'state.json'))
  assert.deepEqual(s2.allTgIds('m1'), [100, 101, 102, 103])
})

test('markup: paragraphContent linkifies http(s) URLs only', () => {
  const nodes = paragraphContent('see https://example.com/x?a=1 now and http://a.b/c, ok')
  assert.equal(nodes.length, 6)
  assert.deepEqual(nodes[0], { type: 'text', text: 'see ' })
  assert.equal(nodes[1].marks?.[0]?.attrs?.href, 'https://example.com/x?a=1')
  assert.equal(nodes[2].text, ' now and ')
  assert.equal(nodes[3].marks?.[0]?.attrs?.href, 'http://a.b/c')
  assert.equal(nodes[4].text, ',')
  assert.equal(nodes[5].text, ' ok')
  // no trailing dot inside link
  const trail = paragraphContent('go https://x.y/z.')
  assert.equal(trail[1].marks?.[0]?.attrs?.href, 'https://x.y/z')
  assert.equal(trail[2].text, '.')
  // plain text untouched, www without scheme not linked
  assert.deepEqual(paragraphContent('plain www.example.com'),
    [{ type: 'text', text: 'plain www.example.com' }])
  // url-only line
  assert.equal(paragraphContent('https://only.io')[0].marks?.[0]?.type, 'link')
})

test('people: withPrefix formats only when name resolves', () => {
  assert.equal(withPrefix('Ada', 'hi'), 'Ada: hi')
  assert.equal(withPrefix(null, 'hi'), 'hi')
})

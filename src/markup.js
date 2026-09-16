/**
 * Prosemirror (Huly markup) <-> plain text conversions.
 * Verified contract: ChatMessage.message is a JSON string:
 *   {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"..."}]}]}
 */

export function docToText (messageJson) {
  let doc
  try { doc = JSON.parse(messageJson) } catch { return '' }
  const out = []
  const walk = (node) => {
    if (node == null || typeof node !== 'object') return
    if (typeof node.text === 'string') {
      out.push(node.text)
      return
    }
    const kids = node.content
    if (Array.isArray(kids)) {
      for (const k of kids) walk(k)
      if (node.type === 'paragraph') out.push('\n')
    }
  }
  walk(doc)
  return out.join('').replace(/\n+$/, '')
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g

/** prosemirror paragraph content for one line: URLs become link-marked text nodes */
export function paragraphContent (line) {
  const nodes = []
  let last = 0
  for (const m of line.matchAll(URL_RE)) {
    if (m.index > last) nodes.push({ type: 'text', text: line.slice(last, m.index) })
    const url = m[1].replace(/[.,;]+$/, '') // GFM-style: strip trailing punctuation
    const trailing = m[1].slice(url.length)
    nodes.push({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] })
    if (trailing !== '') nodes.push({ type: 'text', text: trailing })
    last = m.index + m[1].length
  }
  if (last < line.length) nodes.push({ type: 'text', text: line.slice(last) })
  return nodes
}

export function textToDoc (text) {
  const lines = String(text ?? '').split('\n')
  const content = lines.map((line) =>
    line === ''
      ? { type: 'paragraph' }
      : { type: 'paragraph', content: [{ type: 'text', text: line }] })
  return JSON.stringify({ type: 'doc', content })
}

export function truncate (s, max = 4000) {
  const t = String(s ?? '')
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** message text for TG, with attachment placeholder when body is empty */
export function toTelegramText (messageJson) {
  const t = docToText(messageJson)
  return t === '' ? '[attachment]' : truncate(t)
}

/** caption text for TG when media is present: '' when body is empty (no placeholder) */
export function captionText (messageJson) {
  return truncate(docToText(messageJson))
}

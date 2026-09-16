/** parse '/iam Real Name' (fi alias '/nimi'), optional @bot suffix; returns the name or null */
export function parseIam (text) {
  const m = /^\/(?:iam|nimi)(?:@\w+)?\s+(.+)$/.exec(String(text ?? '').trim())
  return m != null ? m[1].trim().slice(0, 60) : null
}

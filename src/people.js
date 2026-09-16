import fs from 'node:fs'
import contactPkg from '@hcengineering/contact'

// CJS interop (same as chunter/api-client)
const contact = contactPkg.default ?? contactPkg
const PersonClass = contact.class.Person
const SocialIdentityClass = contact.class.SocialIdentity

/**
 * createdBy (PersonId) -> SocialIdentity.attachedTo -> Person.name
 */
/** 'Last,First' (LAST_NAME_FIRST workspaces) -> 'First Last' */
export function formatPersonName (name) {
  if (name == null) return null
  const m = /^(.*?),\s*(.*)$/.exec(name)
  return m != null ? `${m[2]} ${m[1]}` : name
}

export function buildSocialMap (socialIdentities, persons) {
  const personName = new Map(persons.map((p) => [p._id, formatPersonName(p.name)]))
  const m = new Map()
  for (const si of socialIdentities) m.set(si._id, personName.get(si.attachedTo) ?? null)
  return m
}

export function withPrefix (name, text) {
  return name != null && name !== '' ? `${name}: ${text}` : text
}

/**
 * Manual TG->Huly name map (people.json), keys: telegram username or numeric id.
 * Fallback chain: map[username] -> map[id] -> first_name -> @username -> 'telegram'.
 */
/**
 * Resolution order: numeric id (self-service /iam — user controls their own name)
 * -> username (manual admin mapping) -> first_name -> @username.
 */
export function resolveTgName (map, from) {
  if (from == null) return 'telegram'
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]))
  return lower[String(from.id)] ?? lower[from.username?.toLowerCase()] ?? from.first_name ??
    (from.username != null ? '@' + from.username : 'telegram')
}

export class PeopleResolver {
  constructor (mapFile, log = () => {}) {
    this.mapFile = mapFile
    this.log = log
    this.socialMap = new Map()
    this.tgMap = {}
    this.mtimeMs = -1
  }

  /** refresh PersonId -> name from the workspace (startup + each reconcile) */
  async refreshHuly (client) {
    const [sis, persons] = await Promise.all([
      client.findAll(SocialIdentityClass, {}),
      client.findAll(PersonClass, {})
    ])
    this.socialMap = buildSocialMap(sis, persons)
    const sample = [...this.socialMap.keys()].slice(0, 3)
    this.log(`people: ${this.socialMap.size} social ids, ${persons.length} persons (sample ids: ${sample.join(', ')})`)
  }

  hulyName (personId) {
    return this.socialMap.get(personId) ?? null
  }

  /** reload people.json on mtime change (no restart needed) */
  loadTgMap () {
    try {
      const st = fs.statSync(this.mapFile)
      if (st.mtimeMs !== this.mtimeMs) {
        this.tgMap = JSON.parse(fs.readFileSync(this.mapFile, 'utf8'))
        this.mtimeMs = st.mtimeMs
        this.loadError = null
        this.log(`people: telegram map loaded (${Object.keys(this.tgMap).length} entries)`)
      }
    } catch (e) {
      const msg = `people: cannot read ${this.mapFile} (${e.code ?? e.message}) — TG->Huly prefixes fall back to first_name`
      if (this.loadError !== msg) { this.loadError = msg; this.log(msg) }
      this.tgMap = {}
      this.mtimeMs = -1
    }
  }

  tgName (from) {
    this.loadTgMap()
    return resolveTgName(this.tgMap, from)
  }

  /** /iam command: record display name keyed by stable numeric id, persist to people.json */
  setTgName (from, name) {
    this.loadTgMap()
    this.tgMap[String(from.id)] = name
    const tmp = this.mapFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.tgMap, null, 2))
    fs.renameSync(tmp, this.mapFile)
    const st = fs.statSync(this.mapFile)
    this.mtimeMs = st.mtimeMs
    this.log(`people: ${name} recorded for telegram id ${from.id}`)
  }
}

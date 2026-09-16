export function loadConfig (env = process.env) {
  const req = (k) => {
    const v = env[k]
    if (v == null || v === '') throw new Error(`missing required env ${k}`)
    return v
  }
  const num = (k, dflt) => {
    const v = env[k]
    if (v == null || v === '') return dflt
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${k}: ${v}`)
    return n
  }
  return {
    hulyUrl: req('HULY_URL').replace(/\/+$/, ''),
    workspace: req('HULY_WORKSPACE'),
    email: req('HULY_BOT_EMAIL'),
    password: req('HULY_BOT_PASSWORD'),
    tgToken: req('TG_BOT_TOKEN'),
    tgChatId: Number(req('TG_CHAT_ID')),
    statePath: env.STATE_PATH ?? '/data/state.json',
    peopleMapPath: env.PEOPLE_MAP_PATH ?? '/data/people.json',
    pollSec: num('BRIDGE_POLL_SEC', 3),
    fullSyncSec: num('BRIDGE_FULL_SYNC_SEC', 600),
    deleteSyncSec: num('BRIDGE_DELETE_SYNC_SEC', 60),
    tgPerMin: num('BRIDGE_TG_RATE_PER_MIN', 18),
    logLevel: env.LOG_LEVEL ?? 'info'
  }
}

import { loadConfig } from './config.js'
import { State } from './state.js'
import { Telegram } from './telegram.js'
import { Huly } from './huly.js'
import { Bridge } from './bridge.js'

const cfg = loadConfig()
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }
const level = LEVELS[cfg.logLevel] ?? 2
const log = (msg) => { if (level >= 1) console.log(`${new Date().toISOString()} ${msg}`) }

const state = new State(cfg.statePath)
const tg = new Telegram(cfg.tgToken, cfg.tgChatId, { perMin: cfg.tgPerMin, log })
const huly = new Huly(cfg, log)
const bridge = new Bridge({ cfg, state, tg, huly, log })

let shuttingDown = false
async function shutdown (sig) {
  if (shuttingDown) return
  shuttingDown = true
  log(`received ${sig}, shutting down`)
  await bridge.stop().catch((e) => log(`stop error: ${e.message}`))
  process.exit(0)
}
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })

bridge.start().catch((e) => {
  console.error(e)
  process.exit(1)
})

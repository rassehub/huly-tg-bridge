# huly-tg-bridge

Bidirectional bridge between a self-hosted [Huly](https://huly.io) workspace and Telegram:
every Huly chunter channel is mirrored to a topic in a Telegram forum supergroup, and every
message posted in a topic is mirrored back to the channel — text and media, both directions.
It is a pure external client: zero modifications to Huly. It talks to Huly's transactor over
WebSocket ([`@hcengineering/api-client`](package.json)) and to the Telegram Bot API via
long-polling. Polling is the architecture, not a fallback — the Huly client library exposes
no push API.

```
Telegram forum supergroup ──(Bot API long-poll, topic = message_thread_id)──┐
                                                                            ▼
                                                                huly-tg-bridge
                                                                            ▲
Huly 0.7.x ──(wss /_transactor, @hcengineering/api-client)──────────────────┘
```

## How it works

The bridge keeps, per channel, a *watermark* — simply the timestamp of the last Huly message
it processed — and repeatedly asks Huly for anything modified after it.

| Event | Direction | Mechanism |
|---|---|---|
| Message create/edit | Huly → TG | Watermark poll (`BRIDGE_POLL_SEC`, default 3 s) → send/edit message in the topic. Messages the bridge itself wrote into Huly are recognized by author and skipped (echo suppression). |
| Message delete | Huly → TG | Fast set-diff sweep (`BRIDGE_DELETE_SYNC_SEC`, default 60 s): live Huly message ids vs. mapped ones → delete the Telegram mirrors. Best-effort — the Bot API can only delete messages ≤ 48 h old; older mirrors are dropped from the mapping with a log line. |
| Message create | TG → Huly | Bot API long-poll (`getUpdates`) → posted into the channel as the bot's Huly account, prefixed `Name: text`. |
| Message edit | TG → Huly | `edited_message` update → the mirrored Huly message is updated in place. |
| Message delete | TG → Huly | **Not possible** — the Bot API delivers no delete events and bots cannot list chat history. Workaround: delete the bot's mirrored message in Huly; the delete sweep then removes the Telegram original too. |
| Channel add/rename | Huly → TG | Periodic re-sync (`BRIDGE_FULL_SYNC_SEC`, default 600 s) → create / rename the matching topic. |
| History backfill | — | None. A channel mapped for the first time starts at "now". |

## Author attribution

Both directions carry a `Name: text` prefix so the true author is visible.

- **Huly → TG**: the prefix is the Huly author's display name, resolved automatically from the
  workspace (person records + social identities) at startup and on each full reconciliation.
  Authors that cannot be resolved get no prefix.
- **TG → Huly**: Telegram and Huly share no ids, so the prefix comes from a manual map file
  (`people.json`, path via `PEOPLE_MAP_PATH`, default `/data/people.json`):

  ```json
  {"tg_username_or_numeric_id": "Display Name", "99887766": "Jane Doe"}
  ```

  Keys are Telegram username or numeric user id. Resolution order: numeric id → username →
  `first_name` → `@username`. The file is reloaded automatically when its modification time
  changes — no restart needed.
- **Self-service**: group members can send `/iam Real Name` (alias `/nimi`) in any topic,
  including the General topic. The bridge records the name keyed by the sender's stable
  numeric Telegram id, rewrites `people.json` atomically, and confirms with
  `✓ bridged as "Real Name"`. Manual edits to the file are preserved, but avoid editing it
  while the bridge runs — the bridge owns rewrites.

## Media bridging

- **Huly → TG**: each attachment of a message is sent as its own Telegram message — non-gif
  images via `sendPhoto`, everything else as document. Message text (if any) is sent before
  the media; an empty text with media becomes an `[attachment]` placeholder. Files are
  streamed from Huly blob storage with a 25 MB cap.
- **TG → Huly**: photo, document, video, animation, audio, voice and sticker are downloaded
  via `getFile` — subject to the **20 MB hard limit of the Telegram Bot API** (larger files
  are skipped with a log line) — uploaded to Huly blob storage, and attached to the created
  message as an attachment (images get dimension metadata so they render inline). The caption
  becomes the message text.
- Media **edits** are not synced (text edits are). Media **deletes** propagate through the
  delete sweep like text.

## Limitations

- Formatting is flattened to plain text in both directions. One exception: URLs in Telegram
  messages become clickable links in Huly.
- All TG → Huly messages are authored by the bot's Huly account; the prefix carries the real
  author. Unavoidable with a single account.
- Telegram deletes only work for messages ≤ 48 h old (Bot API restriction).
- Telegram downloads are capped at 20 MB, Huly blobs at 25 MB.
- Every channel visible to the bot account gets mirrored — no per-channel selection yet.
  (Keep the bot out of channels you don't want bridged.)
- Direct messages are out of scope (no topic analog).
- No history backfill — new channels start at "now".

## Requirements

- Self-hosted **Huly 0.7.x** (developed and verified against server `0.7.426`, with the
  client dependencies pinned to `0.7.423`). See [Operations](#operations) before upgrading
  your Huly server.
- **Node.js ≥ 22** (build & test)
- **podman** or **docker** (run)
- A Telegram account

## Setup

### 1. Dedicated Huly bot account

Create a normal user account in your Huly workspace solely for the bridge — separate from
all human users. Invite it to every channel you want mirrored (private channels require an
explicit invite); only channels visible to this account get bridged.

Do **not** reuse Huly's built-in telegram-bot token for the Telegram side: one bot token must
have exactly one consumer, or the two pollers steal each other's updates.

### 2. Telegram bot via BotFather

1. Message `@BotFather` → `/newbot` → pick a name and username → receive the token.
2. `/setprivacy` → select your bot → **Disable**. Without this the bot only sees commands
   and replies, not regular group messages.
3. Keep the token secret; it goes into `.env`.

### 3. Forum supergroup

1. Create a group (or convert an existing one) with **Topics** enabled (a "forum"
   supergroup).
2. Add your bot as **admin** with the *Manage Topics* permission.
3. Obtain the group's chat id (supergroup ids look like `-1001234567890`): e.g. message
   `@userinfobot` inside the group and read the printed id, or inspect the `chat` object of
   a raw `getUpdates` response.

## Configuration

```bash
cp .env.example .env
# edit .env — fill in token, bot account credentials, workspace name, chat id
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `HULY_URL` | yes | — | Base URL of your self-hosted Huly instance |
| `HULY_WORKSPACE` | yes | — | Workspace **name** (not id) |
| `HULY_BOT_EMAIL` | yes | — | Email of the dedicated Huly bot account |
| `HULY_BOT_PASSWORD` | yes | — | Password of that account |
| `TG_BOT_TOKEN` | yes | — | BotFather token of the Telegram bot |
| `TG_CHAT_ID` | yes | — | Chat id of the forum supergroup |
| `STATE_PATH` | no | `/data/state.json` | Bridge state file (container volume) |
| `PEOPLE_MAP_PATH` | no | `/data/people.json` | Telegram username/id → display name map |
| `BRIDGE_POLL_SEC` | no | `3` | Huly message poll interval (seconds) |
| `BRIDGE_FULL_SYNC_SEC` | no | `600` | Reconciliation interval: channels, people, deletes |
| `BRIDGE_DELETE_SYNC_SEC` | no | `60` | Fast delete-propagation sweep interval |
| `BRIDGE_TG_RATE_PER_MIN` | no | `18` | Outgoing Telegram rate cap (Telegram limit ≈ 20/min per group) |
| `LOG_LEVEL` | no | `info` | `error` \| `warn` \| `info` \| `debug` |

## Build & run

```bash
npm install
npm test
podman build -t huly-tg-bridge .   # or: docker build -t huly-tg-bridge .
```

Then run the container one of two ways.

### Option A — systemd quadlet (recommended)

This repo intentionally ships no quadlet file: volume paths, env-file locations and
networking are host-specific. Write your own `huly-tg-bridge.container` from this template
and adjust the placeholders:

```ini
[Unit]
Description=Huly <-> Telegram bridge

[Container]
Image=localhost/huly-tg-bridge:latest
EnvironmentFile=/etc/huly-tg-bridge.env
Volume=/var/lib/huly-tg-bridge:/data:Z
# Uncomment if the container needs a dedicated network:
#Network=
# Uncomment and adjust if Huly runs on the host itself:
#AddHost=huly.example.com:host-gateway
NoNewPrivileges=true
DropCapability=ALL
ReadOnly=true
Restart=always

[Install]
WantedBy=default.target
```

Install it:

- rootless: `~/.config/containers/systemd/huly-tg-bridge.container`
- system: `/etc/containers/systemd/huly-tg-bridge.container`

then:

```bash
systemctl daemon-reload
systemctl enable --now huly-tg-bridge.service
journalctl -u huly-tg-bridge -f   # or: journalctl --user -u huly-tg-bridge -f (rootless)
```

Notes:

- Rootless: the volume directory (`/var/lib/huly-tg-bridge` on the host) must be owned by
  the user running the unit.
- All mutable state (`state.json`, `people.json`) lives in the volume mounted at `/data`.
- `ReadOnly=true` + `DropCapability=ALL` + `NoNewPrivileges=true` keep the container locked
  down; the bridge needs no capabilities and writes only to `/data`.

### Option B — plain container

```bash
podman run -d --name huly-tg-bridge \
  --read-only --cap-drop all --security-opt no-new-privileges \
  --env-file .env \
  -v huly-tg-bridge-data:/data \
  huly-tg-bridge
```

## First start

The bridge connects to Huly, lists every channel visible to the bot account, and creates one
Telegram topic per channel. Newly mapped channels start at "now" — nothing is backfilled.

`state.json` (on the volume) is the **only** mutable state besides `people.json`. Deleting
`state.json` re-maps all channels to fresh topics; the old topics are left orphaned — remove
them with the cleanup script (below).

Stopping via SIGTERM (`systemctl stop` / `podman stop`) persists state cleanly.

## Operations

**Huly server upgrade** — the client libraries are pinned, so bump them together with the
server:

1. Find the closest released `0.7.x` version to your new server:
   `npm view @hcengineering/api-client versions`
2. Update the four pinned `@hcengineering/*` dependencies in `package.json`
   (`api-client`, `chunter`, `contact`, `core`) to that version.
3. `npm install && npm test`, rebuild the image, restart the service.

Client/server drift within a patch line is tolerated — it only causes harmless
`failed to apply model transaction` warnings during connect. Minor-line drift is
unsupported; don't run the bridge against a server on a different minor line.

**Telegram rate limits** — roughly 20 messages/min per group. The bridge self-caps at
18/min (`BRIDGE_TG_RATE_PER_MIN`) and honors `429 retry_after` responses.

**Reset one channel's mapping** — delete its entry from `state.json` (in both `channels`
and `meta.watermarks`) and restart: the channel is re-mapped to a fresh topic.

**Delete orphaned topics** — [`scripts/cleanup-topics.mjs`](scripts/cleanup-topics.mjs)
removes every forum topic the bridge created (topic ids are recovered from the unit
journal; the General topic is skipped as undeletable):

```bash
set -a; . ./.env; set +a
node scripts/cleanup-topics.mjs            # dry run (default)
node scripts/cleanup-topics.mjs --delete   # actually delete
```

It reads `journalctl --user -u huly-tg-bridge`, so run it on the host that ran the service.

**Troubleshooting** — a `blob storage unavailable` log line at startup means media
bridging is disabled (text still works). Check that `HULY_URL` is reachable from inside
the container.

## Project layout

- [src/index.js](src/index.js) — entry point, logging, SIGTERM/SIGINT handling
- [src/config.js](src/config.js) — environment variable loading and validation
- [src/huly.js](src/huly.js) — Huly connection with backoff, watermark polls, writes as bot
  user, blob storage media handling
- [src/telegram.js](src/telegram.js) — Bot API client: long-poll, rate limiter, topic ops,
  media upload/download
- [src/bridge.js](src/bridge.js) — channel↔topic mapping, echo suppression, sync loops,
  reconciliation
- [src/state.js](src/state.js) — atomic JSON state: channels/topics, huly↔tg message ids,
  watermarks, Telegram update offset
- [src/markup.js](src/markup.js) — Huly (prosemirror) ↔ plain text conversion, URL
  linkification
- [src/people.js](src/people.js) — author name resolution both directions, `people.json`
  map handling
- [src/iam.js](src/iam.js) — `/iam` and `/nimi` command parsing
- [test/unit.test.js](test/unit.test.js) — unit tests (`node --test`)
- [scripts/cleanup-topics.mjs](scripts/cleanup-topics.mjs) — one-shot deletion of
  bridge-created topics
- [Containerfile](Containerfile) — container image definition
- [.env.example](.env.example) — configuration template
- [LICENSE](LICENSE) — MIT license text

## License

MIT — see [LICENSE](LICENSE).

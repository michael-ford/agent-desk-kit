# Architecture

There is no server. Three parties are involved, and you run one of them.

| | Runs where | Does what |
|---|---|---|
| **Extension** (service worker) | Your browser | Hosts the build: holds the SSE stream, executes `getHistory` / `getPageHtml`, uploads page HTML, persists the homepage |
| **Extension** (new-tab page(s)) | Your browser | Thin view: subscribes to the worker over a port, renders live progress and the finished homepage |
| **Orchestration layer** | Anthropic | Runs the agent loop, persists the session event log, emits `agent.custom_tool_use` |
| **Session sandbox** | Anthropic | Runs `read` / `grep` / `glob` / `write` over the mounted pages |

The agent loop runs **in the service worker** (`apps/extension/lib/build-manager.ts`), so a build
survives closing the tab, shows up in every open tab, and can run headless on a
`chrome.alarms` schedule. The two custom tools execute in the extension too, because they
need `chrome.history` and `chrome.tabs`. Anthropic never executes them — it emits an event
and waits for a `user.custom_tool_result` on the same authenticated stream. There is no
inbound connection and no public endpoint.

```
service worker        Anthropic loop        sandbox
    │                       │                  │
    ├─ sessions.create ────▶│                  │
    ├─ events.stream ──────▶│  (open first)    │
    ├─ user.message ───────▶│                  │
    │◀─ custom_tool_use ────┤  getHistory      │
    ├─ chrome.history ──────┤                  │
    ├─ custom_tool_result ─▶│                  │
    │◀─ custom_tool_use ────┤  getPageHtml     │
    ├─ tabs + scripting     │                  │
    ├─ files.upload ───────────────────────────▶
    ├─ resources.add ──────────────────────────▶  mounts /mnt/session/uploads/pages/*.html
    ├─ custom_tool_result ─▶│                  │
    │                       ├─ grep / read ───▶│
    │◀─ agent.message ──────┤                  │
    │◀─ status_idle ────────┤  end_turn        │
    ├─ files.list(scope_id) ───────────────────▶  /mnt/session/outputs/homepage.json
    └─ sessions.delete ────▶│                  │
```

### Keeping the worker alive

An MV3 service worker is torn down after ~30s idle, and a build spends most of its
wall clock waiting on the model. Three things keep it alive or bring it back:

- **During a turn**, the in-flight session fetch plus a 20s self-ping
  (`runtime.getPlatformInfo`) reset the idle timer.
- **A 1-minute alarm heartbeat** calls `BuildManager.tick()`. If an
  `activeSessionId` is in storage, the worker reattaches: the orchestrator replays
  the session's event log, re-answers any tool call left hanging, and finishes.
- **The same heartbeat** drives scheduled rebuilds (`lib/auto-rebuild.ts`), so the
  first new tab of the day already shows a fresh homepage.

### Tabs are views

Each new tab connects on a port (`lib/protocol.ts`), receives a snapshot of the
build state, then streams phase/text/log deltas. Every open tab shows the same live
run. A throttled snapshot is also mirrored to storage so a tab opened while the
worker is asleep paints instantly.

The agent writes data, not code: `homepage.json`, validated against
`HomepageData` (`packages/agent-core/homepage-data.ts`) before it is saved, and
drawn by a fixed renderer (`entrypoints/newtab/components/HomepageView.tsx`).
Model-written strings are only rendered as text and links are limited to
http(s). Pages saved before this change were TSX components; they still render
in the Sandpack iframe (`HomepagePreview.tsx`).

### Triage view and comment for the assistant

The page has two views, News (the default) and Triage, which embeds the Intake
Triage app (`../triage` in this kit, a local server on 127.0.0.1:8766, ideally kept
up by a LaunchAgent). The 💬 button on each story sends the reader's prompt with the story's
url and headline to that server's `/api/newtab/comment`, which only answers
this extension's origin and queues `assistant-trigger.sh newtab` for the assistant. If the
server is down, the comment waits in an outbox (`lib/assistant.ts`) that the worker
heartbeat flushes. A tab with the Triage view or a comment box open marks
itself busy, and the worker holds its self-reload until no tab is busy.

### Advisories to the assistant

The model sets `advisory {id, severity}` on security items. After each build,
`lib/advisories.ts` takes the critical and high ones whose `touches` include a
world-list label with a project slug (`- Shop WordPress [example-shop]:
php`) and posts each to the Intake Triage server's `/api/newtab/advisory`, with
the same outbox as comments. The server owns the decision: it dedups per
(advisory, project) for good, caps sessions at 3 a day, and queues
`assistant-trigger.sh advisory`. The assistant starts the assessment session in that
project, or declines with a note to the reader. Real launches are off until the server
runs with `INTAKE_ADVISORY_LIVE=1`. The extension itself can't start a session.

### Seen and read

`packages/agent-core/seen.ts` keeps the page on new stories. A story (keyed by
normalized URL, plus its `update` text if any) is seen once a tab showed it for
3 seconds and a newer build has replaced that page; clicking it (link, chip,
Kobo, comment) makes it read, and read stories leave the page. Each channel's
`slots` is a guaranteed share of new items; shares a channel can't fill go to
the best extra new items elsewhere (the model may list up to 8 extras per
channel). Seen items collapse into "Seen before (n)". The last week's list goes
to the model, which may bring a story back only with `update`. The memory is
the `seenItems` storage key.

### Which build is live

Chrome keeps running the worker's old code after `pnpm build` until the
extension is reloaded, while new-tab pages load fresh from disk. Every build
writes `build-info.json` (`build-stamp.ts`) and bakes the same stamp into the
bundle. The worker records its stamp under `workerBuild` on start, and on each
idle heartbeat reloads itself if the stamp on disk differs (once per pair of
builds, recorded under `selfReload`). The page footer shows the worker's stamp,
and a red banner shows while worker and disk disagree.

## Layout

```
packages/agent-core/      host-agnostic agent loop — imports no chrome.*, browser.*, or node:*
  orchestrator.ts         runHomepageBuild: session lifecycle, event loop, tool dispatch, cleanup
  setup.ts                ensureAgent / ensureEnvironment (created once, cached by ID)
  prompt.ts               system prompt + per-build kickoff message
  reader-profile.ts       who the page is for, scoring and rules shared by all channels
  channels.ts             the four channels: what counts, sources, slots, colour
  homepage-data.ts        HomepageData types, the contract text, validation
  feeds.ts                getFeeds: fetch, parse and window RSS/Atom/JSON feeds
  world.ts                parse the world list (config/world.md), match feed entries against it
  schemas.ts              custom tool input schemas and defaults
  history-digest.ts       narrows raw history to fit a tool result
  types.ts                BrowserBridge, KVStore, RunPhase, …

apps/extension/           MV3 extension (WXT + React)
  entrypoints/
    background.ts         service worker: hosts BuildManager, alarm heartbeat
    scraper.content.ts    injected into scraped tabs: scroll, return HTML
    newtab/               the new-tab UI (thin client onto the worker)
  lib/
    build-manager.ts      single-flight build host, broadcast, keepalive, reattach
    browser-bridge.ts     BrowserBridge over chrome.history / chrome.tabs
    history.ts            getHistory: group and rank chrome.history by domain
    scraper.ts            getPageHtml: load URLs in a background window, sanitize HTML
    protocol.ts           page ↔ worker messages and the five UI build steps
    auto-rebuild.ts       when to rebuild on a schedule
    storage.ts            every chrome.storage key, settings, saved homepage
    transpile.ts          TSX → JS for legacy (pre-data) pages
    build-info.ts         the running build's stamp, disk check, bundled world list
  build-stamp.ts          (build time, Node) stamp + world list for wxt.config.ts

harness/                  Bun scripts: drive agent-core with a fixture/fetch bridge, test the extension
```

## Verification

| Command | Proves |
|---|---|
| `pnpm test` | The history digest is capped, ranked, drops `urls[]`, reports `totalSitesSeen` |
| `pnpm agent:run` | Full build against the real API: tools, mounting, sandbox grep/read, deliverable, cleanup |
| `pnpm agent:verify` | The deliverable transforms, evaluates and server-renders |
| `pnpm agent:resume-test` | A build killed with a tool call pending can be reattached and finished |
| `pnpm agent:retention <sessionId>` | The session and every uploaded page body are actually deleted |
| `pnpm extension:test` | In headless Chrome: worker registers, new tab renders, port protocol answers, `chrome.history` reads |

The `agent:*` commands need `ANTHROPIC_API_KEY` in `.env` and spend API credits. The
harness's bridge uses fixture history and a plain `fetch`, so it can't see
logged-in pages — that's the whole reason `getPageHtml` runs in your browser.

## Gotchas worth knowing

**`mount_path` is always re-rooted under `/mnt/session/uploads/`.** A leading `/` is
stripped, not honored — both at session-create time and via `resources.add()`:

| requested | resolved |
|---|---|
| `/workspace/pages/x.html` | `/mnt/session/uploads/workspace/pages/x.html` |
| `/mnt/session/uploads/x.html` | `/mnt/session/uploads/x.html` |
| *(omitted)* | `/mnt/session/uploads/<file_id>` |

Always report `resource.mount_path` from the response back to the model, never the
path you asked for, or it greps a file that isn't there.

**The result event field is `custom_tool_use_id`**, not `tool_use_id`. (`tool_use_id`
belongs to `user.tool_confirmation` and `user.tool_result`.)

**Never leave an `agent.custom_tool_use` unanswered.** Every path out of the handler
must send a result — a thrown error becomes a result with `is_error: true`, never a
reason to skip the send. An unanswered tool call idles the session forever.

**Don't break on `session.status_idle` alone.** The session idles every time it waits
for a tool result. Break only on `status_terminated`, or on `status_idle` where
`stop_reason.type !== "requires_action"`. And run the terminal check for *every* event,
including deduped ones — `continue`-ing on a duplicate can skip the terminal event that
arrived in the history fetch.

**`event_start` / `event_delta` stream events carry no `id`.** Skip them before dedupe.

**`files.upload()` takes no `purpose`.** Just `{ file }`.

## Privacy

The session event log persists every domain, title and scraped page body server-side
until deleted, and uploaded files persist independently. `runHomepageBuild` deletes
both in a `finally`. Confirm retention/ZDR eligibility against current docs before
distributing this.

The API key lives in `chrome.storage.local`, readable by anyone with access to the
browser profile. Fine for a tool you run yourself; **do not ship this to the Web Store**
without moving the key behind a proxy.

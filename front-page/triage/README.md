# Intake triage

A small local web app for working through the intake pages your assistant's
sweep writes to `<vault>/agent/intake/YYYY-MM-DD-intake.md` (`<vault>` is any
folder of markdown notes kept in git, such as an Obsidian vault). You can view them as a stack or
one item at a time, with buttons and keys for each action and mic dictation
for anything you'd rather say than type.

## Run

```
./run.sh          # then open http://127.0.0.1:8766
./run.sh --open   # also opens the browser
```

To keep it running all the time on a Mac, install it as a LaunchAgent (see
`launchd/com.example.intake-triage.plist` in this folder: RunAtLoad and
KeepAlive; edit the paths and keys first). Stop it with
`launchctl bootout gui/$(id -u)/com.example.intake-triage` before running
`run.sh` by hand, since `run.sh` refuses a port that is already in use.

The server is a single Python file (stdlib only), started through `uv run`.
There is no build step and there are no dependencies. It binds to 127.0.0.1
only.

| Env var | Default | Purpose |
|---|---|---|
| `INTAKE_VAULT` | `~/vault` | Vault root (a git repo) |
| `INTAKE_SUBDIR` | `agent/intake` | Where the intake pages live |
| `INTAKE_PORT` | `8766` | Port (the extension expects 8766; change both together) |
| `INTAKE_GIT` | `1` | `0` turns off the auto-commit |
| `INTAKE_TZ` | `America/Los_Angeles` | Time zone for stamps and dates |
| `INTAKE_PROJECTS` | `projects` | Project folders inside the vault (advisories check `<slug>/current-state.md`) |
| `INTAKE_EDITION` | `<vault>/agent/edition/current.md` | Where the morning edition's markdown copy is written |
| `INTAKE_OWNER_NAME` | `the owner` | Your name, for the Talk it through instructions |
| `INTAKE_GROQ_SECRET` | `env:GROQ_API_KEY` | Secret spec for the Whisper fallback |
| `INTAKE_TRIGGER` | `~/assistant/scripts/assistant-trigger.sh` | Script that wakes the assistant for an Ask or a newtab comment. `0` turns it off |
| `INTAKE_ADVISORY_LIVE` | off | `1` lets newtab advisories start real agent session; off, the assistant is told what it would have launched |
| `INTAKE_ADVISORY_CAP` | `3` | Advisory sessions a day; after that each advisory is an AGENT-board issue only |
| `INTAKE_NEWTAB_ORIGIN` | `chrome-extension://komhiagljgdhghicimkkjjmnldebhmne` | The new-tab extension: the only other origin that may frame the app or send a newtab comment. **Set this to your own extension's id** (shown in `chrome://extensions`); an unpacked extension's id follows its folder path |
| `INTAKE_JEV_SECRET` | `env:JEV_API_KEY` | Secret spec for Jev, an optional decision model (voice tier 2); without it the LLM decides |
| `INTAKE_JEV_MODEL` | `jev-latest` | Jev model |
| `INTAKE_JEV_MIN_CONFIDENCE` | `0.8` | Below this, the LLM decides instead |
| `INTAKE_LLM_SECRET` | `env:OPENROUTER_API_KEY` | Secret spec for the LLM fallback |
| `INTAKE_LLM_MODEL` | `openai/gpt-4.1-mini` | LLM used through OpenRouter |
| `INTAKE_TALK_PROVIDER` | `openai` | Talk it through provider: `openai`, or `fake` for demos and browser tests |
| `INTAKE_TALK_MODEL` | `gpt-realtime-2.1` | Realtime model (`gpt-realtime-mini` is about a third of the cost) |
| `INTAKE_TALK_REASONING` | `low` | `minimal`, `low`, `medium`, `high` or `xhigh` (gpt-realtime-2 models only) |
| `INTAKE_TALK_VOICE` | `cedar` | Output voice |
| `INTAKE_TALK_TRANSCRIBE` | `gpt-4o-mini-transcribe` | Transcribes the owner's side (captions and batch consent) |
| `INTAKE_TALK_NOISE` | `far_field` | `near_field` for a headset |
| `INTAKE_TALK_SECRET` | `env:OPENAI_API_KEY` | Secret spec list; the first that resolves wins |

A **secret spec** is `env:NAME` (read the environment variable `NAME`) or
`file:KEY`, which runs `sec get file KEY` if you keep secrets in a SOPS/age
wrapper called `sec`. Keys are read per request and never logged.

## Tests

```
uv run --no-project --python '>=3.11' tests/test_roundtrip.py ../examples/notes/agent/intake/2026-01-15-intake.md
uv run --no-project --python '>=3.11' tests/test_voice.py          # add --live for one real Jev + LLM call
node --test tests/voice_session.test.mjs
uv run --no-project --python '>=3.11' tests/test_talk.py
node --test tests/talk_controller.test.mjs
```

`test_roundtrip.py` runs every action against a copy of the page in a
throwaway git vault, with a fake assistant trigger. It checks byte-exact
round-trips, single-path commits, 409 on a stale line, undo, phase tags,
reclassify, Ask and the assistant's answer pairing, and `/api/voice`. It never touches
your real vault. `test_voice.py` covers the grammar and the mocked model tier.
`voice_session.test.mjs` drives continuous listening with a fake recognizer.
`test_talk.py` runs every Talk it through tool against a throwaway git vault:
commits, bad ids and dates, the batch consent gate, undo, the tool schemas, the
provider config, and the key never reaching the browser or an error message.
With `--live` (`uv run --no-project --python '>=3.11' --with websockets
tests/test_talk.py --live`) it also mints one real client secret and asks for
a three-word hello with tools off. `talk_controller.test.mjs` drives the
conversation controller with a fake transport and clock: tool calls, cancelled
responses, consent waiting for the transcript, app updates only when idle,
endings, idle stop, reconnects without replayed tool calls, and renewal.

## Two phases

Each page is worked in two passes. **To act on** comes first, one card at a
time by default. **Awareness** follows: a compact digest grouped by project,
where each row opens to show its notes, a comment box and an Ask box.

An item's phase comes from a trailing `#action` or `#awareness` tag (hidden
from the displayed text). Untagged items are guessed: awareness if the text
says "awareness" or the board is `n/a`, otherwise action. "Just awareness?" /
"Needs action?" under a card rewrites the tag in place and commits it.

The assistant's own notes (`- Assistant (...)`) show quietly under the item. When one says
it "looks resolved", the note carries a one-tap **Yes, done**.

## Ask

Ask (`a`) writes `  - Me (YYYY-MM-DD HH:MM PT) ? question` under the item,
commits it, and runs `assistant-trigger.sh triage "<page>|<item start>|<question>"`.
The assistant answers by adding `  - Assistant (YYYY-MM-DD HH:MM PT): answer` directly
below. While a question is open the app checks every 5 seconds and shows
"The assistant is thinking"; after 3 minutes it says no answer has come yet. The answer
unfolds inline when it lands.

## The AI newtab

The new-tab extension (`../extension`) embeds this app as its Triage
view, and sends "comment for the assistant" through it. `POST /api/newtab/comment`
(`{url, headline, prompt}`) answers only the extension's origin, writes nothing
to the vault, and runs `assistant-trigger.sh newtab "<url>|<headline>|<prompt>"`
(ASCII, one line, `|` escaped) synchronously, so a failed trigger comes back as
an error. A `frame-ancestors` header lets only the app itself and the extension
frame it.

`POST /api/newtab/advisory` (`{id, severity, projects, url, headline, action}`,
same origin check) is the newtab reporting a critical or high security advisory
that touches vault projects. It drops slugs with no
`<vault>/projects/<slug>/current-state.md`, skips any project this advisory
(same id or same url) already fired for, and runs `assistant-trigger.sh advisory
"<mode>|<id>|<severity>|<projects>|<url>|<headline>|<action>"`. mode is `LAUNCH`
for the first `INTAKE_ADVISORY_CAP` (3) a day and `ISSUE-ONLY` after that. Both
are prefixed `DRYRUN-` unless the server runs with `INTAKE_ADVISORY_LIVE=1`, and
dry runs never block real ones. The ledger is `.state/advisories-<vault hash>.json`.

## Voice

The mic in the header (or `l`) starts one listening session for the whole
queue. It stays on from card to card, and into the awareness digest, until you
say "stop" or "pause" or tap it again. A bar along the bottom shows that it is
listening, the words it hears, and what it did. Each command shows a 3 second
toast with Undo, then moves on. Anything that isn't a command shows the
transcript and changes nothing.

Chrome ends recognition on its own after silence and after about a minute;
the session restarts it straight away. Speech that arrives while a command is
being applied is ignored, and so is the app's own toast text if the mic picks
it up.

Commands are parsed in two tiers. A local grammar handles the common phrasings
("done", "drop it because ...", "Monday", "snooze till next week", "comment ...",
"ask ...", "tell the assistant ...", "next", "back", "skip", "undo", "stop"). Anything
else goes to Jev, accepted at 0.8 confidence or more, and then to an LLM with a
strict JSON schema. Dates are resolved locally where possible and validated
(no past dates), and anything that fails validation counts as unknown. Keys
are read per request (see the secret spec above), and never logged.

## Talk it through

`T`, or the **Talk it through** button, opens a dock along the bottom and starts
a spoken conversation about the whole page with a realtime voice model. It
plays a sharp chief of staff who has read everything: it raises what matters
first, groups related items, proposes dispositions, answers from the page and
the assistant's notes, asks the assistant when the page doesn't say, and follows your lead. It
isn't scripted. It gets context (who you are, what the intake is, every open
item with its tags, age and the assistant's evidence, today's date), its
job, and rules it has to keep. Those rules are enforced in code where possible:

- Every change goes through the same `do_action` / `do_undo` path the buttons
  use, so each is a path-scoped commit with undo. The model is told a change
  happened only from the tool's own result.
- One clear instruction about one item applies straight away and shows in the
  **Changes** log with Undo. Anything covering several items goes through
  `batch`, which only proposes. It runs after you say a clear yes (checked by
  the server against the transcript of what you actually said after the
  proposal) or tap **Yes, do it**. The model can't approve its own proposal.
- Tools: next_item, get_item, mark_done, drop, reschedule (no past dates,
  nothing over a year out), add_comment, reclassify, undo_last, ask_assistant,
  hand_to_assistant, batch. No web, no shell, nothing that leaves the page.
- ask_assistant returns at once. Its answer is passed in as an app update at the
  next quiet moment, never while you're talking.
- It ends on "that's all", "stop", "we're done" or "bye", after its goodbye
  finishes, or after three quiet minutes. If the line drops, or the
  provider's 60-minute session limit nears, it reconnects with the action log,
  the last few captions and the item on screen, and carries on without
  greeting you again. Tool calls from a dead connection are never replayed.

Use headphones if you can: the browser's echo cancellation is good, not
perfect, and on laptop speakers the model can hear itself.

**Why OpenAI `gpt-realtime-2.1`.** It's a reasoning speech-to-speech model with
tool calling, adjustable reasoning effort and a 128k context, so it can hold the
whole page and think about it rather than just transcribe. Gemini Live was
ruled out. Grok had speech-to-text and text-to-speech at build time, but no
documented realtime speech-to-speech agent API with tool calling. ElevenLabs
Agents would pair a strong LLM with excellent voices, but it's a managed agent
platform with more moving parts for a local tool. The **provider seam** is `PROVIDERS` in `talk.py` (mint connection
details from instructions plus neutral JSON-schema tools) and
`static/talk-<provider>.js` (turn provider events into neutral ones). The
controller, `talk.js`, knows neither.

**Key handling.** The API key stays on the server. Per session it's read
from the first spec in `INTAKE_TALK_SECRET` that resolves, used once to mint an
ephemeral client secret that expires in 120 seconds, with the instructions and
tools baked in, and then dropped. The browser gets only the ephemeral secret
and uses it once to open WebRTC with OpenAI; the audio then flows between the
browser and OpenAI directly. The key is never logged or echoed, and provider
errors carry only the provider's own message.

**Cost.** gpt-realtime-2.1 costs $32/$64 per 1M audio tokens in/out and $4/$24
for text, with cached input at $0.40. The page instructions are about 7k
tokens and are mostly cached after the first turn. At low reasoning, a working
session comes to roughly $0.05 to $0.15 a minute, so a 15-minute pass costs
about $1 to $2. `INTAKE_TALK_MODEL=gpt-realtime-mini` is about a third of that.

**Demo without a key.** Set `INTAKE_TALK_PROVIDER=fake`. The browser then
exposes `window.__talkFake`, with `user(text)`, `aide(text)`, `tool(name,
args)` and `drop()`, so you can play the model.

## Shortcuts

The arrow keys move between items (left/right on a single card, up/down in the
stack and the digest). `j` goes back and `k` goes forward. `p` switches phase
and `l` starts or stops listening. `T` (shift-t) opens or closes Talk it
through. The action keys are:

- `d` Done, with an optional note (`D` skips the note)
- `r` Reschedule: `1` tomorrow, `2` Monday, `3` next week, or pick a date
- `c` Comment
- `a` Ask the assistant
- `x` Drop, with an optional reason
- `m` Hand to the assistant
- `1`–`9` pick an answer, when the item asks a question (see below)

`Space` starts dictating a comment: tap to start or stop, or hold to talk.
`Enter` saves and moves on to the next item. Every action advances except Ask,
which stays on the card because the assistant's answer lands there. `Esc` cancels. The
other keys:

- `u` undo the last action (the undo stack survives a restart)
- `v` switch between the stack and one at a time
- `s` show or hide snoozed items
- `t` switch the theme
- `?` open help

## What each action writes

Times are in `INTAKE_TZ` (default America/Los_Angeles); the stamp suffix is `PT`. Change `stamp()` in `server.py` if you want another label.

- **Done:** `- [ ]` becomes `- [x]`, and the line gets `— done (Me, YYYY-MM-DD HH:MM PT)`, plus `: note` if you add one.
- **Choose:** like Done, with the answer: `— done (Me, YYYY-MM-DD HH:MM PT): chose "Keep"`, plus `; note` if a note was typed in the Done box or said ("keep, because the docs use it").
- **Drop:** `- [x]`, and the line gets `— dropped (Me)`, plus `: reason` if you add one.
- **Reschedule:** the line gets `— snoozed until YYYY-MM-DD` and stays `[ ]`. Rescheduling again replaces the marker. Any text you add becomes a comment. The item is hidden until that date unless you tick "Snoozed".
- **Comment:** adds an indented sub-bullet after any existing ones: `  - Me (YYYY-MM-DD HH:MM PT): text`.
- **Ask:** `  - Me (YYYY-MM-DD HH:MM PT) ? question`, then the trigger above.
- **Reclassify:** removes any `#action`/`#awareness` tag and puts one at the end of the item text, before any snooze or done marker.
- **Hand to the assistant:** adds the same sub-bullet with the text `→ Assistant: text`. It also appends `- [ ] <stamp> — [[<page>]] — <excerpt> — Me → Assistant: text` to `agent/intake/triage-inbox.md`, creating that file if needed.

Before every write the server re-reads the file and finds the item by its exact
line text, not by line number. If the line has changed (the assistant edited it, or
the sweep rewrote the page) the write is refused with a conflict and the page
reloads. Lines are written atomically, with the original line endings and the
trailing newline kept.

After each write, the server runs `git add -- <path>` and then
`git -C <vault> commit -m "intake triage: <action> — <excerpt>" -- <path>` for
exactly the touched path or paths. Anything else staged in the vault stays out
of the commit. If it hits an `index.lock`, it retries for about 8 seconds. If
the commit still fails, the change stays saved on disk and the UI shows a
sticky warning.

## Decision options

When an action item poses one decision, the server lists its choices as
`options` and the card shows them as numbered chips above the action row.
`parse_options` in `server.py` reads three forms, and shows nothing when unsure:

1. a slash parenthetical tied to a question: `… (yes / no)?` or `…? (retire / keep)`
2. `Yes = …; no = …`
3. one inline question with one `, or `: "Retire the old project, or keep it?"
   Short choices keep their words ("Send them" / "Leave it to Pat"); long ones
   are cut to their first word ("Send" / "Set").

Items that number several questions, or ask more than two, never get chips.
In voice mode, the answer is the command: "yes", "nope", "keep it", "option
two", "the first one", "keep because …". Done, drop, next and the other
commands still win over an option word. Talk it through sees the options and
records an answer with `choose_option`.

## File format contract (what the parser assumes)

- An item is `- [ ] body` or `- [x] body`, and fields are separated by ` — ` (an em dash with spaces).
- `body` is `[MM-DD] source — text — BOARD — project`. The `[MM-DD]` tag is optional; without it the item dates from the file's own date. A tag that falls after the file date is read as the previous year.
- The board is the right-most segment that is exactly `AGENT`, `ME` or `n/a` (rename them in `server.py` to match your own boards), optionally followed by `(note)`. The project is the next segment. With no board, a short final segment (30 characters or fewer, after at least two other segments) is taken as the project.
- The source is the first segment, but only when it is 70 characters or fewer and at least one other segment comes before the board.
- Sub-bullets indented under an item belong to it. They are shown as notes and move with it.
- Items wrapped across several lines aren't expected. If one did appear, a done or drop marker would go on its first line.
- Two identical lines are told apart by their order of appearance.
- Text keeps its markdown when shown: bold, italic, `==highlight==`, `code`, `[[wikilinks]]` (which open in Obsidian), links and bare URLs.

## Dictation

The primary path is Chrome's Web Speech API (`webkitSpeechRecognition`, en-CA
or en-US, chosen under `?`). Interim words show live, and recognition restarts
automatically through Chrome's pauses for silence. Audio goes to Google's
speech service.

If Web Speech isn't available, or it fails with a network error, the app
switches to recording locally with MediaRecorder. It posts the clip to
`/api/transcribe`, and the server sends it to Groq Whisper (`whisper-large-v3`).

The server reads the key per request from `INTAKE_GROQ_SECRET` (default
`env:GROQ_API_KEY`). It is never logged and never stored. Without a key the
fallback returns a clear "no key" message, and Web Speech works without it.

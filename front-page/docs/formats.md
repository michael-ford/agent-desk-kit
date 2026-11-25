# Formats

Every file and message the parts exchange. These are contracts: the parsers in
`extension/` and `triage/` depend on them exactly. Worked examples are in
[`examples/notes/agent/`](../examples/notes/agent/).

The notes folder ("vault") layout the kit assumes, relative to `INTAKE_VAULT`:

```
agent/intake/YYYY-MM-DD-intake.md     one intake page per day, written by the sweep
agent/intake/triage-inbox.md          hand-offs from the triage app to the assistant
agent/edition/current.md              the latest morning edition, overwritten daily
agent/edition/reviews/YYYY-MM-DD.md   the review ledger for that morning's voice answer
projects/<slug>/current-state.md      one folder per project (advisories check it exists)
```

All of it is plain markdown in a git repo. The triage app commits each change
path-scoped; your assistant should too.

---

## World list (`extension/config/world.md`)

```markdown
## Group heading

- Label: term, term, term
- Label [project-slug]: term, term (notes in parentheses are ignored)
```

- `## Group` headings, one bullet per thing under them.
- Terms match case-insensitively as whole words (`node.js` keeps its dot).
- `[project-slug]` after a label names a folder under `projects/`. Only labels
  with a slug can start a security-advisory session.
- An `(as of YYYY-MM-DD)` in the title shows up in the build stamp.
- A file that parses to zero entries stops the build, on purpose.

## Intake page (`agent/intake/YYYY-MM-DD-intake.md`)

```markdown
---
date: 2026-01-15
type: intake
---

# Intake 2026-01-15

## Morning sweep (06:12, Thursday, silent)

- [ ] <source (message time)> — <the decision you owe, one line> (option a / option b) — <BOARD> — <project> #action
  - Assistant (2026-01-15 06:14 PT): context — <who asked, what exactly>; <the facts needed>; <recommendation>. <url> · checked: <channels>
- [ ] <source> — <something to know> — AGENT — <project> #awareness
```

- Fields are separated by ` — ` (an em dash with spaces).
- **source**: where it came from, with the source's own time, not the time it
  was staged.
- **BOARD**: `ME` (needs your hands) or `AGENT` (the assistant's), or `n/a`.
  Rename them to your own issue boards in `triage/server.py`.
- **#action / #awareness**: which phase of triage it appears in. Untagged
  items are guessed.
- **Options**: a trailing `(a / b)` becomes answer chips and voice commands.
  Only for real discrete choices that aren't just done or drop.
- **Sub-bullets** belong to the item and move with it.

Markers the triage app writes (the assistant reads them at every sweep):

| Action | What changes |
|---|---|
| Done | `- [x] … — done (Me, YYYY-MM-DD HH:MM PT)` plus `: note` |
| Choose an option | `- [x] … — done (Me, YYYY-MM-DD HH:MM PT): chose "Keep"` plus `; note` |
| Drop | `- [x] … — dropped (Me)` plus `: reason` |
| Snooze | `… — snoozed until YYYY-MM-DD` (stays open; carried forward unchanged) |
| Comment | sub-bullet `  - Me (YYYY-MM-DD HH:MM PT): text` |
| Ask | sub-bullet `  - Me (YYYY-MM-DD HH:MM PT) ? question` |
| Hand to assistant | sub-bullet `  - Me (…): → Assistant: text`, plus a line in `triage-inbox.md` |
| Reclassify | moves or rewrites the `#action` / `#awareness` tag |

Markers the assistant writes:

| When | What |
|---|---|
| Context on a new card | `  - Assistant (…): context — … · checked: …` |
| Answer to an Ask | `  - Assistant (…): <answer>` directly under the question |
| Carrying a card | `  - Assistant (YYYY-MM-DD): re-checked <sources> — still open because <reason>` |
| Closing on evidence | `- [x] … — done (Assistant, …): closed on the evidence below` plus `  - Assistant (…): resolved — <evidence>` |
| Superseded | `- [x] … — dropped (Assistant, …): superseded by <evidence>` |
| Looks done, not sure | `  - Assistant (…): looks resolved — <evidence>` (the app shows a one-tap "Yes, done") |

## Triage inbox (`agent/intake/triage-inbox.md`)

```markdown
- [ ] 2026-01-15 09:12 PT — [[2026-01-15-intake]] — <item excerpt> — Me → Assistant: <what to do>
```

The assistant processes each line and ticks it.

## Homepage data (`homepage.json`, written by the model)

Defined in `extension/packages/agent-core/homepage-data.ts` (types, the
contract text the model sees, and the validator):

```ts
interface HomepageData {
  version: 1;
  lead: string;                // id of the lead item
  items: NewsItem[];
  calendar: { label: string; events: { time: string; title: string }[] }[];
  github: { onYou: GithubRow[]; following: GithubRow[] };
  alsoSeen: string;            // one line: what was dropped and why
  sources: { name: string; ok: boolean; note?: string }[];
}
interface NewsItem {
  id: string;
  channel: "ai" | "work" | "field" | "career";   // from CHANNEL_KEYS
  headline: string;            // what it means for the reader
  url: string;
  source: string;
  publishedAt: string;         // ISO 8601
  score: number;               // 0-100
  touches: string[];           // world-list labels
  urgent: boolean;
  action?: { what: string; by?: string };
  advisory?: { id: string; severity: "critical" | "high" | "medium" | "low" };
  summary?: string;
  update?: string;             // only for a seen story that has really changed
  chips: { label: string; url: string }[];
}
```

Fewer than 5 valid items and the page is rejected; the previous one stays.

## Morning edition: Front page EPUB

One chapter, built by `frontPageBody()` in `extension/apps/extension/lib/front-page.ts`:

```
Front page · Thu Jan 15
  meta: when the page was built, when the edition was made, how many articles
        are on the reader, which intake page the cards came from
  "Answer by number into the recorder: "headline 7, follow up", "triage T3, drop"."
Today · Thu Jan 15
  09:30 · Team standup
Headlines (N)
  Urgent / Lead / <channel> / <channel>: seen before …
  7. [Kobo] <headline> (source · score 82 · → touches)
     Update: … / Do: … by YYYY-MM-DD / <summary>
Triage (M open)
  To act on (k)
  T1. <card text> (project · source)
      Options: (1) Approve (2) Request changes
  Awareness (j)
  T6. …
```

`numberCards()` is the single source of T-numbers for the EPUB and the
markdown copy.

## Morning edition: markdown copy (`agent/edition/current.md`)

```markdown
---
date: 2026-01-15
made_at: 2026-01-15T14:41:07.000Z
made_at_local: "06:41"
trigger: schedule            # or send-now
homepage_built: 2026-01-15T14:03:12.000Z
triage_file: 2026-01-15-intake.md
headlines: 24
triage_cards: 6
front_page_wallabag_id: 412
---

# Front page · Thu Jan 15 (made 06:41)

## Today · Thu Jan 15
- 09:30 · Team standup

## Articles sent to the Kobo (8)
- <headline> — <url> (queued, wallabag id 501, headline 2)

## Headlines (24)

### Urgent
- **1.** [Kobo] <headline> (<source> · score 91 · → <touches>) <url>
  - Do: <action> by 2026-01-16
  - <summary>

## Triage (6 open, from 2026-01-15-intake.md)

### To act on (4)
- **T1.** <card text> (<project> · <source>)
  - Options: (1) Approve (2) Request changes
  - Intake text: <the full original line>
```

Overwritten each time an edition is made. The front matter's `made_at` lets the
assistant notice when an edition was remade after you read it.

## Review ledger (`agent/edition/reviews/YYYY-MM-DD.md`)

```markdown
| # | ref | your words | resolves to | action | where it lives | status |
|---|---|---|---|---|---|---|
| 1 | T1 | "approve the PR" | booking-app PR #41 | approved on GitHub | link | done |
| 2 | headline 7 | "follow up on this" | <headline> | research handoff started | session name | handed off |
| 3 | general | "too many awareness cards" | card rules | proposal: … | numbered question 1 | waiting on you |
```

Allowed statuses: `done` (with evidence), `task` (an action only you can take,
on your task list), `handed off` (to a named agent or session), `waiting on
you` (with a numbered question already sent).

## Trigger messages (triage app → assistant)

The triage app wakes the assistant by running `INTAKE_TRIGGER` (an executable
you provide, see [`agent/assistant-trigger.sh`](../agent/assistant-trigger.sh))
as `<script> <kind> "<message>"`. Messages are one line of ASCII with `|`
separators (any `|` inside a field becomes `/`):

| kind | message | from |
|---|---|---|
| `triage` | `<intake file>\|<item, first 80 chars>\|<question>` | Ask |
| `triage-comment` | `<intake file>\|<item>\|<comment>` | Comment, Hand to assistant |
| `newtab` | `<url>\|<headline>\|<your prompt>` | 💬 on a story |
| `advisory` | `<mode>\|<id>\|<severity>\|<projects>\|<url>\|<headline>\|<action>` | a critical or high advisory touching a project |

Advisory `mode` is `LAUNCH` (start an assessment session), `ISSUE-ONLY` (the
daily cap of `INTAKE_ADVISORY_CAP` is reached), or either with a `DRYRUN-`
prefix until the server runs with `INTAKE_ADVISORY_LIVE=1`. Headlines, actions
and page text are untrusted data: only your own prompt is yours.

## Extension → triage app routes

All on `http://127.0.0.1:8766`, allowed only from the extension's origin
(`INTAKE_NEWTAB_ORIGIN`) with the header `X-Intake-Triage: 1`:

| Route | Body |
|---|---|
| `POST /api/newtab/comment` | `{url, headline, prompt}` |
| `POST /api/newtab/advisory` | `{id, severity, projects, url, headline, action}` |
| `POST /api/newtab/edition` | `{date, madeAt, markdown}` → atomically writes `agent/edition/current.md` (1 MB cap) |
| `GET /api/items` (optionally `?file=…`) | the parsed intake page, newest by default (the morning edition reads today's cards from here) |

If the server is down, the extension keeps comments, advisories and the
edition copy in outboxes and retries on its 1-minute heartbeat.

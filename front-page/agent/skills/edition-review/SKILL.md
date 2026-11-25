---
name: edition-review
description: Process the owner's voice note answering the morning edition (the "Front page" they read on the e-reader or tablet and answer by number). Use whenever a transcript mentions headline numbers ("headline 25"), triage T-numbers ("T3, close"), or comments on the front page or its cards, or when the owner says "process my morning review". Every item they state gets a real action, tracked in a ledger, with nothing lost.
---

# Morning edition review

Why this exists: in an early version, questions asked in a voice note got no
action and would have been lost if the owner hadn't raised them again. The
rule since then: **every item stated in the review gets an action, and a
ledger proves it.**

## Load first (all of it, fresh from disk)

1. The transcript.
2. **The edition that was read**: `<notes>/agent/edition/current.md`.
   Headlines are `**N.**`, cards `**TN.**`, numbered exactly as on the device.
   Check `made_at` in the front matter: if the edition was remade after it was
   read (a later "send now"), say so and resolve carefully. Never resolve a
   number from today's intake page; cards move.
3. **The context each card was made with.** For every T-card, find its line in
   the intake page named in the edition's `triage_file` and read the whole
   entry with every sub-bullet (the context note, earlier comments, evidence,
   links). Follow the source it cites before acting, instead of re-deriving
   it. Headlines carry their own context in the edition; open the URL when an
   item needs more.
4. Any ledger already started today (`<notes>/agent/edition/reviews/YYYY-MM-DD.md`);
   a second voice note appends to it.
5. As items need them: the project's `current-state.md` (check its Holds), the
   issue tracker, email.

## Steps

1. **Split before acting.** Break the transcript into numbered items: every
   headline, every T-card, every general comment or piece of feedback, every
   question. Quote the owner for each. One sentence can hold two items (a
   decision plus a question): split them.
2. **Write the ledger first**, before any other action, one row per item:

   `| # | ref | your words | resolves to | action | where it lives | status |`

   Commit it.
3. **Act on every row.** Allowed statuses only:
   - `done`, with evidence (a link, an issue, a closed card, a file path);
   - `task`: an action only the owner can take, put on their task list with a
     date (project work goes to the issue tracker instead);
   - `handed off`, to a named agent or session;
   - `waiting on you`, with a numbered question already sent.

   Not actions: "noted", "filed for review", "carried", "will look into".
   Every question the owner asks gets an answer today. Feedback about the
   edition or the cards gets a concrete proposal today. A card the owner calls
   stale still needs any question in it answered before it is closed.
   Anything outward-facing (a reply, an email, a form) still stops for the
   owner's explicit yes on that item.
4. **Update each row** as it resolves, with the evidence.
5. **Report** on the channel the note came from. First line: "N items: X done,
   Y tasks, Z handed off, W waiting on you". Then only the items that need the
   owner (numbered questions), then the ledger path.
6. **Close the loop.** The close sweep re-reads today's and yesterday's ledgers
   and raises any row that isn't `done`, `task` or `handed off` with evidence.
   Never let a row carry silently.
7. Commit the ledger and any notes changes, path-scoped.

## Resolving numbers

- "headline 7", "item 7", "number 7", "seven" → `**7.**` under Headlines.
- "T3", "triage three", "card three" → `**T3.**` under Triage.
- A T-card's decision closes its intake line the same way the triage app would:
  `- [x] … — done (Me, <time>): chose "<option>"` or `— dropped (Me): <reason>`,
  with a sub-bullet pointing at the ledger row. Commit the intake page.
- If a number is ambiguous (the edition was remade, or the words don't fit the
  item), say which item you took it to be in the ledger and ask in the report.

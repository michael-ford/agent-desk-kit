# Voice to GitHub handoff

Think out loud with a voice model, then let an agent pick up the result. This
suits planning, brainstorming and "what should this be" work, which goes
better as a conversation than as typed prompts, and it gets you away from
the screen.

## The loop

1. **Talk.** Open ChatGPT's two-way voice mode (on a walk, the treadmill, the
   drive). It is not the strongest model, but it is a good conversation
   partner, and it can read the repo or notes you connect it to (GitHub
   connector; your notes folder if it lives in a repo).
2. **Ask for a handoff.** When you're done: "Write this up as a handoff and
   commit it to `<repo>` at `handoffs/<topic>.md`." The connector writes the
   file. (Any assistant with write access to a repo works the same way, as does
   a Notion or Google Docs page your agent can read.)
3. **Agent picks it up.** Either tell your desk agent on Telegram ("new handoff
   in handoffs/<topic>.md"), or let a trigger do it:
   `agents/agent-trigger.sh <bot> handoff "handoffs/<topic>.md"` from a GitHub
   webhook, a scheduled `git pull` that spots new files, or by hand.
4. **Agent plays it back.** It reads the handoff, does its own research, and
   replies with its plan and numbered questions before building anything big.

## What a good handoff holds

The voice model wants to give you a solution. Ask it for the problem instead;
the agent that does the work will research more deeply than a chat can, and a
plan written in the conversation anchors it onto a shallower path.

```markdown
# <Topic>: handoff

## What this is
What came up and what is being asked. The problem, not the solution.

## Scope of this document
Not a spec. The context may be incomplete, the open questions are not
exhaustive, and there may be problems it does not name. The receiving agent
does its own research and forms its own plan.

## The problem as I said it
The key things I said, close to verbatim.

## Context surfaces
Pointers: repos, paths, issues, PRs, docs, URLs. One neutral line each on what
it appears to contain.

## Open questions
Numbered. Including the ones only I can answer.
```

Leave out: a work list, an order of steps, estimates, "the smallest version".
Those are the receiving agent's output.

## Variations

- Any chat app with voice and a connector to where your agent reads (Notion,
  Google Docs, a repo) works the same way.
- A plain voice memo works too: record it, transcribe it, and send the
  transcript to the agent with "this is a brain dump; propose a plan before
  creating anything".
- The morning edition's voice review ([`../front-page/`](../front-page/)) is
  the same idea on a schedule: you answer a printed list by number into a
  recorder, and the agent turns each answer into an action.

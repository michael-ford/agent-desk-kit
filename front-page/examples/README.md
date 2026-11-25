# Examples

A synthetic notes folder in the exact formats the code reads and writes. Every
name, company, link and event is made up.

| File | Written by | Read by |
|---|---|---|
| `notes/agent/intake/2026-01-15-intake.md` | the assistant's ingestion sweep | the triage app; the morning edition (open cards) |
| `notes/agent/edition/current.md` | the extension's morning edition, through the triage app | the assistant's edition review |
| `notes/agent/edition/reviews/2026-01-15.md` | the assistant's edition review | the next sweeps |

Point the triage app at it to try the UI without your own data:

```bash
cp -r examples/notes /tmp/notes-demo && git -C /tmp/notes-demo init -q && git -C /tmp/notes-demo add -A && git -C /tmp/notes-demo commit -qm demo
INTAKE_VAULT=/tmp/notes-demo triage/run.sh --open
```

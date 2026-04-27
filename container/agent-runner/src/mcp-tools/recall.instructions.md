## Memory recall (`recall`)

Your structured memory lives in `/workspace/group/memory/*.md`. Don't read those files at session start - **call `recall(query)` when you need a fact.**

### How it works

1. You call `recall({ query: "Pi5 backup schedule" })`
2. Tool searches all memory files, splits them by section, scores chunks by query-term overlap
3. Returns top matches with: source file, header, body, `kind:`, and a freshness assessment derived from `verified-on:`

### When to call

- Kyle references a fact you might have stored (his family, infra, channels, services, decisions, scheduled tasks)
- You need a procedure (how to register a group, how to schedule a script-gated task)
- You're about to recommend an action and want to confirm a remembered constraint (SSH rules, hard rules)

### When NOT to call

- The fact is in the runtime system prompt or your persona spec already (your name, your hard rules, today's date)
- It's observable state, not config (is Pi5 up right now? — `ssh` or `systemctl`, not `recall`)
- The user just told you the answer in this turn

### Reading the freshness line

- `freshness: fresh` — verified within the last 30 days, act on it
- `freshness: STALE` — verified more than 30 days ago, verify against reality before acting (run the check, ask Kyle, etc.)
- `freshness: unknown` — file lacks a `verified-on:` date; treat with suspicion

### Writing new facts

When you learn something durable that fits an existing memory file, edit the file and bump its `verified-on:` to today's date. When you create a new file, give it frontmatter:

```yaml
---
kind: config       # or procedural | state | reference
verified-on: YYYY-MM-DD
---
```

### Config vs state

Memory is for **config** (stable facts: Tailscale IPs, mount paths, who's family, scheduled task definitions) and **procedural** (how-to: registering a group, gating a recurring task with a script). It is NOT for **state** (is Pi5 up, when did the last backup run, what services are running). State is always queried live. The one allowed state file is `pending-todos.md` because it's an explicit queue Kyle owns, not observable world state.

If you're tempted to write down the result of a `systemctl` check or a `df -h`, don't — write the procedure for checking it instead, and re-check next time.

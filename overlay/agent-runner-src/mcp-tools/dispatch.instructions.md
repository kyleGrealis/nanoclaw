## Dispatching sub-agents (`dispatch_task`)

⚠ **Status: scaffolded, not yet live.** Calls are recorded but no worker is spawned. Don't use this for real work today — keep handling things yourself. The signature is documented so the day the host-side dispatcher lights up, you'll already know how to call it.

### When you'd use it (future)

`mcp__nanoclaw__dispatch_task({ brief, scope, expected })` is for *long-running or specialized* sub-tasks that would otherwise eat your turn budget or pollute your channel context — chewing through a large log file, a multi-step DevOps procedure, a deep web research dive. Returns a `task_id` immediately; the worker's summary arrives as a separate inbound message on a later turn.

Don't use it for:
- Quick lookups — call the appropriate MCP directly.
- Chatting with the user — just answer.
- Anything you can finish in 1-2 turns yourself.

### Scopes (what the worker gets)

- `research` — bash + recall + web search
- `devops` — bash + github + update_memory
- `data` — bash + recall
- `plain` — bash only (default)

### What you should do today

If you genuinely think a request would benefit from dispatch, mention it to Kyle in your reply rather than calling the tool. The tool itself returns a "scaffold-only" acknowledgement, which is **not** a result — don't paraphrase it as if a worker reported back.

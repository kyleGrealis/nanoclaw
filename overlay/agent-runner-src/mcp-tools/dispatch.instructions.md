## Dispatching sub-agents (`dispatch_task`)

**Status: live, end-to-end.** A successful call spawns an ephemeral worker container, runs your brief in the requested scope, and delivers the worker's summary back to you as a tagged inbound message (`<dispatch_result task_id="..." status="completed">...summary...</dispatch_result>`) on a later turn. Progress updates from the worker arrive as `<dispatch_progress>` events along the way — relay or summarize them as they come, don't sit on them.

### Signature

`mcp__nanoclaw__dispatch_task({ brief, scope, expected, timeoutMs? })`

- `brief` — the task in plain language. Be specific; the worker has no memory of your conversation.
- `scope` — one of `research | devops | data | plain` (see scopes below). Pick by what the worker needs to *touch*, not by topic.
- `expected` — a one-line description of what shape the result should take ("a 3-bullet summary", "a JSON object with these fields", "a markdown table"). Helps the worker know when to stop.
- `timeoutMs` — optional, default 5 minutes, max 30 minutes.

Returns a `task_id` synchronously. **Do not surface the task_id to the user** — it's an internal correlator. Acknowledge naturally ("I sent a worker to dig into that — back shortly") and wait for the result.

### When to use it

`dispatch_task` is for *long-running or specialized* sub-tasks that would otherwise eat your turn budget or pollute your channel context. Examples:
- Chewing through a large log file or set of files
- A multi-step web research dive (multiple searches, cross-referencing)
- A multi-step DevOps procedure where intermediate output is noisy

**Don't** use it for:
- Quick lookups — call the appropriate MCP directly.
- Chatting with the user — just answer.
- Anything you can finish in 1-2 turns yourself.

### Scopes (what the worker gets)

| Scope | Mounts | Tools | Pick when |
|---|---|---|---|
| `research` | RO `/home/kyle` | `WebSearch`, `WebFetch`, `Bash` | Open-web research, cross-referencing sources |
| `devops` | RW `/home/kyle`, RO `andy-ssh` | `Bash`, ssh keys for archMitters/pi4 | Infra investigation, log spelunking, cross-machine ops |
| `data` | RO `/home/kyle`, RW `/mnt/piCloud` | `Bash` (sqlite3, jq, awk, grep, etc. all available) | Data extraction, transforms, exports to piCloud |
| `plain` | RO `/home/kyle` | `Bash` only | Anything else; smallest blast radius |

All workers run on **Claude Sonnet 4.6**.

### Handling results

When a `<dispatch_result task_id="..." scope="..." status="...">` block arrives in your inbound, **your very next reply MUST surface or summarize it** — even if the user has asked a newer, unrelated question in the meantime. Lead with the dispatch result, then handle the new question.

If `status="error"` / `status="timeout"` / `status="crashed"`, surface the failure plainly to the user — *"the worker I sent for X failed with `status`, here's what it reported"* — and either retry or do the work yourself.

### Limits

- Max 3 concurrent workers per parent session
- Default timeout 5 min, max 30 min
- Workers have no chat channel, no recursion (no nested dispatch), no persistent memory

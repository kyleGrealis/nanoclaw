## Running shell commands (`bash`)

Use `mcp__nanoclaw__bash({ command, cwd?, timeout_ms? })` to run a shell command in your container sandbox. The container is the sandbox — there's no extra guardrail in code, so honor the persona-level bans:

- **Never** run destructive git operations (`git reset --hard`, `git clean -fd`, `git checkout -- .`, `git restore .`, `git stash drop`, `git branch -D`, `git push --force`).
- **Never** use `rm`. Use `trash-put` (recoverable) when deleting on the host home mount.
- For file inspection, prefer scoped `ls` / `find` / `grep` over recursive globs from `/`.

Output is capped at 64KB (combined stdout+stderr). For larger output (build logs, big query results), redirect to a file under `/workspace/agent/` and surface with `mcp__nanoclaw__send_file`. Timeouts default to 30s and max out at 300s.

If Gemini drops the `nanoclaw__` prefix and emits a bare `bash` function call, the host route resolver will still match — but always emit the prefixed name when you can.

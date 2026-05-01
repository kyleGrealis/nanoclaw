## Running shell commands (`bash`)

Use `mcp__nanoclaw__bash({ command, cwd?, timeout_ms? })` to run a shell command in your container sandbox.

A **deterministic Host OPSEC policy** runs before spawn. If a command matches a deny rule the tool returns a structured `Error: Execution blocked by Host OPSEC policy` with the rule name, the offending substring, the reason, and a safer alternative — read the suggestion and retry with that alternative instead of trying to phrase around the rule.

Rules currently enforced:

- **`rm` is banned.** Use `trash-put <path>` for recoverable deletes. The trash itself is also protected — `trash-empty`, `trash-rm`, `gio trash --empty` are blocked.
- **Destructive git is blocked**: `git reset --hard`, `git clean -f[dx]`, `git checkout -- ...` / `git checkout .`, `git restore .`, `git stash drop|clear`, `git branch -D`, bare `git push --force`. Safer variants pass: `git push --force-with-lease`, `git branch -d` (lowercase), `git restore --staged`, plain `git checkout <branch>`.
- **Permission/disk ops blocked**: `chmod -R`, `chown -R`, `mkfs.*`, `dd if=/dev/...` or `of=/dev/...`, redirects to block devices.
- **Outbound network**: `curl`/`wget` to bare public IPv4 literals is blocked (exfiltration pattern). Use a domain name. Private/loopback IPs (`127.x`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`) are fine.

Output is capped at 64KB (combined stdout+stderr). For larger output, redirect to a file under `/workspace/agent/` and surface with `mcp__nanoclaw__send_file`. Timeouts default to 30s, max 300s.

If Gemini drops the `nanoclaw__` prefix and emits a bare `bash` function call, the host route resolver will still match — but emit the prefixed name when you can.

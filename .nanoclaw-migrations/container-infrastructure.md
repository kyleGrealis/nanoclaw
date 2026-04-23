# Container infrastructure

## 1. SSH support in container

**Intent:** Agent container can SSH to `archMitters` (Tailscale `100.96.87.89`). Needs openssh-client, a resolvable uid (SSH's `getpwuid()`), and credentials mounted from the host.

**v1 commits:** `aba33bf`, `deb2aa7`, `3aede12`, `2fa098d`

**Files:**
- `container/Dockerfile`
- `container/agent-runner/src/index.ts` (no changes for SSH itself; see GCal section)
- `src/container-runner.ts` (mount wiring)
- Host file at `~/.config/nanoclaw/ssh/` — NOT modified by code; provisioned on host

### Dockerfile additions

```dockerfile
# System packages
RUN apt-get update && apt-get install -y \
    openssh-client \
    poppler-utils \
    # (other existing deps: chromium, fonts-liberation, etc.) \
    && rm -rf /var/lib/apt/lists/*

# Allow entrypoint to register arbitrary uids in /etc/passwd at runtime
RUN chmod 666 /etc/passwd
```

### Dockerfile entrypoint (SSH wiring)

```bash
#!/bin/bash
set -e

# Register current uid in /etc/passwd if missing (SSH client getpwuid() requires this)
if ! getent passwd "$(id -u)" > /dev/null 2>&1; then
  echo "kyle:x:$(id -u):$(id -g):Kyle:/home/node:/bin/bash" >> /etc/passwd
fi

# Wire up SSH config from mounted andy-ssh directory (if present)
if [ -d /workspace/extra/andy-ssh ]; then
  mkdir -p ~/.ssh
  cp /workspace/extra/andy-ssh/config ~/.ssh/config 2>/dev/null || true
  cp /workspace/extra/andy-ssh/id_ed25519 ~/.ssh/id_ed25519 2>/dev/null || true
  cp /workspace/extra/andy-ssh/known_hosts ~/.ssh/known_hosts 2>/dev/null || true
  chmod 700 ~/.ssh
  chmod 600 ~/.ssh/id_ed25519 2>/dev/null || true
  chmod 600 ~/.ssh/config 2>/dev/null || true
  chmod 644 ~/.ssh/known_hosts 2>/dev/null || true
fi

# ... then exec the agent-runner (v2 entry point) ...
```

**Critical points:**
- Home dir in `/etc/passwd` entry must be `/home/node` (not `/tmp`), so SSH resolves `~` correctly.
- `chmod 666 /etc/passwd` is a build-time change — required because Docker uid remapping can spawn the container under an arbitrary uid that wasn't baked in at build.
- `2fa098d` dropped an earlier `sed` rewrite of IdentityFile. The source `config` file on the host has the absolute path `/home/node/.ssh/id_ed25519` baked in — no rewrite needed.

### Host-side provisioning (not code; document for admin)

```
~/.config/nanoclaw/ssh/
├── config         # SSH client config with absolute IdentityFile /home/node/.ssh/id_ed25519
├── id_ed25519     # 600 perms
├── id_ed25519.pub
└── known_hosts    # 644 perms; pinned archMitters + github.com keys
```

### Mount in container-runner

Add to `src/container-runner.ts`:
```typescript
const sshDir = path.join(homeDir, '.config', 'nanoclaw', 'ssh');
if (fs.existsSync(sshDir)) {
  mounts.push({
    hostPath: sshDir,
    containerPath: '/workspace/extra/andy-ssh',
    readonly: true,
  });
}
```

---

## 2. Host-key pinning

**v1 commit:** `65ad0da` "pin archMitters + github.com host keys in entrypoint"

No code change on v2 beyond the existing entrypoint SSH-wiring above — the `known_hosts` file is provided by the host mount. The pinned entries are maintained on the host, not in the container image.

**Content in host `~/.config/nanoclaw/ssh/known_hosts`:**
- `archMitters` — ed25519 key (hostname and IP variants)
- `github.com` — ed25519 + RSA keys (dual algorithm)

Rationale: `StrictHostKeyChecking=no` is permanently banned (defeats host pinning). Pre-pinned keys give non-interactive SSH verification without reducing security.

---

## 3. Google Calendar MCP (direct-node fix)

**v1 commits:** `a76802c` (initial add), `e93b782` (direct-node fix, 2026-04-22)

**Intent:** Wire `@cocal/google-calendar-mcp` into agent containers using a **pre-installed package** (not `npx -y`). The npx approach re-downloaded on every container start, racing the Agent SDK's MCP init window.

**Files:**
- `container/agent-runner/src/index.ts` — MCP server config block
- `src/container-runner.ts` — mount wiring

### Agent-runner MCP registration

Conditional on the host-mounted OAuth keys existing:
```typescript
...(fs.existsSync('/workspace/extra/google-calendar-mcp/gcp-oauth.keys.json')
  ? {
      google_calendar: {
        // Use pre-installed package from persistent mount instead of npx -y
        // (npx downloads fresh from npm each container start = slow/unreliable)
        command: 'node',
        args: [
          '/workspace/extra/google-calendar-mcp/node_modules/@cocal/google-calendar-mcp/build/index.js',
        ],
        env: {
          GOOGLE_OAUTH_CREDENTIALS:
            '/workspace/extra/google-calendar-mcp/gcp-oauth.keys.json',
          GOOGLE_CALENDAR_MCP_TOKEN_PATH:
            '/workspace/extra/google-calendar-mcp/tokens.json',
        },
      },
    }
  : {}),
```

### Mount in container-runner

```typescript
const gcalDir = path.join(homeDir, '.config', 'google-calendar-mcp');
if (fs.existsSync(gcalDir)) {
  mounts.push({
    hostPath: gcalDir,
    containerPath: '/workspace/extra/google-calendar-mcp',
    readonly: false,  // tokens.json needs refresh writes
  });
}
```

### Host-side (already provisioned; do NOT regenerate)

```
~/.config/google-calendar-mcp/
├── gcp-oauth.keys.json        # OAuth credentials (andynanobot@gmail.com, published app)
├── tokens.json                # Refresh tokens (do not delete)
├── package.json               # Pins @cocal/google-calendar-mcp@^2.6.1
└── node_modules/@cocal/google-calendar-mcp/build/
    └── index.js               # The entry point (248KB)
```

To reinstall (if node_modules is missing): `cd ~/.config/google-calendar-mcp && npm install`

**IMPORTANT:** The GCP app is *Published* (not Testing), so refresh tokens don't expire on the 7-day cap. If re-auth is ever needed, run the OAuth flow from `@cocal/google-calendar-mcp`'s docs; `tokens.json` auto-updates.

---

## 4. Brave Search container skill

**v1 commits:** `06c899d` (add), `33edc58` (fix stdin conflict)

**Intent:** Web search via Brave Search API (web + news endpoints). Avoids DuckDuckGo CAPTCHAs. Header `X-Subscription-Token` is injected by the OneCLI credential proxy based on host pattern `api.search.brave.com`.

**Files:**
- `container/skills/brave-search/SKILL.md`
- `container/skills/brave-search/brave-search` (bash CLI)
- `container/Dockerfile` (install step)

### Dockerfile install step

```dockerfile
COPY skills/brave-search/brave-search /usr/local/bin/brave-search
RUN chmod +x /usr/local/bin/brave-search
```

### CLI invocations

```bash
brave-search "query"                    # Web search (default)
brave-search --count 5 --country US "q" # Paginated
brave-search --news "query"             # News endpoint
brave-search --json "query"             # Raw JSON output
```

### Stdin conflict fix (33edc58)

The script pipes JSON to Python for pretty-printing. The original version used `echo "$RESPONSE" | python3 -` with a heredoc — stdin conflict. Fixed by passing JSON via env var:

```bash
RESPONSE=$(curl -sS -H "Accept: application/json" "$URL")

# WRONG (stdin conflict): echo "$RESPONSE" | python3 <<'PY'
# RIGHT:
BRAVE_RESPONSE="$RESPONSE" python3 <<'PY'
import json, os
data = json.loads(os.environ["BRAVE_RESPONSE"])
# ... pretty-print ...
PY
```

**Note:** The local branch `skill/brave-search` also contains this CLI. During Phase 2, merging the branch *re-adds* the files; the Dockerfile install step is already there from the branch merge too. See [local-skills.md](local-skills.md).

---

## 5. Dockerfile changes summary (vs `eba94b7`)

All additions to `container/Dockerfile`:

```dockerfile
# System packages added
RUN apt-get install -y openssh-client poppler-utils

# Skills installed to /usr/local/bin
COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader
RUN chmod +x /usr/local/bin/pdf-reader
COPY skills/brave-search/brave-search /usr/local/bin/brave-search
RUN chmod +x /usr/local/bin/brave-search

# /etc/passwd writable at runtime
RUN chmod 666 /etc/passwd

# Entrypoint script (see SSH section for full content)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

---

## 6. Agent-runner customizations (summary)

File: `container/agent-runner/src/index.ts`

1. **Google Calendar MCP registration** (see §3 above)
2. **Multimodal image support** — `ContainerInput.imageAttachments`, `ContentBlock[]`, `MessageStream.pushMultimodal()`. See [discord-features.md § Image vision](discord-features.md#f-image-vision-809cafa-0c9c579-7847297) for the agent-runner-side code.

No other customizations to agent-runner beyond these two areas.

---

## v2 notes for execution

- **Workspace path rename**: v1 uses `/workspace/group/` — v2 reportedly moves to `/workspace/agent/`. Verify during Phase 2 by reading `upstream/v2:container/agent-runner/src/index.ts` before committing path constants.
- **OneCLI interaction**: OneCLI injects credentials via HTTP proxy on the host. The `ONECLI_URL=http://172.17.0.1:10254` env var points the container at the host's Docker bridge IP. v2 should inherit the OneCLI integration unchanged (no customization needed on our side beyond keeping `ONECLI_URL` in `.env`).
- **Dockerfile location**: v2's Dockerfile may restructure. Re-apply the additions above relative to whatever base v2 provides.

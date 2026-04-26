#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

# Register current uid in /etc/passwd if missing. SSH's getpwuid() needs a
# passwd entry to resolve $HOME / ~/.ssh. Docker's user-namespace mapping
# can give us an arbitrary uid at runtime, so we register it here.
if ! getent passwd "$(id -u)" > /dev/null 2>&1; then
  echo "node:x:$(id -u):$(id -g):node:/home/node:/bin/bash" >> /etc/passwd
fi

# Wire SSH credentials from the read-only andy-ssh mount, when present.
# Host mount: ~/.config/nanoclaw/ssh/ → /workspace/extra/andy-ssh/
if [ -d /workspace/extra/andy-ssh ]; then
  mkdir -p ~/.ssh
  cp /workspace/extra/andy-ssh/config         ~/.ssh/config         2>/dev/null || true
  cp /workspace/extra/andy-ssh/id_ed25519     ~/.ssh/id_ed25519     2>/dev/null || true
  cp /workspace/extra/andy-ssh/id_ed25519.pub ~/.ssh/id_ed25519.pub 2>/dev/null || true
  cp /workspace/extra/andy-ssh/andy-github    ~/.ssh/andy-github    2>/dev/null || true
  cp /workspace/extra/andy-ssh/known_hosts    ~/.ssh/known_hosts    2>/dev/null || true
  chmod 700 ~/.ssh
  chmod 600 ~/.ssh/id_ed25519 ~/.ssh/andy-github ~/.ssh/config 2>/dev/null || true
  chmod 644 ~/.ssh/known_hosts ~/.ssh/id_ed25519.pub 2>/dev/null || true
fi

# Set git identity so commits don't fail with "Author identity unknown".
git config --global user.email "kyl3gr3alis@gmail.com"
git config --global user.name "Kyle Grealis"

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json

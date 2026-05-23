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

# Add a passwd entry for the current uid if missing. The host runs the container
# as the host user's uid (often not 1000), and the base image only knows the
# baked-in `node` user. Tools that call getpwuid() (ssh, git, etc.) fail without
# an entry. /etc/passwd is chmod 666 in the Dockerfile so this append works.
if ! getent passwd "$(id -u)" >/dev/null 2>&1; then
  echo "agent:x:$(id -u):$(id -g)::/workspace/agent:/bin/bash" >> /etc/passwd
fi
if ! getent group "$(id -g)" >/dev/null 2>&1; then
  echo "agent:x:$(id -g):" >> /etc/group
fi

mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json

#!/usr/bin/env bash
# Quick health snapshot for both bots.
# Shows: systemd state, Discord connection, pending session-state, recent errors.

set -u

declare -A INSTALLS=(
  [Andy]="$HOME/nanoclaw-andy"
  [Milton]="$HOME/nanoclaw-milton"
)

declare -A SLUGS=(
  [Andy]="930d9414"
  [Milton]="952bb239"
)

for name in Andy Milton; do
  install="${INSTALLS[$name]}"
  slug="${SLUGS[$name]}"
  unit="nanoclaw-v2-${slug}.service"

  echo "=== $name ($install) ==="

  state=$(systemctl --user is-active "$unit" 2>&1)
  enabled=$(systemctl --user is-enabled "$unit" 2>&1)
  echo "  service:  $state ($enabled)"

  # Container image present?
  if docker image inspect "nanoclaw-agent-v2-${slug}:latest" >/dev/null 2>&1; then
    img_age=$(docker image inspect --format='{{.Created}}' "nanoclaw-agent-v2-${slug}:latest" 2>/dev/null)
    echo "  image:    nanoclaw-agent-v2-${slug}:latest (built $img_age)"
  else
    echo "  image:    NOT FOUND"
  fi

  # Running container?
  running=$(docker ps --filter "ancestor=nanoclaw-agent-v2-${slug}:latest" --format "{{.Names}}" 2>/dev/null | head -1)
  if [ -n "$running" ]; then
    uptime=$(docker ps --filter "name=$running" --format "{{.Status}}" 2>/dev/null)
    echo "  session:  $running ($uptime)"
  else
    echo "  session:  none active"
  fi

  # Recent errors
  errs=$(tail -50 "$install/logs/nanoclaw.error.log" 2>/dev/null | grep -c '\[3[12]m\(WARN\|ERROR\)' || echo 0)
  echo "  recent errors (last 50 err-log lines): $errs"

  # Stale session_state?
  stale=0
  for db in "$install"/data/v2-sessions/*/sess-*/outbound.db; do
    [ -f "$db" ] || continue
    n=$(sqlite3 "$db" "SELECT COUNT(*) FROM session_state WHERE key LIKE 'continuation:%';" 2>/dev/null)
    stale=$((stale + n))
  done
  echo "  cached SDK continuations: $stale (clear if persona changes are not taking effect)"

  echo
done

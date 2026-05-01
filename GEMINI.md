# NanoClaw Operator: Project Context & Guidelines

This is the **Operator Repo** for managing two NanoClaw bot installations on a Pi5. It serves as a central hub for configuration, custom overlays, and management scripts.

## Project Overview

- **Bots Managed:**
  - **Andy**: Kyle's personal assistant (Discord: `NanoClaw-Andy`).
  - **Milton**: Alexa's paralegal (Discord: `NanoClaw-Milton`).
- **Nature of this Repo:** This is **not** a NanoClaw installation. The actual bots run from `~/nanoclaw-andy/` and `~/nanoclaw-milton/`.
- **Primary Function:** Coordination of work across bot instances, maintaining "golden" copies of custom patches (overlays), and providing helper scripts for health checks and updates.

## Key Directories

- `operator/`: Contains the `bots-status.sh` health check script.
- `overlay/`: Canonical source for all files and patches that must be re-applied to the bot installs after an upstream pull.
  - `agent-runner-src/`: Patches for the containerized agent runner (providers, tools, formatters).
  - `host-src/`: Patches for the host-side bridge logic (e.g., `chat-sdk-bridge.ts`).
  - `skills/`: Custom binary tools (e.g., `pdf-reader`, `brave-search`) that are injected into the agent container.
- `.claude/skills/`: A library of automation scripts for adding new integrations (Discord, Slack, etc.) and managing the bots' environment.

## Operator Playbook

### Health Checks
Use the status script to check the health of both bots:
```bash
./operator/bots-status.sh
```
This shows service state, container status, recent errors, and cached session state.

### Managing Services
The bots run as user-level systemd services.

**Andy:**
```bash
systemctl --user status  nanoclaw-v2-930d9414
systemctl --user restart nanoclaw-v2-930d9414
```

**Milton:**
```bash
systemctl --user status  nanoclaw-v2-952bb239
systemctl --user restart nanoclaw-v2-952bb239
```

### Applying Personas
Persona files live in `groups/<folder>/CLAUDE.local.md` within each bot's installation. After editing a persona, you **must** wipe the SDK session caches so the change takes effect:
```bash
# Example for Andy
cd ~/nanoclaw-andy
for db in data/v2-sessions/*/sess-*/outbound.db; do
  sqlite3 "$db" "DELETE FROM session_state;"
done
```

### Updating from Upstream
When pulling changes from `qwibitai/nanoclaw`:
1. `cd` to the bot directory (e.g., `~/nanoclaw-andy`).
2. `git pull upstream main`.
3. Manually re-apply the overlay items from this repo's `overlay/` directory.
4. Rebuild the container: `./container/build.sh`.
5. Restart the service.

## Overlay Items (Summary)
The following key customizations are maintained in `overlay/`:
1. **Gemini Provider**: Custom provider for Andy to use Gemini 2.x models with MCP tool support.
2. **Discord Bridge Fixes**: Improvements to attachment handling and message ID sanitization in `chat-sdk-bridge.ts`.
3. **Agent Fixes**: Fixes for context compaction noise and routing context preservation.
4. **Custom Tools**: `bash` (for Gemini), `pdf-reader`, and `brave-search`.

## Development Conventions

- **Golden Copies**: Always update the files in `overlay/` first before applying them to the bot installs. This repo is the source of truth for customizations.
- **Environment**: Secrets are primarily managed via **OneCLI Agent Vault** (accessible at `http://172.17.0.1:10254`). Use `.env` files only as fallbacks.
- **No Direct Runs**: Do not attempt to run `pnpm install` or start a NanoClaw instance inside this repository.
- **Service Slugs**: Service names and container tags use unique slugs (`930d9414` for Andy, `952bb239` for Milton). Always use these exact identifiers in commands.

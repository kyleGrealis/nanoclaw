# NanoClaw / geminiOS Operator Manual

Welcome to your simplified, human-friendly administration plane! This setup combines NanoClaw v2's secure, isolated container runtime with the declarative, flat-file simplicity of geminiOS, alongside sub-second low-latency polling.

No more raw SQLite queries or Claude CLI commands are required to edit your configurations. Everything is managed through plain text.

---

## 1. The Declarative Configuration File

Your agent's settings are defined in:
`groups/andy/config.yaml`

Whenever the host process starts (or boots up), it reads this file and automatically syncs it to the SQLite database.

### YAML Schema Example

```yaml
# System Prompt & Model settings
assistantName: Andy
provider: claude
model: claude-3-5-sonnet-latest
maxMessagesPerPrompt: 30

# Declarative directory mounts
mounts:
  - hostPath: /home/kyle/.config/google-calendar-mcp
    containerPath: .config/google-calendar-mcp
    readonly: false
  - hostPath: /home/kyle/Documents/obsidian
    containerPath: obsidian
    readonly: false

# Scheduled Cron Tasks
tasks:
  - id: morning-weather
    cron: "30 6 * * *"
    prompt_file: blueprints/weather.md
  - id: check-pi4
    cron: "*/30 * * * *"
    prompt: "SSH to pi4 and verify systemctl services are running."
```

### Scalar Settings
- **assistantName:** The name Andy presents himself as.
- **provider / model:** The LLM provider and API model.
- **maxMessagesPerPrompt:** The maximum turns per prompt loop.

---

## 2. Directory Mounts

Adding a folder mount to Andy's sandbox container is simple:
1. Open `groups/andy/config.yaml`.
2. Add your host path and container path under the `mounts:` list.
3. Save the file and restart the service.

### Security Allowlist
For safety, all mounts are checked against your home-directory allowlist:
`~/.config/nanoclaw/mount-allowlist.json`

If a folder you mount in `config.yaml` is not listed in your allowlist roots, the host will block the mount and log a warning. Make sure to add any new directories to your allowlist first!

---

## 3. Scheduled Tasks & Markdown Blueprints

You can schedule recurring cron jobs directly in `config.yaml`. 

### Dynamic Prompts via Blueprints
Instead of cramming long prompt instructions inside the YAML file, you can organize your templates in markdown files under:
`groups/andy/blueprints/`

In `config.yaml`, link the task to the markdown file using `prompt_file`:
```yaml
tasks:
  - id: morning-weather
    cron: "30 6 * * *"
    prompt_file: blueprints/weather.md
```

### Sync Rules on Boot:
- **Creating Tasks:** If a task in `config.yaml` does not exist in the database, the host schedules it.
- **Updating Tasks:** If you edit the cron expression in `config.yaml` or change the text inside `blueprints/weather.md`, the host detects the change on boot and updates the task parameters in the SQLite database automatically.
- **Cancelling Tasks:** If you delete a task from the `tasks:` list in `config.yaml`, the host automatically cancels it in the database on boot.

---

## 4. Latency Reduction

To make Andy feel like a near-instant conversational assistant, the database polling loops have been optimized:
- **Container Loop:** Reduced from 1000ms to **150ms** in [poll-loop.ts](file:///home/kyle/nanoclaw-andy/container/agent-runner/src/poll-loop.ts).
- **Host Delivery Loop:** Reduced from 1000ms to **150ms** in [delivery.ts](file:///home/kyle/nanoclaw-andy/src/delivery.ts).

With these changes, the database overhead is down to sub-second speeds. Andy's replies will begin streaming as soon as the model finishes generation.

---

## 5. Operations & Triage

### Starting / Restarting the Service
To apply changes made to `config.yaml` or mounts, restart the service:
```bash
# On your Pi5 (systemd user service)
systemctl --user restart nanoclaw

# When running/testing locally in development
pnpm run dev
```

### Checking Logs
If Andy doesn't respond or a task fails:
```bash
# Check the host-side errors and routing logs
tail -n 50 logs/nanoclaw.error.log
tail -n 50 logs/nanoclaw.log
```

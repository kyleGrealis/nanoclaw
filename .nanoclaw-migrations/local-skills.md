# Local skill branches

Two skill branches live locally in the fork but aren't merged into `main`. Per Kyle's decision, **merge both** into the v2 worktree during Phase 2.

## skill/brave-search

**Tip:** `06c899d` — "feat(container): add brave-search CLI skill for web search"

**Files introduced:**
- `container/skills/brave-search/SKILL.md` (35 lines)
- `container/skills/brave-search/brave-search` (82 lines) — Bash CLI
- `container/Dockerfile` (+4 lines for install step)

**Intent:** Web search via Brave Search API (web + news endpoints). Avoids DuckDuckGo CAPTCHAs. OneCLI credential proxy injects `X-Subscription-Token` based on host pattern.

**Dependencies on v2-specific state:**
- OneCLI credential proxy (already in place).
- Dockerfile install step (already covered in [container-infrastructure.md § Dockerfile changes](container-infrastructure.md#5-dockerfile-changes-summary-vs-eba94b7)).

**How to apply in v2 worktree:**
```bash
cd "$WORKTREE" && git merge skill/brave-search --no-edit
```

After merge, verify:
- `container/skills/brave-search/brave-search` is executable.
- Dockerfile has the `COPY skills/brave-search/brave-search /usr/local/bin/brave-search` step.
- No conflicts on Dockerfile (if v2 restructured the Dockerfile, resolve manually).

---

## skill/discord-pdf-reader

**Tip:** `2649742` — "feat(discord): add PDF reading via pdf-reader container skill"

**Files introduced:**
- `container/skills/pdf-reader/SKILL.md` (94 lines)
- `container/skills/pdf-reader/pdf-reader` (203 lines) — Bash CLI wrapping `pdftotext`/`pdfinfo`
- `src/pdf.ts` (50 lines) — download + %PDF magic-byte validation
- `src/channels/discord.ts` (+29 lines) — attachment-loop branch for PDFs
- `container/Dockerfile` (+6 lines: install poppler-utils + pdf-reader CLI)
- Tests and session-commands updates

**Intent:** Cherry-picked pdf-reader CLI from the upstream WhatsApp fork. Discord PDF attachment handling.

**Dependencies on v2-specific state:**
- **Depends on v2 Discord adapter** — the commit modifies `src/channels/discord.ts` which does NOT exist on v2. The `src/channels/discord.ts` changes from this branch will be **conflict/dropped**; that's OK because the attachment-loop branch is already documented in [discord-features.md § PDF reading](discord-features.md#e-pdf-reading-2649742).

**How to apply in v2 worktree:**

```bash
cd "$WORKTREE"
# Merge will likely conflict on src/channels/discord.ts (file doesn't exist on v2)
git merge skill/discord-pdf-reader --no-edit || true
# Resolve conflict: keep the non-Discord files, drop the v1 Discord patch
git checkout --ours src/channels/discord.ts 2>/dev/null || git rm src/channels/discord.ts 2>/dev/null || true
git add src/pdf.ts container/skills/pdf-reader/ container/Dockerfile
git commit --no-edit
```

Then re-apply the Discord-side patch via the instructions in [discord-features.md § PDF reading](discord-features.md#e-pdf-reading-2649742), targeting v2's Chat-SDK Discord adapter.

**Alternative approach (cleaner):**
Cherry-pick only the non-Discord files from the branch:
```bash
cd "$WORKTREE"
git checkout skill/discord-pdf-reader -- \
  src/pdf.ts \
  container/skills/pdf-reader/ \
  container/Dockerfile
git commit -m "feat: add pdf-reader container skill (from skill/discord-pdf-reader)"
```

Then re-apply the Discord attachment branch separately.

---

## No other user-authored skills

All directories under `.claude/skills/` are upstream-sourced. No locally authored skills to carry over beyond the two branches above.

## Dropped upstream skill branches

Per index.md § "Applied upstream skills":

- **`skill/native-credential-proxy`** (v1 merge `9cec57b`) — dropped; OneCLI is the sole credential path in v2.
- **`skill/ollama-tool`** (v1 merge `6244454`, then reverted via `af746dc`) — stay reverted; closed question.

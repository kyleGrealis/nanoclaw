## Updating memory (`update_memory`)

Use `mcp__nanoclaw__update_memory({ file, action, section?, content? })` to write to your structured memory at `/workspace/agent/memory/<file>.md`. Always prefer this over `bash` redirects so the YAML frontmatter and H2-section structure stay valid (which is what `recall` searches against).

Operations:

- **`append_section`** — add a new H2 section. Errors if the heading already exists; use `update_section` then.
- **`update_section`** — replace the body under an existing H2. Errors if the heading is missing.
- **`remove_section`** — drop an H2 + its body.
- **`touch_verified`** — refresh the `verified-on:` date without changing content. Use after manually verifying that the file is still accurate.

Every successful op auto-bumps `verified-on:` to today, so freshness signals stay honest. Writes are atomic (temp file + rename) — `recall` running concurrently never sees a half-written file.

This tool only writes to **existing** memory files. To add a new memory file, ask Kyle to create the skeleton first.

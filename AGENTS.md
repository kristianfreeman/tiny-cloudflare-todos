# Project Agent Rules

## Obsidian Memory (QMD)

- Use `/Users/kristian/Documents/obsidian/agent` as canonical shared memory when present.
- Infer project slug from current working directory basename.
- Prefer `/Users/kristian/Documents/obsidian/agent/projects/<slug>/` when that folder exists.
- Otherwise fall back to `agent/memory.md`, `agent/todos.md`, and today's daily note in the vault.
- Before substantial work, run `/Users/kristian/Documents/obsidian/agent/scripts/qmd-prefetch.sh`.

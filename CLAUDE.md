# Todoist MCP — project notes

## Write operations

- `WRITE_ENABLED = false` in `src/server.js` by default. Do not enable or test write operations unless explicitly asked.
- Do not test write endpoints via curl or MCP tools speculatively.
- `complete_task`, `add_comment`, and `add_label` intentionally bypass the write lock and are always available.
- `complete_task` must **always** require user approval — never add it to `allowed-tools` in any skill.

## API

- Base URL: `https://api.todoist.com/api/v1`
- The old `rest/v2` base URL is deprecated and returns 410.
- List endpoints return `{ results: [...] }` — always use `data.results`, not `data`.

## Skills

- `todoist-triage` lives in `commands/todoist-triage.md` and is symlinked from `~/.claude/commands/`.

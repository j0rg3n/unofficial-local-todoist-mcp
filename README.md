# Todoist MCP

A local MCP server that connects Claude Desktop to your Todoist account via OAuth.

## Requirements

- Node.js 18+
- A Todoist account (free tier works)

## Setup

```bash
npm install
npm run setup
```

The setup script walks you through:
1. Creating a Todoist developer app (takes ~60 seconds)
2. Authorizing via OAuth in your browser
3. Printing the exact config snippet to paste into Claude Desktop

## Claude Desktop config

After running setup, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "todoist": {
      "command": "node",
      "args": ["/absolute/path/to/todoist-mcp/src/server.js"]
    }
  }
}
```

Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop after saving.

## Available tools

| Tool | Description |
|------|-------------|
| `get_tasks` | List tasks, filter by project or Todoist filter string |
| `create_task` | Create a task with natural language due dates |
| `complete_task` | Mark a task as done |
| `update_task` | Edit content, due date, or priority |
| `delete_task` | Delete a task permanently |
| `get_projects` | List all projects |
| `create_project` | Create a new project |
| `get_labels` | List all labels |

## Re-authorizing

```bash
npm run setup
```

The setup script will prompt before overwriting an existing token.

## Security

- The access token is stored in `.auth.json` with `600` permissions (owner read/write only).
- Never commit `.auth.json` — it is in `.gitignore`.

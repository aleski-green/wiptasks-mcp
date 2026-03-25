# WipTasks MCP Server

Remote MCP (Model Context Protocol) server for managing WipTasks — a task management system backed by Supabase.

## What is this?

This MCP server gives AI agents (Claude, etc.) direct access to your WipTasks database. Agents can create, read, update, complete, and archive tasks without needing to interact with any UI.

## Live Endpoint

- **MCP URL:** `https://empathetic-analysis-production-dd14.up.railway.app/mcp`
- **Health:** `https://empathetic-analysis-production-dd14.up.railway.app/health`
- **Protocol:** Streamable HTTP (MCP standard)

## Available Tools

| Tool | Description |
|------|-------------|
| `get_active_tasks` | Get all tasks with status `active` or `new`, sorted by priority |
| `get_last_task` | Get the most recently updated task |
| `get_task_by_id` | Get a specific task by UUID |
| `get_all_tasks` | Get all tasks, optionally filtered by status |
| `create_task` | Create a new task |
| `update_task` | Update any fields on a task |
| `complete_task` | Mark a task as completed |
| `archive_task` | Archive a task |

## Task Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | uuid | Auto-generated unique ID |
| `task_name` | string | Name of the task (required) |
| `description` | text | Detailed description |
| `priority` | int (0-100) | Priority level, default 50 |
| `current_status` | enum | `new`, `active`, `completed`, `archived`, `canceled`, `deleted`, `expired` |
| `type` | enum | `homo` (human) or `robo` (automated) |
| `agent` | string | Assigned agent (required) |
| `helpers` | string[] | Helper agents |
| `hashtag` | string[] | Tags/hashtags |
| `expiry_date` | date | When the task expires (YYYY-MM-DD) |
| `reminder` | enum | `hourly`, `weekly`, `monthly`, `custom` |
| `events` | jsonb | Event log array |
| `created_at` | timestamp | Auto-set on creation |
| `updated_at` | timestamp | Auto-updated on changes |

## Connect to Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "wiptasks": {
      "type": "url",
      "url": "https://empathetic-analysis-production-dd14.up.railway.app/mcp"
    }
  }
}
```

Then restart Claude Code. The wiptasks tools will be available automatically.

## Connect to Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "wiptasks": {
      "type": "url",
      "url": "https://empathetic-analysis-production-dd14.up.railway.app/mcp"
    }
  }
}
```

## Self-Hosting

1. Clone the repo
2. Set environment variables:
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_KEY` — your Supabase anon or service_role key
   - `PORT` — server port (default: 3000)
3. `npm install && npm start`

Deploy anywhere that runs Node.js (Railway, Fly.io, Render, etc.).

## Architecture

```
Agent (Claude) --> MCP Server (Railway) --> Edge Function (Supabase) --> PostgreSQL
```

The MCP server translates tool calls into HTTP requests to a Supabase Edge Function, which handles all database operations using the service role.

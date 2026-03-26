# WipTasks MCP Server

Remote MCP (Model Context Protocol) server for managing tasks — backed by Supabase, deployed on Railway, connected to Claude.

## Architecture

```
Claude (Web / Desktop / Code)
  |
  | MCP protocol (HTTP + bearer auth)
  v
MCP Server (Railway / Node.js)
  |
  | HTTP + service_role key
  v
Edge Function (Supabase)
  |
  v
PostgreSQL (Supabase)
```

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

## Setup Guide

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Supabase](https://supabase.com/) account (free tier works)
- [Railway](https://railway.app/) account (free tier works)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (for deploying the edge function)

### Step 1: Create a Supabase project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Click **New Project**
3. Pick a name, set a database password, choose a region
4. Wait for the project to initialize

### Step 2: Run the SQL migration

1. In your Supabase dashboard, go to **SQL Editor**
2. Paste the contents of [`supabase/migrations/001_create_wiptasks.sql`](supabase/migrations/001_create_wiptasks.sql)
3. Click **Run**

This creates the `wiptasks` table with all columns, constraints, and RLS policies.

### Step 3: Deploy the edge function

```bash
# Login to Supabase CLI
supabase login

# Link to your project (find your project ref in the Supabase dashboard URL)
supabase link --project-ref <your-project-ref>

# Deploy the edge function
supabase functions deploy wiptasks-api --no-verify-jwt
```

The `--no-verify-jwt` flag is needed because the MCP server authenticates with the service role key directly.

### Step 4: Deploy the MCP server to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create a new project
railway init

# Deploy
railway up
```

Or deploy via Docker — the repo includes a `Dockerfile`.

### Step 5: Set environment variables

In your Railway dashboard, go to your service > **Variables** and add:

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | Your Supabase project URL (e.g. `https://abcdef.supabase.co`) |
| `SUPABASE_KEY` | Your Supabase **service_role** key (found in Settings > API) |
| `MCP_SECRET` | A random secret for bearer auth (see Step 6) |
| `SERVER_URL` | Your Railway public URL (e.g. `https://your-app.up.railway.app`) — required for OAuth |

### Step 6: Generate your MCP_SECRET

```bash
openssl rand -hex 32
```

Copy the output and set it as `MCP_SECRET` in Railway. You'll also use this value when connecting Claude.

### Step 7: Connect to Claude

After deploying, Railway gives you a public URL (e.g. `https://your-app.up.railway.app`). Use that URL + your `MCP_SECRET` to connect.

#### Claude Web App (OAuth)

1. Go to **Settings** > **Connectors**
2. Click **Add Connector**
3. Fill in:
   - **Name:** `WipTasksMCP`
   - **URL:** `https://<your-railway-url>/mcp`
4. Click **Add** — Claude will open an authorization page
5. Enter your `MCP_SECRET` and click **Authorize**
6. Done — the connector is now authenticated via OAuth

#### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "wiptasks": {
      "type": "url",
      "url": "https://<your-railway-url>/mcp",
      "headers": {
        "Authorization": "Bearer <your-MCP_SECRET>"
      }
    }
  }
}
```

Then restart Claude Code.

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wiptasks": {
      "type": "url",
      "url": "https://<your-railway-url>/mcp",
      "headers": {
        "Authorization": "Bearer <your-MCP_SECRET>"
      }
    }
  }
}
```

## Authentication

The server supports two authentication methods:

1. **OAuth 2.1** (Claude Web App) — Authorization Code + PKCE flow. The server acts as its own OAuth provider. When connecting via the web app, you'll be redirected to a login page where you enter your `MCP_SECRET`.

2. **Bearer token** (Claude Code / Desktop) — Simple `Authorization: Bearer <MCP_SECRET>` header. Configure in `.mcp.json` or `claude_desktop_config.json`.

Both methods protect all `/mcp` routes. The `/health` endpoint is open. OAuth endpoints (`/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`) are also open by design.

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

## Local Development

```bash
# Clone the repo
git clone https://github.com/<your-username>/wiptasks-mcp.git
cd wiptasks-mcp

# Install dependencies
npm install

# Copy env template and fill in your values
cp .env.example .env

# Start the server
node index.js
```

The server runs on `http://localhost:3000`. Test it:

```bash
# Health check
curl http://localhost:3000/health

# Authenticated MCP request
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <your-MCP_SECRET>" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

## License

MIT

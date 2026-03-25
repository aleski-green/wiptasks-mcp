#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_KEY env vars are required");
  process.exit(1);
}

const BASE = `${SUPABASE_URL}/functions/v1/wiptasks-api`;

async function api(method, path, body) {
  const url = `${BASE}/${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function createServer() {
  const server = new McpServer({
    name: "wiptasks",
    version: "1.0.0",
  });

  // --- GET tools ---
  server.tool(
    "get_active_tasks",
    "Get all active/new wiptasks, sorted by priority",
    {},
    async () => {
      const data = await api("GET", "active");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_last_task",
    "Get the most recently updated wiptask",
    {},
    async () => {
      const data = await api("GET", "last");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_task_by_id",
    "Get a specific wiptask by its UUID",
    { id: z.string().uuid().describe("Task UUID") },
    async ({ id }) => {
      const data = await api("GET", `by-id?id=${id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_all_tasks",
    "Get all wiptasks, optionally filtered by status (active, new, completed, archived, canceled, deleted, expired)",
    { status: z.string().optional().describe("Filter by status") },
    async ({ status }) => {
      const path = status ? `all?status=${status}` : "all";
      const data = await api("GET", path);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- POST tools ---
  server.tool(
    "update_task",
    "Update fields on a wiptask (task_name, priority, description, hashtag, expiry_date, reminder, agent, helpers, type, current_status)",
    {
      id: z.string().uuid().describe("Task UUID"),
      task_name: z.string().optional().describe("New task name"),
      priority: z.number().min(0).max(100).optional().describe("Priority 0-100"),
      description: z.string().optional().describe("Task description"),
      hashtag: z.array(z.string()).optional().describe("Hashtags array"),
      expiry_date: z.string().optional().describe("Expiry date (YYYY-MM-DD)"),
      reminder: z.enum(["hourly", "weekly", "monthly", "custom"]).optional(),
      agent: z.string().optional().describe("Assigned agent"),
      helpers: z.array(z.string()).optional().describe("Helper agents"),
      type: z.enum(["homo", "robo"]).optional(),
      current_status: z.enum(["active", "new", "canceled", "archived", "deleted", "completed", "expired"]).optional(),
    },
    async (params) => {
      const data = await api("POST", "update", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "complete_task",
    "Mark a wiptask as completed",
    { id: z.string().uuid().describe("Task UUID to complete") },
    async ({ id }) => {
      const data = await api("POST", "complete", { id });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "archive_task",
    "Archive a wiptask",
    { id: z.string().uuid().describe("Task UUID to archive") },
    async ({ id }) => {
      const data = await api("POST", "archive", { id });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_task",
    "Create a new wiptask",
    {
      task_name: z.string().describe("Task name"),
      priority: z.number().min(0).max(100).optional().default(50),
      description: z.string().optional(),
      hashtag: z.array(z.string()).optional(),
      expiry_date: z.string().optional().describe("YYYY-MM-DD"),
      reminder: z.enum(["hourly", "weekly", "monthly", "custom"]).optional(),
      agent: z.string().describe("Assigned agent"),
      helpers: z.array(z.string()).optional(),
      type: z.enum(["homo", "robo"]).describe("Task type"),
    },
    async (params) => {
      const data = await api("POST", "create", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// --- Express app with Streamable HTTP transport ---
const app = express();
app.use(express.json());

// Store transports by session ID
const transports = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && transports.has(sessionId)) {
    // Existing session
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
    }
  };

  const server = createServer();
  await server.connect(transport);

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    transports.set(transport.sessionId, transport);
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  const transport = transports.get(sessionId);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId);
    await transport.close();
    transports.delete(sessionId);
  }
  res.status(200).end();
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", sessions: transports.size });
});

app.listen(PORT, () => {
  console.log(`wiptasks MCP server running on port ${PORT}`);
});

#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MCP_SECRET = process.env.MCP_SECRET;
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_KEY env vars are required");
  process.exit(1);
}

if (!MCP_SECRET) {
  console.error("MCP_SECRET env var is required");
  process.exit(1);
}

// --- Supabase API helper ---
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

// --- OAuth Provider (in-memory) ---

class WipTasksClientsStore {
  constructor() {
    this.clients = new Map();
  }
  async getClient(clientId) {
    return this.clients.get(clientId);
  }
  async registerClient(clientMetadata) {
    this.clients.set(clientMetadata.client_id, clientMetadata);
    return clientMetadata;
  }
}

class WipTasksAuthProvider {
  constructor(secret) {
    this.secret = secret;
    this.clientsStore = new WipTasksClientsStore();
    this.codes = new Map();    // pendingId/authCode -> { clientId, redirectUri, state, codeChallenge, scopes, resource }
    this.tokens = new Map();   // accessToken/refreshToken -> { clientId, scopes, expiresAt, type?, resource? }
  }

  async authorize(client, params, res) {
    const pendingId = randomUUID();
    this.codes.set(pendingId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes || [],
      resource: params.resource,
    });
    // Expire pending auth after 10 minutes
    setTimeout(() => this.codes.delete(pendingId), 10 * 60 * 1000);
    res.redirect(`/authorize-form?pending=${pendingId}`);
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const data = this.codes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    return data.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode) {
    const data = this.codes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    if (data.clientId !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresIn = 3600;

    this.tokens.set(accessToken, {
      clientId: client.client_id,
      scopes: data.scopes,
      expiresAt: Date.now() + expiresIn * 1000,
      resource: data.resource,
    });
    this.tokens.set(refreshToken, {
      clientId: client.client_id,
      scopes: data.scopes,
      type: "refresh",
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: data.scopes.join(" "),
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const data = this.tokens.get(refreshToken);
    if (!data || data.type !== "refresh" || data.clientId !== client.client_id) {
      throw new Error("Invalid refresh token");
    }
    const accessToken = randomUUID();
    const expiresIn = 3600;
    this.tokens.set(accessToken, {
      clientId: client.client_id,
      scopes: scopes || data.scopes,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: (scopes || data.scopes).join(" "),
    };
  }

  async verifyAccessToken(token) {
    const data = this.tokens.get(token);
    if (!data || data.type === "refresh") throw new Error("Invalid token");
    if (data.expiresAt < Date.now()) {
      this.tokens.delete(token);
      throw new Error("Token expired");
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
    };
  }

  async revokeToken(client, request) {
    this.tokens.delete(request.token);
  }
}

// --- MCP Server (tools) ---

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

// --- Express app ---
const app = express();
app.use(express.json());

// --- OAuth setup ---
const authProvider = new WipTasksAuthProvider(MCP_SECRET);

// Mount OAuth endpoints (metadata, register, authorize, token, revoke)
app.use(mcpAuthRouter({
  provider: authProvider,
  issuerUrl: new URL(SERVER_URL),
  baseUrl: new URL(SERVER_URL),
  scopesSupported: [],
}));

// --- Authorization form (login page) ---
app.get("/authorize-form", (req, res) => {
  const pendingId = req.query.pending;
  if (!pendingId || !authProvider.codes.has(pendingId)) {
    return res.status(400).send("Invalid or expired authorization request");
  }
  const errorMsg = req.query.error ? `<p class="error">Invalid secret. Try again.</p>` : "";
  res.type("html").send(`<!DOCTYPE html>
<html><head><title>WipTasks - Authorize</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:400px;margin:80px auto;padding:0 20px;color:#e0e0e0;background:#1a1a1a}
  h2{margin-bottom:4px}
  p{color:#999;font-size:14px}
  input,button{display:block;width:100%;padding:12px;margin:8px 0;box-sizing:border-box;border-radius:6px;font-size:14px}
  input{background:#2a2a2a;border:1px solid #444;color:#e0e0e0}
  input:focus{outline:none;border-color:#666}
  button{background:#f5f5f5;color:#1a1a1a;border:none;cursor:pointer;font-weight:600}
  button:hover{background:#e0e0e0}
  .error{color:#ff6b6b}
</style></head>
<body>
  <h2>WipTasks</h2>
  <p>Enter your MCP secret to authorize this connection.</p>
  ${errorMsg}
  <form method="POST" action="/authorize-form">
    <input type="hidden" name="pending" value="${pendingId}">
    <input type="password" name="secret" placeholder="MCP_SECRET" required autofocus>
    <button type="submit">Authorize</button>
  </form>
</body></html>`);
});

app.post("/authorize-form", express.urlencoded({ extended: false }), (req, res) => {
  const { pending, secret } = req.body;
  const pendingData = authProvider.codes.get(pending);

  if (!pendingData || !pending) {
    return res.status(400).send("Invalid or expired authorization request");
  }

  if (secret !== MCP_SECRET) {
    return res.redirect(`/authorize-form?pending=${pending}&error=1`);
  }

  // Secret valid — generate auth code and redirect back to client
  const code = randomUUID();
  authProvider.codes.delete(pending);
  authProvider.codes.set(code, pendingData);
  // Expire auth code after 5 minutes
  setTimeout(() => authProvider.codes.delete(code), 5 * 60 * 1000);

  const redirectUrl = new URL(pendingData.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (pendingData.state) {
    redirectUrl.searchParams.set("state", pendingData.state);
  }
  res.redirect(redirectUrl.toString());
});

// --- Dual auth middleware for /mcp (legacy bearer + OAuth) ---
const oauthBearerAuth = requireBearerAuth({ verifier: authProvider });

app.use("/mcp", (req, res, next) => {
  const authHeader = req.headers["authorization"];

  // Strategy 1: Legacy simple bearer token (Claude Code / Desktop)
  if (authHeader === `Bearer ${MCP_SECRET}`) {
    return next();
  }

  // Strategy 2: OAuth access token (Claude Web App)
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return oauthBearerAuth(req, res, next);
  }

  // No auth
  res.status(401).json({ error: "Unauthorized" });
});

// --- MCP transport routes ---
const transports = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

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
  console.log(`OAuth issuer: ${SERVER_URL}`);
});

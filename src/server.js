#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", ".auth.json");

function loadToken() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).access_token;
  } catch {
    return null;
  }
}

function api(token) {
  return axios.create({
    baseURL: "https://api.todoist.com/api/v1",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Set to true to allow create/update/delete operations.
const WRITE_ENABLED = false;

function writeGuard(toolName) {
  if (!WRITE_ENABLED) {
    return {
      content: [
        {
          type: "text",
          text: `Write operations are disabled. To enable them, set WRITE_ENABLED = true in src/server.js.`,
        },
      ],
    };
  }
  return null;
}

let currentToken = loadToken();
if (!currentToken) {
  process.stderr.write(
    "No Todoist token found. Run: node src/setup.js\n"
  );
  process.exit(1);
}

function buildClient(t) {
  const instance = api(t);
  instance.interceptors.response.use(null, async (error) => {
    if (error.response?.status === 401 && !error.config._retry) {
      const freshToken = loadToken();
      if (freshToken && freshToken !== currentToken) {
        error.config._retry = true;
        currentToken = freshToken;
        client = buildClient(freshToken);
        error.config.headers["Authorization"] = `Bearer ${freshToken}`;
        return axios.request(error.config);
      }
    }
    return Promise.reject(error);
  });
  return instance;
}

let client = buildClient(currentToken);

const server = new McpServer({
  name: "todoist",
  version: "1.0.0",
});

async function withRetry(fn, { retries = 3, delayMs = 500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries - 1 || e.response?.status !== 503) throw e;
      await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt));
    }
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

server.tool(
  "get_task",
  "Get full details for a single task including description, labels, due date, and priority",
  {
    task_id: z.string().describe("Task ID to retrieve"),
  },
  async ({ task_id }) => {
    const { data: t } = await client.get(`/tasks/${task_id}`);
    const lines = [
      `**${t.content}** (ID: ${t.id})`,
      `Project: ${t.project_id}${t.section_id ? ` / Section: ${t.section_id}` : ""}`,
      `Priority: p${5 - t.priority}`,
      t.due ? `Due: ${t.due.date}${t.due.string ? ` (${t.due.string})` : ""}` : "Due: none",
      t.labels?.length ? `Labels: ${t.labels.join(", ")}` : "Labels: none",
      `Description: ${t.description || "(none)"}`,
      `Comments: ${t.note_count}`,
      `Added: ${t.added_at}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_comments",
  "Get comments for a task",
  {
    task_id: z.string().describe("Task ID to fetch comments for"),
  },
  async ({ task_id }) => {
    const { data } = await client.get("/comments", { params: { task_id } });
    if (!data.results.length) return { content: [{ type: "text", text: "No comments." }] };
    const lines = data.results.map((c) => `[${c.posted_at.slice(0, 10)}] ${c.content}`);
    return { content: [{ type: "text", text: `Comments (${data.results.length}):\n\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "get_tasks",
  "Get tasks from Todoist, optionally filtered by project, section, or label",
  {
    project_id: z.string().optional().describe("Filter by project ID"),
    section_id: z.string().optional().describe("Filter by section ID"),
    filter: z.string().optional().describe("Todoist filter string e.g. 'today', 'overdue', 'p1'"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max tasks to return"),
  },
  async ({ project_id, section_id, filter, limit }) => {
    const params = {};
    if (project_id) params.project_id = project_id;
    if (section_id) params.section_id = section_id;
    if (filter) params.filter = filter;

    const { data } = await client.get("/tasks", { params });
    const tasks = data.results.slice(0, limit);

    const lines = tasks.map((t) => {
      const due = t.due ? ` [due: ${t.due.date}]` : "";
      const priority = t.priority > 1 ? ` [p${5 - t.priority}]` : "";
      return `• [${t.id}] ${t.content}${priority}${due}`;
    });

    return {
      content: [
        {
          type: "text",
          text: tasks.length === 0
            ? "No tasks found."
            : `Found ${tasks.length} task(s):\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

server.tool(
  "create_task",
  "Create a new task in Todoist",
  {
    content: z.string().describe("Task title (supports Markdown inline formatting)"),
    description: z.string().optional().describe("Longer description"),
    project_id: z.string().optional().describe("Project to add to (inbox if omitted)"),
    due_string: z.string().optional().describe("Natural language due date e.g. 'tomorrow', 'next Monday at 9am'"),
    priority: z.enum(["p1", "p2", "p3", "p4"]).default("p4").describe("Priority (p1=urgent, p4=normal)"),
    labels: z.array(z.string()).optional().describe("Label names to apply"),
  },
  async ({ content, description, project_id, due_string, priority, labels }) => {
    const blocked = writeGuard("create_task");
    if (blocked) return blocked;
    const priorityMap = { p1: 4, p2: 3, p3: 2, p4: 1 };
    const body = {
      content,
      priority: priorityMap[priority],
    };
    if (description) body.description = description;
    if (project_id) body.project_id = project_id;
    if (due_string) body.due_string = due_string;
    if (labels?.length) body.labels = labels;

    const { data } = await client.post("/tasks", body);
    return {
      content: [
        {
          type: "text",
          text: `✅ Created task: "${data.content}" (ID: ${data.id})\nURL: ${data.url}`,
        },
      ],
    };
  }
);

server.tool(
  "complete_task",
  "Mark a task as complete",
  {
    task_id: z.string().describe("Task ID to complete"),
  },
  async ({ task_id }) => {
    await withRetry(() => client.post(`/tasks/${task_id}/close`));
    return {
      content: [{ type: "text", text: `✅ Task ${task_id} marked as complete.` }],
    };
  }
);

server.tool(
  "add_comment",
  "Add a comment to a task",
  {
    task_id: z.string().describe("Task ID to comment on"),
    content: z.string().describe("Comment text"),
  },
  async ({ task_id, content }) => {
    const { data } = await client.post("/comments", { task_id, content });
    return {
      content: [{ type: "text", text: `💬 Comment added (ID: ${data.id})` }],
    };
  }
);

server.tool(
  "update_task",
  "Update an existing task's content, due date, or priority",
  {
    task_id: z.string().describe("Task ID to update"),
    content: z.string().optional().describe("New task title"),
    description: z.string().optional().describe("New description"),
    due_string: z.string().optional().describe("New due date as natural language"),
    priority: z.enum(["p1", "p2", "p3", "p4"]).optional().describe("New priority"),
  },
  async ({ task_id, content, description, due_string, priority }) => {
    const blocked = writeGuard("update_task");
    if (blocked) return blocked;
    const priorityMap = { p1: 4, p2: 3, p3: 2, p4: 1 };
    const body = {};
    if (content) body.content = content;
    if (description) body.description = description;
    if (due_string) body.due_string = due_string;
    if (priority) body.priority = priorityMap[priority];

    const { data } = await client.post(`/tasks/${task_id}`, body);
    return {
      content: [{ type: "text", text: `✏️ Updated task: "${data.content}" (ID: ${data.id})` }],
    };
  }
);

server.tool(
  "delete_task",
  "Permanently delete a task",
  {
    task_id: z.string().describe("Task ID to delete"),
  },
  async ({ task_id }) => {
    const blocked = writeGuard("delete_task");
    if (blocked) return blocked;
    await client.delete(`/tasks/${task_id}`);
    return {
      content: [{ type: "text", text: `🗑️ Task ${task_id} deleted.` }],
    };
  }
);

server.tool(
  "get_projects",
  "List all Todoist projects",
  {},
  async () => {
    const { data } = await client.get("/projects");
    const lines = data.results.map((p) => `• [${p.id}] ${p.name}${p.is_inbox_project ? " (Inbox)" : ""}`);
    return {
      content: [
        {
          type: "text",
          text: `Projects (${data.results.length}):\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

server.tool(
  "create_project",
  "Create a new Todoist project",
  {
    name: z.string().describe("Project name"),
    color: z.string().optional().describe("Color name e.g. 'red', 'blue', 'green'"),
    is_favorite: z.boolean().default(false).describe("Mark as favorite"),
  },
  async ({ name, color, is_favorite }) => {
    const blocked = writeGuard("create_project");
    if (blocked) return blocked;
    const body = { name, is_favorite };
    if (color) body.color = color;
    const { data } = await client.post("/projects", body);
    return {
      content: [{ type: "text", text: `📁 Created project: "${data.name}" (ID: ${data.id})` }],
    };
  }
);

server.tool(
  "get_sections",
  "List sections for a project, or all sections if no project is specified",
  {
    project_id: z.string().optional().describe("Filter by project ID"),
  },
  async ({ project_id }) => {
    const params = {};
    if (project_id) params.project_id = project_id;
    const { data } = await client.get("/sections", { params });
    if (!data.results.length) return { content: [{ type: "text", text: "No sections found." }] };
    const lines = data.results.map((s) => `• [${s.id}] ${s.name} (project: ${s.project_id})`);
    return { content: [{ type: "text", text: `Sections (${data.results.length}):\n\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "add_label",
  "Add a label to a task without affecting its other labels",
  {
    task_id: z.string().describe("Task ID to label"),
    label: z.string().describe("Label name to add"),
  },
  async ({ task_id, label }) => {
    const { data: task } = await client.get(`/tasks/${task_id}`);
    const current = task.labels ?? [];
    if (current.includes(label)) {
      return { content: [{ type: "text", text: `ℹ️ Task already has label "${label}".` }] };
    }
    await client.post(`/tasks/${task_id}`, { labels: [...current, label] });
    return { content: [{ type: "text", text: `🏷️ Added label "${label}" to task ${task_id}.` }] };
  }
);

server.tool(
  "get_labels",
  "List all Todoist labels",
  {},
  async () => {
    const { data } = await client.get("/labels");
    if (!data.results.length) return { content: [{ type: "text", text: "No labels found." }] };
    const lines = data.results.map((l) => `• [${l.id}] ${l.name}`);
    return { content: [{ type: "text", text: `Labels:\n\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "reauthorize",
  "Start a new OAuth flow to refresh the Todoist access token. Starts a local callback server, returns the authorization URL to open in your browser, and saves the new token automatically when the flow completes — no restart needed.",
  {},
  async () => {
    const config = fs.existsSync(CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
      : {};

    if (!config.client_id || !config.client_secret) {
      return {
        content: [{ type: "text", text: "No OAuth credentials found. Run `node src/setup.js` first to set up the app." }],
      };
    }

    const REDIRECT_PORT = 45678;
    const state = Math.random().toString(36).slice(2);
    const authUrl =
      `https://todoist.com/oauth/authorize` +
      `?client_id=${encodeURIComponent(config.client_id)}` +
      `&scope=${encodeURIComponent("data:read_write")}` +
      `&state=${state}`;

    // Start callback server in the background — resolves asynchronously after user authorizes.
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }

      const oauthErr = url.searchParams.get("error");
      if (oauthErr || url.searchParams.get("state") !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<p style='font-family:sans-serif;padding:2rem'>❌ Authorization failed. Please try again.</p>");
        srv.close();
        return;
      }

      const code = url.searchParams.get("code");
      const params = new URLSearchParams({ client_id: config.client_id, client_secret: config.client_secret, code });
      try {
        const { data: tokenData } = await axios.post(
          "https://todoist.com/oauth/access_token",
          params.toString(),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );
        if (tokenData.access_token) {
          fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...config, access_token: tokenData.access_token, authorized_at: new Date().toISOString() }, null, 2));
          try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
          currentToken = tokenData.access_token;
          client = buildClient(currentToken);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<p style='font-family:sans-serif;padding:2rem'>✅ Authorized! Token saved. You can close this tab.</p>");
        } else {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<p style='font-family:sans-serif;padding:2rem'>❌ Token exchange failed. Please try again.</p>");
        }
      } catch {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<p style='font-family:sans-serif;padding:2rem'>❌ Token exchange failed. Please try again.</p>");
      }
      srv.close();
    });
    srv.on("error", () => {});
    srv.listen(REDIRECT_PORT);

    return {
      content: [{ type: "text", text: `Open this URL in your browser to re-authorize:\n\n${authUrl}\n\nThe token will reload automatically once you complete the flow.` }],
    };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

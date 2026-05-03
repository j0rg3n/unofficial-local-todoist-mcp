#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import fs from "fs";
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

const token = loadToken();
if (!token) {
  process.stderr.write(
    "No Todoist token found. Run: node src/setup.js\n"
  );
  process.exit(1);
}

const client = api(token);

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

// ── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

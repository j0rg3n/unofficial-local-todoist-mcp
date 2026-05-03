#!/usr/bin/env node
/**
 * Todoist MCP – OAuth Setup
 * Run once: node src/setup.js
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", ".auth.json");

const REDIRECT_PORT = 45678;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const TODOIST_AUTH_URL = "https://todoist.com/oauth/authorize";
const TODOIST_TOKEN_URL = "https://todoist.com/oauth/access_token";
const SCOPES = "data:read_write";

// ── UI helpers ─────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[37m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

function print(msg = "") {
  process.stdout.write(msg + "\n");
}

function hr(char = "─", width = 60) {
  print(c.dim + char.repeat(width) + c.reset);
}

function banner() {
  print();
  print(c.bold + c.cyan + "  ✓  Todoist MCP – Setup" + c.reset);
  print(c.dim + "  Connect your Todoist account to Claude" + c.reset);
  print();
}

function step(n, total, label) {
  print();
  print(c.bold + `  Step ${n}/${total}: ${label}` + c.reset);
  hr();
}

function info(msg) {
  print("  " + c.dim + msg + c.reset);
}

function success(msg) {
  print("  " + c.green + "✓ " + c.reset + msg);
}

function warn(msg) {
  print("  " + c.yellow + "⚠ " + c.reset + msg);
}

function err(msg) {
  print("  " + c.red + "✗ " + c.reset + msg);
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("  " + c.bold + question + c.reset + " ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Main setup ─────────────────────────────────────────────────────────────

async function run() {
  banner();

  // Check for existing token
  let savedClientId = null;
  if (fs.existsSync(CONFIG_PATH)) {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    savedClientId = existing.client_id || null;
    warn("An existing token was found.");
    const answer = await prompt("Re-authorize? (y/N):");
    if (answer.toLowerCase() !== "y") {
      success("Setup skipped. Existing token retained.");
      process.exit(0);
    }
    print();
  }

  // ── Step 1: Create Todoist App ──────────────────────────────────────────
  step(1, 3, "Create a Todoist App");

  print();
  info("You need a Todoist developer app to get OAuth credentials.");
  info("This takes about 60 seconds.");
  print();
  print("  " + c.cyan + "👉  Open this URL in your browser:" + c.reset);
  print();
  print("      " + c.bold + "https://app.todoist.com/app/settings/integrations/app-management" + c.reset);
  print();
  info('Click "Create a new app" and fill in:');
  print();
  print(`  ${c.dim}App name:${c.reset}    ${c.bold}Todoist MCP${c.reset}  (or anything you like)`);
  print(`  ${c.dim}App service URL:${c.reset}  ${c.bold}http://localhost${c.reset}`);
  print();
  info('After creating, find "OAuth Redirect URLs" and add:');
  print();
  print("      " + c.bold + REDIRECT_URI + c.reset);
  print();
  info('Save the app. Then copy your Client ID and Client Secret.');

  print();
  let clientId;
  if (savedClientId) {
    info(`Using saved Client ID: ${savedClientId}`);
    const override = await prompt("Use a different Client ID? (leave blank to keep):");
    clientId = override || savedClientId;
  } else {
    clientId = await prompt("Paste your Client ID:");
  }
  if (!clientId) {
    err("Client ID cannot be empty.");
    process.exit(1);
  }

  const clientSecret = await prompt("Paste your Client Secret:");
  if (!clientSecret) {
    err("Client Secret cannot be empty.");
    process.exit(1);
  }

  // ── Step 2: Open browser for OAuth ────────────────────────────────────
  step(2, 3, "Authorize with Todoist");

  const state = Math.random().toString(36).slice(2);
  const authUrl =
    `${TODOIST_AUTH_URL}` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${state}`;

  print();
  info("Starting local OAuth callback server on port " + REDIRECT_PORT + "…");

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(callbackPage("❌ Authorization failed", `Error: ${error}`, false));
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(callbackPage("❌ State mismatch", "Possible CSRF – please try again.", false));
        server.close();
        reject(new Error("State mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(callbackPage("✅ Authorized!", "You can close this tab and return to the terminal.", true));
      server.close();
      resolve(returnedCode);
    });

    server.listen(REDIRECT_PORT, () => {
      success("Callback server ready.");
      print();
      print("  " + c.cyan + "👉  Open this URL in your browser to authorize:" + c.reset);
      print();
      print("      " + c.bold + authUrl + c.reset);
      print();
      info("Waiting for you to complete the authorization…");
    });

    server.on("error", (e) => {
      err(`Cannot start server: ${e.message}`);
      reject(e);
    });
  });

  success("Authorization code received.");

  // ── Step 3: Exchange code for token ────────────────────────────────────
  step(3, 3, "Saving credentials");

  print();
  info("Exchanging code for access token…");

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });

  let tokenData;
  try {
    const response = await axios.post(TODOIST_TOKEN_URL, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    tokenData = response.data;
  } catch (e) {
    err("Token exchange failed: " + (e.response?.data?.error || e.message));
    process.exit(1);
  }

  if (!tokenData.access_token) {
    err("No access token in response: " + JSON.stringify(tokenData));
    process.exit(1);
  }

  const config = {
    access_token: tokenData.access_token,
    token_type: tokenData.token_type || "Bearer",
    client_id: clientId,
    authorized_at: new Date().toISOString(),
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  // Secure the file
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}

  print();
  success("Token saved to .auth.json");
  print();
  hr("═");
  print();
  print(c.bold + c.green + "  🎉  Setup complete!" + c.reset);
  print();
  info("Add this to your Claude Desktop config (claude_desktop_config.json):");
  print();

  const serverPath = path.resolve(__dirname, "server.js");
  const configSnippet = {
    mcpServers: {
      todoist: {
        command: "node",
        args: [serverPath],
      },
    },
  };

  print("  " + c.dim + JSON.stringify(configSnippet, null, 4).split("\n").join("\n  ") + c.reset);
  print();
  info("Config file location:");
  print("  " + c.bold + "macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json" + c.reset);
  print("  " + c.bold + "Windows: %APPDATA%\\Claude\\claude_desktop_config.json" + c.reset);
  print();
  info("Then restart Claude Desktop. You're good to go.");
  print();
  hr("═");
  print();
}

// ── Callback page ──────────────────────────────────────────────────────────

function callbackPage(title, message, success) {
  const color = success ? "#22c55e" : "#ef4444";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;600&display=swap');
  body {
    font-family: 'DM Sans', sans-serif;
    background: #0f0f0f;
    color: #e5e5e5;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 12px;
    padding: 48px 56px;
    max-width: 440px;
    width: 90%;
    text-align: center;
  }
  .icon {
    font-size: 48px;
    margin-bottom: 20px;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    color: ${color};
    margin-bottom: 12px;
  }
  p {
    color: #888;
    font-size: 15px;
    line-height: 1.6;
  }
  .brand {
    font-family: 'DM Mono', monospace;
    font-size: 11px;
    color: #444;
    margin-top: 32px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? "✅" : "❌"}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="brand">Todoist MCP</div>
  </div>
</body>
</html>`;
}

// ── Run ────────────────────────────────────────────────────────────────────

run().catch((e) => {
  process.stderr.write("\n  " + e.message + "\n\n");
  process.exit(1);
});

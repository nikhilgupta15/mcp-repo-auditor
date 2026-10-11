/**
 * Test helpers: throwaway git repositories and a real MCP client that talks to
 * the built server (dist/index.js) over stdio, the same way an editor does.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const created = [];

export function tempDir(prefix = "mra-") {
  // Native realpath: macOS temp folders sit behind a symlink and Windows may hand out a
  // short (8.3) name; git reports the resolved, long path.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function cleanup() {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp folder must not fail the run.
    }
  }
}

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** A new repository with `files` committed on `branch`. */
export function makeRepo(files, { branch = "main" } = {}) {
  const root = tempDir("mra-repo-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

/** Starts the server in `cwd`. Setup questions are off unless `env` turns them on. */
export async function connect(cwd, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd,
    env: {
      ...process.env,
      MCP_REPO_AUDITOR_CONFIG_DIR: tempDir("mra-cfg-"),
      MCP_REPO_AUDITOR_SETUP: "off",
      MCP_REPO_AUDITOR_LOG_LEVEL: "error",
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "tests", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/** Calls a tool and returns the parsed JSON it replied with, plus the raw text. */
export async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, json: JSON.parse(text) };
}

export const audit = (client, args) => call(client, "audit_repo_compliance", args);

/** Rule ids mapped to the first changed file whose path matches `pattern`. */
export function rulesFor(payload, pattern) {
  const mapping = payload.file_rule_mappings.find((m) => pattern.test(m.file));
  if (!mapping) return [];
  const byId = new Map(payload.discovered_rules.map((r) => [r.id, r.text]));
  return mapping.rule_ids.map((id) => byId.get(id));
}

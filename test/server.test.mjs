/**
 * End-to-end tests: each one builds a small repository, starts the server and
 * calls its tools through a real MCP client.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { audit, call, cleanup, connect, git, makeRepo, rulesFor, tempDir, write } from "./helpers.mjs";

after(cleanup);

const AGENTS = [
  "# Rules",
  "",
  "- Never use `any`; prefer `unknown` and narrow it.",
  "- Use named exports only, no default exports.",
  "- Do not log secrets or tokens.",
  "",
].join("\n");

function basicRepo(options) {
  return makeRepo({ "AGENTS.md": AGENTS, "src/api/users.ts": "export const a = 1;\n" }, options);
}

test("working scope audits modified and new files, including odd file names", async () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS, "src/my docs/naïve file.ts": "export const a = 1;\n" });
  write(repo, {
    "src/my docs/naïve file.ts": "export const a = 1;\nexport const b: any = 2;\n",
    "src/new file é.ts": "export const c: any = 3;\n",
  });
  const client = await connect(repo);
  try {
    const { json } = await audit(client, { scope: "working" });
    const files = json.changed_files;
    assert.equal(files.length, 2);
    const modified = files.find((f) => /na.+ve file\.ts$/.test(f.path));
    const untracked = files.find((f) => /^src\/new file /.test(f.path));
    assert.equal(modified?.status, "modified");
    assert.equal(modified?.additions, 1);
    assert.equal(untracked?.status, "untracked");
    assert.match(untracked.hunks[0].lines[0], /^\+ 1 \| export const c: any = 3;$/);
    assert.ok(rulesFor(json, /new file/).some((text) => text.startsWith("Never use `any`")));
  } finally {
    await client.close();
  }
});

test("staged scope audits only what is staged", async () => {
  const repo = basicRepo();
  write(repo, { "src/api/users.ts": "export const a: any = 1;\n", "src/other.ts": "export const z = 1;\n" });
  git(repo, "add", "src/api/users.ts");
  const client = await connect(repo);
  try {
    const { json } = await audit(client, {});
    assert.deepEqual(json.changed_files.map((f) => f.path), ["src/api/users.ts"]);
    assert.equal(json.meta.stats.audited_files, 1);
  } finally {
    await client.close();
  }
});

test("branch scope compares against a named base, from a subfolder path", async () => {
  const repo = basicRepo();
  git(repo, "checkout", "-q", "-b", "feature/x");
  write(repo, { "src/api/users.ts": "export const a = 1;\nexport default function f(x: any) { return x; }\n" });
  git(repo, "commit", "-q", "-am", "feature");
  // Started outside any repository; the repository is named by a folder inside it.
  const client = await connect(tempDir());
  try {
    const { json } = await audit(client, { scope: "branch", branch: "main", repoPath: path.join(repo, "src", "api") });
    assert.equal(json.meta.repo_root, repo);
    assert.deepEqual(json.changed_files.map((f) => f.path), ["src/api/users.ts"]);
    assert.equal(json.meta.comparison.startsWith("main...HEAD"), true);
  } finally {
    await client.close();
  }
});

test("first audit asks the setup questions in chat when the client has no form support", async () => {
  const repo = basicRepo();
  const client = await connect(repo, { MCP_REPO_AUDITOR_SETUP: "on" });
  try {
    const first = await audit(client, {});
    assert.equal(first.json.setup_required, true);
    assert.equal(first.json.questions.length, 4);

    const saved = await call(client, "configure_audit", { repoPath: repo, report: "markdown" });
    assert.equal(saved.json.saved, true);

    const second = await audit(client, {});
    assert.equal(second.json.setup_required, undefined);
    assert.equal(second.json.meta.preferences.source, "saved for this repository");
  } finally {
    await client.close();
  }
});

test("HTML report is written from the findings and counts N/A itself", async () => {
  const repo = basicRepo();
  write(repo, { "src/api/users.ts": "export const a: any = 1;\n" });
  const reports = tempDir("mra-reports-");
  const client = await connect(repo, { MCP_REPO_AUDITOR_REPORT_DIR: reports });
  try {
    const { json } = await audit(client, { scope: "working", report: "html" });
    const mapping = json.file_rule_mappings[0];
    const anyRule = json.discovered_rules.find((r) => r.text.startsWith("Never use `any`"));
    const report = await call(client, "render_compliance_report", {
      findings: [
        { file: mapping.file, rule_id: anyRule.id, status: "Fail", line: "1", explanation: "Uses any.", fix: "Use unknown.", fix_code: "export const a: unknown = 1;" },
        { file: "not/in/the/audit.ts", rule_id: anyRule.id, status: "Fail", explanation: "Made up." },
      ],
    });
    assert.equal(report.isError, false);
    assert.equal(report.json.verdict, "NON-COMPLIANT");
    assert.deepEqual(report.json.counts, { pass: 0, fail: 1, skipped: 0, not_applicable: mapping.rule_ids.length - 1 });
    assert.equal(report.json.ignored_findings.length, 1);
    assert.ok(existsSync(report.json.report_path));
    assert.equal(path.dirname(report.json.report_path), reports);
    const html = readFileSync(report.json.report_path, "utf8");
    assert.ok(html.includes("export const a: unknown = 1;"));
  } finally {
    await client.close();
  }
});

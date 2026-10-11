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

test("rules scoped with brace globs are applied to matching files", async () => {
  const repo = makeRepo({
    ".github/instructions/ts.instructions.md": '---\napplyTo: "**/*.{ts,tsx}"\n---\n- Always declare explicit return types on exported functions.\n',
    ".cursor/rules/brace.mdc": "---\ndescription: TS conventions\nglobs: src/**/*.{ts,tsx}\n---\n- Never call console.log in committed code.\n",
    ".cursor/rules/list.mdc": "---\nglobs: src/**/*.ts, src/**/*.tsx\n---\n- Wrap every async route handler in try/catch.\n",
    ".cursor/rules/array.mdc": '---\nglobs: ["lib/**/*.{js,mjs}", "src/**/*.ts"]\n---\n- Prefer early returns over nested conditionals.\n',
    ".cursor/rules/python.mdc": "---\nglobs: **/*.{py,pyi}\n---\n- Always add type hints to public functions.\n",
    "src/api/users.ts": "export const a = 1;\n",
  });
  write(repo, { "src/api/users.ts": "export const a = 1;\nexport const b = 2;\n" });
  const client = await connect(repo);
  try {
    const { json } = await audit(client, { scope: "working" });
    const texts = rulesFor(json, /users\.ts$/);
    assert.deepEqual(texts.sort(), [
      "Always declare explicit return types on exported functions.",
      "Never call console.log in committed code.",
      "Prefer early returns over nested conditionals.",
      "Wrap every async route handler in try/catch.",
    ]);
  } finally {
    await client.close();
  }
});

test("branch scope finds the default branch when it is not main", async () => {
  const repo = basicRepo({ branch: "master" });
  git(repo, "checkout", "-q", "-b", "feature/x");
  write(repo, { "src/api/users.ts": "export const a = 1;\nexport const b: any = 2;\n" });
  git(repo, "commit", "-q", "-am", "feature");
  const client = await connect(repo);
  try {
    const detected = await audit(client, { scope: "branch" });
    assert.equal(detected.isError, false);
    assert.equal(detected.json.meta.comparison.startsWith("master...HEAD"), true);
    assert.equal(detected.json.meta.stats.audited_files, 1);

    const wrong = await audit(client, { scope: "branch", branch: "main" });
    assert.equal(wrong.isError, true);
    assert.match(wrong.json.error, /default branch looks like "master"/);
    assert.match(wrong.json.error, /Branches here: .*feature\/x/);
  } finally {
    await client.close();
  }
});

test("branch scope follows origin/HEAD for an unusual default branch", async () => {
  const origin = basicRepo({ branch: "release-line" });
  const repo = tempDir("mra-clone-");
  git(repo, "clone", "-q", origin, ".");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "checkout", "-q", "-b", "feature/y");
  git(repo, "branch", "-q", "-D", "release-line");
  write(repo, { "src/api/users.ts": "export const a = 1;\nexport const b: any = 2;\n" });
  git(repo, "commit", "-q", "-am", "feature");
  const client = await connect(repo);
  try {
    const { json, isError } = await audit(client, { scope: "branch" });
    assert.equal(isError, false);
    assert.equal(json.meta.comparison.startsWith("origin/release-line...HEAD"), true);
  } finally {
    await client.close();
  }
});

test("staged scope with nothing staged reports the unstaged files and offers a working audit", async () => {
  const repo = basicRepo();
  write(repo, {
    "src/api/users.ts": "export const a: any = 1;\n",
    "src/new/one.ts": "export const one = 1;\n",
    "src/new/two.ts": "export const two = 2;\n",
  });
  const client = await connect(repo);
  try {
    const { json } = await audit(client, {});
    assert.equal(json.changed_files.length, 0);
    assert.equal(json.meta.unstaged_files, 3);
    assert.match(json.system_evaluator_prompt, /3 file\(s\) have unstaged or new changes/);
    assert.match(json.system_evaluator_prompt, /scope "working"/);
  } finally {
    await client.close();
  }
});

test("staged scope in a clean repository just says there is nothing to audit", async () => {
  const repo = basicRepo();
  const client = await connect(repo);
  try {
    const { json } = await audit(client, {});
    assert.equal(json.meta.unstaged_files, undefined);
    assert.match(json.system_evaluator_prompt, /No auditable changes for scope `staged`/);
  } finally {
    await client.close();
  }
});

test("a folder that is not a repository gets an error that says what to do", async () => {
  const client = await connect(tempDir());
  try {
    const { isError, json } = await audit(client, {});
    assert.equal(isError, true);
    assert.match(json.error, /^Not inside a git repository: /);
    assert.match(json.error, /repoPath/);
    assert.match(json.error, /MCP_REPO_AUDITOR_ROOT/);
  } finally {
    await client.close();
  }
});

test("other git failures are passed on instead of being called 'not a repository'", async () => {
  const repo = basicRepo();
  write(repo, { ".git/config": "this is not a valid config file\n" });
  const client = await connect(repo);
  try {
    const { isError, json } = await audit(client, {});
    assert.equal(isError, true);
    assert.match(json.error, /^git could not open the repository at /);
    assert.match(json.error, /bad config/);
  } finally {
    await client.close();
  }
});

test("a large change is cut to fit the result size budget, fairly across files", async () => {
  const repo = basicRepo();
  const big = Array.from({ length: 3000 }, (_, i) => `export const value${i} = computeSomething(${i}, "label-${i}");`).join("\n");
  write(repo, {
    "src/big-one.ts": `${big}\n`,
    "src/big-two.ts": `${big}\n`,
    "src/small.ts": "export const small: any = 1;\n",
  });
  const client = await connect(repo);
  try {
    const { json, text } = await audit(client, { scope: "working" });
    assert.ok(text.length < 70_000, `result is ${text.length} characters`);
    const byPath = new Map(json.changed_files.map((f) => [f.path, f]));
    const lines = (p) => byPath.get(p).hunks.reduce((n, h) => n + h.lines.length, 0);
    assert.equal(byPath.get("src/small.ts").truncated, undefined);
    assert.equal(lines("src/small.ts"), 1);
    assert.equal(byPath.get("src/big-one.ts").truncated, true);
    assert.equal(byPath.get("src/big-two.ts").truncated, true);
    assert.ok(Math.abs(lines("src/big-one.ts") - lines("src/big-two.ts")) <= 1, "large files share the budget equally");
    assert.ok(lines("src/big-one.ts") > 200);
    const warning = json.meta.warnings.find((w) => w.includes("MCP_REPO_AUDITOR_MAX_CHARS"));
    assert.match(warning, /2 file\(s\) were cut short.*src\/big-one\.ts, src\/big-two\.ts/);
    assert.equal(json.file_rule_mappings.length, 3);
  } finally {
    await client.close();
  }
});

test("a file that gets no room at all is left out, with its mapping", async () => {
  const repo = basicRepo();
  const long = `export const text = "${"x".repeat(80_000)}";\n`;
  write(repo, { "src/huge-line.ts": long, "src/small.ts": "export const small: any = 1;\n" });
  const client = await connect(repo);
  try {
    const { json } = await audit(client, { scope: "working" });
    const huge = json.changed_files.find((f) => f.path === "src/huge-line.ts");
    assert.match(huge.skipped_reason, /MCP_REPO_AUDITOR_MAX_CHARS/);
    assert.deepEqual(json.file_rule_mappings.map((m) => m.file), ["src/small.ts"]);
    assert.equal(json.meta.stats.audited_files, 1);
  } finally {
    await client.close();
  }
});

test("gitignored rule files at known locations are used; ignored ones found by search are not", async () => {
  const repo = makeRepo({
    ".gitignore": "CLAUDE.md\n.cursor/\nthird_party/\n",
    "src/api/users.ts": "export const a = 1;\n",
  });
  write(repo, {
    "CLAUDE.md": "- Never use `any` in exported signatures.\n",
    ".cursor/rules/style.mdc": "---\nglobs: src/**/*.ts\n---\n- Use named exports only.\n",
    "third_party/lib/AGENTS.md": "- Always vendor this library unchanged.\n",
    "src/api/users.ts": "export const a = 1;\nexport const b = 2;\n",
  });
  const client = await connect(repo);
  try {
    const { json } = await audit(client, { scope: "working" });
    assert.deepEqual(json.meta.rule_sources.map((s) => s.path).sort(), [".cursor/rules/style.mdc", "CLAUDE.md"]);
    assert.deepEqual(json.meta.skipped_rule_sources, [{ path: "third_party/lib/AGENTS.md", reason: "ignored by .gitignore" }]);
    assert.equal(rulesFor(json, /users\.ts$/).length, 2);
  } finally {
    await client.close();
  }
});

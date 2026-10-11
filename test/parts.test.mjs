/**
 * A change too large for one tool result is audited in parts. These tests
 * check that nothing is dropped, that the user decides before anything runs,
 * and that the report always says what is still open.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { audit, call, cleanup, connect, makeRepo, write } from "./helpers.mjs";

after(cleanup);

const AGENTS = "# Rules\n\n- Never use `any`; prefer `unknown` and narrow it.\n- Use named exports only, no default exports.\n";
const BIG_LINES = 3000;
const bigFile = (name) => `${Array.from({ length: BIG_LINES }, (_, i) => `export const ${name}${i} = computeSomething(${i}, "label-${i}");`).join("\n")}\n`;

/** A repository whose working changes are two 3,000-line new files and one small one. */
function bigRepo() {
  const repo = makeRepo({ "AGENTS.md": AGENTS, "src/keep.ts": "export const keep = 1;\n" });
  write(repo, { "src/big-one.ts": bigFile("one"), "src/big-two.ts": bigFile("two"), "src/small.ts": "export const small: any = 1;\n" });
  return repo;
}

/** New-file line numbers of the added lines of `path` in one part's result. */
function addedLines(payload, path) {
  const file = payload.changed_files.find((f) => f.path === path);
  if (!file) return [];
  return file.hunks.flatMap((h) => h.lines.map((l) => /^\+\s*(\d+) \|/.exec(l)?.[1]).filter(Boolean).map(Number));
}

test("a large change returns a plan first, and nothing is audited until the user decides", async () => {
  const client = await connect(bigRepo());
  try {
    const { json } = await audit(client, { scope: "working" });
    assert.equal(json.plan_required, true);
    assert.equal(json.changed_files, undefined);
    assert.ok(json.plan.total_parts > 1);
    assert.equal(json.plan.files, 3);
    assert.equal(json.plan.added_lines, 2 * BIG_LINES + 1);
    assert.equal(json.plan.parts.length, json.plan.total_parts);
    assert.ok(json.plan.parts.every((p) => p.status === "not started" && p.files.length > 0));
    assert.match(json.plan.parts[0].files[0], /^src\/big-one\.ts \(lines 1-\d+\)$/);
    assert.match(json.summary, /too large for one result: 3 file\(s\), 6,001 added line\(s\)/);
    assert.match(json.instructions, /Do not choose for them/);
  } finally {
    await client.close();
  }
});

test("the parts hold every changed line exactly once, each within the size budget", async () => {
  const client = await connect(bigRepo());
  try {
    const plan = (await audit(client, { scope: "working" })).json.plan;
    const seen = { "src/big-one.ts": [], "src/big-two.ts": [], "src/small.ts": [] };
    for (let part = 1; part <= plan.total_parts; part++) {
      const { json, text } = await audit(client, { scope: "working", part });
      assert.ok(text.length < 70_000, `part ${part} is ${text.length} characters`);
      assert.deepEqual([json.meta.part.number, json.meta.part.total], [part, plan.total_parts]);
      assert.equal(json.meta.part.next, part < plan.total_parts ? part + 1 : null);
      assert.match(json.system_evaluator_prompt, new RegExp(`### Part ${part} of ${plan.total_parts}: `));
      if (part < plan.total_parts) assert.match(json.system_evaluator_prompt, new RegExp(`plus part: ${part + 1}\\.`));
      else assert.match(json.system_evaluator_prompt, /Every part has now been handed out/);
      for (const file of json.changed_files) {
        seen[file.path].push(...addedLines(json, file.path));
        // Every file in a part comes with its rules, so each part can be judged on its own.
        const mapping = json.file_rule_mappings.find((m) => m.file === file.path);
        assert.ok(mapping.rule_ids.every((id) => json.discovered_rules.some((r) => r.id === id)));
        if (file.path !== "src/small.ts") assert.match(file.shown_lines, /^new-file lines \d+-\d+; the rest of this file's change is in parts? [\d, ]+$/);
      }
    }
    const all = Array.from({ length: BIG_LINES }, (_, i) => i + 1);
    assert.deepEqual(seen["src/big-one.ts"], all);
    assert.deepEqual(seen["src/big-two.ts"], all);
    assert.deepEqual(seen["src/small.ts"], [1]);

    const beyond = await audit(client, { scope: "working", part: plan.total_parts + 1 });
    assert.equal(beyond.isError, true);
    assert.match(beyond.json.error, /there is no part/);
  } finally {
    await client.close();
  }
});

test("later parts come from the snapshot the plan was made from", async () => {
  const repo = bigRepo();
  const client = await connect(repo);
  try {
    const plan = (await audit(client, { scope: "working" })).json.plan;
    write(repo, { "src/big-one.ts": "export const changedAfterThePlan = 1;\n" });
    const { json } = await audit(client, { scope: "working", part: 1 });
    assert.equal(json.meta.part.total, plan.total_parts);
    assert.ok(addedLines(json, "src/big-one.ts").length > 100);
  } finally {
    await client.close();
  }
});

test("paths narrows the audit to chosen files, folders or globs", async () => {
  const repo = bigRepo();
  write(repo, { "lib/util.ts": "export const util: any = 1;\n" });
  const client = await connect(repo);
  try {
    const one = await audit(client, { scope: "working", paths: ["src/small.ts"] });
    assert.equal(one.json.plan_required, undefined);
    assert.deepEqual(one.json.changed_files.map((f) => f.path), ["src/small.ts"]);
    assert.deepEqual(one.json.meta.paths, ["src/small.ts"]);
    assert.deepEqual([one.json.meta.part.number, one.json.meta.part.total, one.json.meta.part.next], [1, 1, null]);

    const folderAndGlob = await audit(client, { scope: "working", paths: ["lib/", "src/sm*.ts"] });
    assert.deepEqual(folderAndGlob.json.changed_files.map((f) => f.path), ["lib/util.ts", "src/small.ts"]);

    const none = await audit(client, { scope: "working", paths: ["nowhere"] });
    assert.equal(none.json.changed_files.length, 0);
    assert.match(none.json.meta.warnings.join(" "), /None of the 4 changed file\(s\) match the requested paths: nowhere/);
  } finally {
    await client.close();
  }
});

test("HTML report is refreshed after every part and says what is still open", async () => {
  const client = await connect(bigRepo());
  try {
    const plan = (await audit(client, { scope: "working", report: "html" })).json.plan;
    const total = plan.total_parts;

    const first = (await audit(client, { scope: "working", report: "html", part: 1 })).json;
    assert.match(first.system_evaluator_prompt, new RegExp(`exactly once with part: 1 and:`));
    const rule = first.discovered_rules.find((r) => r.text.startsWith("Never use `any`"));

    const noPart = await call(client, "render_compliance_report", { findings: [] });
    assert.match(noPart.json.error, new RegExp(`This audit has ${total} parts\\. Pass part`));
    const tooEarly = await call(client, "render_compliance_report", { part: 2, findings: [] });
    assert.match(tooEarly.json.error, /Part 2 has not been requested yet/);

    const afterFirst = (await call(client, "render_compliance_report", {
      part: 1,
      findings: [{ file: "src/big-one.ts", rule_id: rule.id, status: "Pass", line: "1", explanation: "No any." }],
    })).json;
    assert.equal(afterFirst.verdict, "INCOMPLETE");
    assert.equal(afterFirst.complete, false);
    assert.deepEqual(afterFirst.parts.judged, [1]);
    assert.equal(afterFirst.parts.pending.length, total - 1);
    assert.match(afterFirst.next_step, /plus part: 2\./);
    const partial = readFileSync(afterFirst.report_path, "utf8");
    assert.ok(partial.includes(`1 of ${total} parts audited`));
    assert.ok(partial.includes("partly audited"));
    assert.ok(partial.includes(">INCOMPLETE<"));

    let last = afterFirst;
    for (let part = 2; part <= total; part++) {
      const payload = (await audit(client, { scope: "working", report: "html", part })).json;
      const findings = payload.changed_files.some((f) => f.path === "src/small.ts")
        ? [{ file: "src/small.ts", rule_id: rule.id, status: "Fail", line: "1", explanation: "Uses any.", fix: "Use unknown.", fix_code: "export const small: unknown = 1;" }]
        : [];
      last = (await call(client, "render_compliance_report", { part, findings })).json;
      assert.equal(last.report_path, afterFirst.report_path);
    }
    assert.equal(last.complete, true);
    assert.equal(last.verdict, "NON-COMPLIANT");
    assert.deepEqual(last.parts.pending, []);
    assert.deepEqual([last.counts.pass, last.counts.fail], [1, 1]);
    assert.match(last.next_step, /report is complete/);
    const done = readFileSync(last.report_path, "utf8");
    assert.ok(!done.includes("parts audited"));
    assert.ok(done.includes("export const small: unknown = 1;"));
    assert.ok(done.includes(`in ${total} parts`));
  } finally {
    await client.close();
  }
});

test("a client with forms shows the plan as a form; the user can run all parts, narrow, or cancel", async () => {
  const repo = bigRepo();
  const forms = [];
  let answer = { action: "accept", content: { proceed: "cancel" } };
  const client = await connect(repo, {}, (form) => {
    forms.push(form);
    return answer;
  });
  try {
    const cancelled = (await audit(client, { scope: "working" })).json;
    assert.equal(cancelled.cancelled, true);
    assert.match(forms[0].message, /too large for one result/);
    assert.match(forms[0].message, /Part 1 \(\+[\d,]+ lines\): src\/big-one\.ts \(lines 1-\d+\)/);
    assert.deepEqual(forms[0].requestedSchema.properties.proceed.enum, ["all", "cancel"]);

    answer = { action: "accept", content: { proceed: "all" } };
    const all = (await audit(client, { scope: "working" })).json;
    assert.equal(all.meta.part.number, 1);
    assert.ok(all.meta.part.total > 1);

    // Narrowed to one big file: still several parts, and the next call (which carries no paths) continues that selection.
    answer = { action: "accept", content: { proceed: "all", paths: "src/big-two.ts" } };
    const narrowed = (await audit(client, { scope: "working" })).json;
    assert.deepEqual(narrowed.changed_files.map((f) => f.path), ["src/big-two.ts"]);
    assert.deepEqual(narrowed.meta.paths, ["src/big-two.ts"]);
    const formsSoFar = forms.length;
    const second = (await audit(client, { scope: "working", part: 2 })).json;
    assert.deepEqual(second.changed_files.map((f) => f.path), ["src/big-two.ts"]);
    assert.equal(second.meta.part.total, narrowed.meta.part.total);
    assert.equal(forms.length, formsSoFar, "requesting a part does not ask again");
  } finally {
    await client.close();
  }
});

test("a single enormous line is shortened and reported, not dropped", async () => {
  const repo = makeRepo({ "AGENTS.md": AGENTS, "src/keep.ts": "export const keep = 1;\n" });
  write(repo, { "src/data.ts": `export const text = "${"x".repeat(80_000)}";\nexport const after: any = 1;\n` });
  const client = await connect(repo);
  try {
    const { json, text } = await audit(client, { scope: "working" });
    assert.equal(json.plan_required, undefined);
    assert.ok(text.length < 20_000);
    assert.deepEqual(addedLines(json, "src/data.ts"), [1, 2]);
    assert.match(json.changed_files[0].hunks[0].lines[0], /⟨line shortened: 80023 characters⟩$/);
    assert.match(json.meta.warnings.join(" "), /1 line\(s\) longer than 2000 characters are shown shortened/);
  } finally {
    await client.close();
  }
});

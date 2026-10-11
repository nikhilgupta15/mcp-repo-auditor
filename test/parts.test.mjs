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
    assert.deepEqual(forms[0].requestedSchema.properties.proceed.enum, ["all", "parallel", "cancel"]);

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

/** Plays one subagent: requests its part with the brief's arguments, then sends its verdicts. */
async function subagent(client, brief, part, findingsFor) {
  const args = JSON.parse(brief.subagent_brief.split("\n")[2].trim());
  const payload = (await audit(client, { ...args, part })).json;
  assert.match(payload.system_evaluator_prompt, new RegExp(`exactly once with part: ${part} and:`));
  assert.match(payload.system_evaluator_prompt, /do not request other parts/);
  const recorded = await call(client, "render_compliance_report", { part, findings: findingsFor(payload) });
  assert.equal(recorded.isError, false);
  return recorded.json;
}

const smallFails = (payload) => {
  const rule = payload.discovered_rules.find((r) => r.text.startsWith("Never use `any`"));
  return payload.changed_files.some((f) => f.path === "src/small.ts")
    ? [{ file: "src/small.ts", rule_id: rule.id, status: "Fail", line: "1", explanation: "Uses any.", fix: "Use unknown.", fix_code: "export const small: unknown = 1;" }]
    : [{ file: payload.changed_files[0].path, rule_id: rule.id, status: "Pass", explanation: "No any in these lines." }];
};

test("parallel Markdown audit: subagents judge the parts at once and the server builds the table", async () => {
  const repo = bigRepo();
  const client = await connect(repo);
  try {
    const before = await call(client, "audit_status", {});
    assert.match(before.json.error, /No audit in this session yet/);

    const brief = (await audit(client, { scope: "working", parallel: true })).json;
    assert.equal(brief.parallel, true);
    assert.ok(brief.total_parts > 1);
    assert.match(brief.instructions, /in ONE message/);
    assert.match(brief.instructions, /Print the tool's `markdown` field exactly as returned/);
    assert.match(brief.subagent_brief, /plus part: <N>/);
    assert.deepEqual(JSON.parse(brief.subagent_brief.split("\n")[2].trim()), { repoPath: repo, scope: "working", report: "markdown" });

    const parts = Array.from({ length: brief.total_parts }, (_, i) => i + 1);
    // All but the last part first, to see the status of an unfinished audit.
    const results = await Promise.all(parts.slice(0, -1).map((part) => subagent(client, brief, part, smallFails)));
    assert.ok(results.every((r) => r.recorded === true && r.report_path === undefined));
    assert.deepEqual(results[0].part_counts, { pass: 1, fail: 0, skipped: 0, not_applicable: 1 });

    const open = (await call(client, "audit_status", {})).json;
    assert.equal(open.complete, false);
    assert.equal(open.verdict, "INCOMPLETE");
    assert.deepEqual(open.parts.pending, [brief.total_parts]);
    assert.match(open.next_step, /Start a subagent for each of them once more/);
    assert.ok(open.markdown.includes(`- Not audited: part ${brief.total_parts} (`));

    await subagent(client, brief, brief.total_parts, smallFails);
    const done = (await call(client, "audit_status", {})).json;
    assert.equal(done.complete, true);
    assert.equal(done.verdict, "NON-COMPLIANT");
    // One verdict per part: the part holding src/small.ts fails, every other part passes.
    assert.deepEqual([done.counts.pass, done.counts.fail, done.counts.skipped], [brief.total_parts - 1, 1, 0]);
    assert.match(done.markdown, /^## Compliance Matrix\n\| File \| Rule Checked \|/);
    assert.match(done.markdown, /\| src\/small\.ts \| R\d+: Never use `any`; prefer `unknown` and narrow it\. \| Fail \| 1 \| Uses any\. Fix: Use unknown\. \|/);
    assert.match(done.markdown, /### `src\/small\.ts:1` — R\d+ Never use `any`/);
    assert.match(done.markdown, /```diff\n- export const small: any = 1;\n\+ export const small: unknown = 1;\n```/);
    assert.match(done.markdown, /— \*\*NON-COMPLIANT\*\*\n`Parts audited: [\d, ]+ of \d+`$/);
  } finally {
    await client.close();
  }
});

test("parallel HTML audit: every subagent's verdicts end up in one complete report", async () => {
  const client = await connect(bigRepo());
  try {
    const brief = (await audit(client, { scope: "working", report: "html", parallel: true })).json;
    assert.match(brief.instructions, /Report: <report_path>/);
    const parts = Array.from({ length: brief.total_parts }, (_, i) => i + 1);
    const results = await Promise.all(parts.map((part) => subagent(client, brief, part, smallFails)));
    assert.equal(new Set(results.map((r) => r.report_path)).size, 1);

    const done = (await call(client, "audit_status", {})).json;
    assert.equal(done.complete, true);
    assert.equal(done.verdict, "NON-COMPLIANT");
    assert.equal(done.report_path, results[0].report_path);
    assert.equal(done.markdown, undefined);
    // The file on disk is the last write, with every part in it.
    const html = readFileSync(done.report_path, "utf8");
    assert.ok(!html.includes("parts audited"));
    assert.ok(html.includes(`in ${brief.total_parts} parts`));
    assert.ok(html.includes(`>${done.counts.pass}</b><span>Pass`));
    assert.ok(html.includes("export const small: unknown = 1;"));
  } finally {
    await client.close();
  }
});

test("parallel is offered in the plan, chosen in the form, and ignored for a change that fits one result", async () => {
  const repo = bigRepo();
  const plain = await connect(repo);
  try {
    const plan = (await audit(plain, { scope: "working" })).json;
    assert.match(plan.instructions, /plus parallel: true/);
    const small = (await audit(plain, { scope: "working", paths: ["src/small.ts"], parallel: true })).json;
    assert.equal(small.parallel, undefined);
    assert.equal(small.meta.part.total, 1);
  } finally {
    await plain.close();
  }

  const withForm = await connect(repo, {}, () => ({ action: "accept", content: { proceed: "parallel", paths: "src/big-two.ts" } }));
  try {
    const brief = (await audit(withForm, { scope: "working" })).json;
    assert.equal(brief.parallel, true);
    assert.deepEqual(JSON.parse(brief.subagent_brief.split("\n")[2].trim()).paths, ["src/big-two.ts"]);
    assert.ok(brief.parts.every((p) => p.files.every((file) => file.startsWith("src/big-two.ts"))));
  } finally {
    await withForm.close();
  }
});

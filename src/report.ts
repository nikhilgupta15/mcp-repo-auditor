/**
 * Renders the host LLM's verdicts into a self-contained HTML report.
 *
 * The LLM only supplies (file, rule, status, line, explanation, fix). Rule
 * text, rule sources, the offending code and the N/A counts all come from the
 * audit this server prepared, so the report cannot drift from it.
 *
 * A large change is audited in parts. The report is rewritten after every
 * part and says which parts are still open, so it is never mistaken for a
 * complete audit while it is not one.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PayloadChangedFile, PayloadRule } from "./types.js";

export type FindingStatus = "Fail" | "Pass" | "Skipped";

export interface FindingInput {
  file: string;
  rule_id: string;
  status: FindingStatus;
  line?: string;
  explanation: string;
  fix?: string;
  /** Replacement code for the cited lines, when the fix is a code change. */
  fix_code?: string;
}

/** The verdicts for one file (or one piece of a file) in one judged part. */
export interface ReportUnit {
  part: number;
  file: string;
  /** Every rule mapped to the file; the ones without a finding count as not applicable. */
  ruleIds: string[];
  findings: FindingInput[];
}

export interface ReportData {
  meta: {
    tool: string;
    version: string;
    repo_root: string;
    comparison: string;
    warnings: string[];
    rule_sources: Array<{ path: string; rules: number }>;
    audited_files: number;
    rules_relevant: number;
    rules_discovered: number;
    file_rule_pairs: number;
  };
  rules: PayloadRule[];
  /** Whole changed files, for the code excerpts. */
  files: PayloadChangedFile[];
  units: ReportUnit[];
  coverage: { total: number; judged: number[]; pending: Array<{ part: number; files: string[] }> };
}

export interface ReportResult {
  report_path: string;
  report_url: string;
  /** INCOMPLETE = no failures so far, but some parts have not been audited. */
  verdict: "COMPLIANT" | "NON-COMPLIANT" | "INCOMPLETE";
  counts: { pass: number; fail: number; skipped: number; not_applicable: number };
}

const STATUS_ORDER: Record<FindingStatus, number> = { Fail: 0, Skipped: 1, Pass: 2 };
const MAX_SNIPPET_LINES = 24;

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "42", "42-45", "19, 23" -> the individual line numbers (capped). */
function parseLineSpec(spec: string | undefined): number[] {
  const out = new Set<number>();
  for (const part of (spec ?? "").split(/[,;]/)) {
    const match = /(\d+)\s*(?:[-–]\s*(\d+))?/.exec(part);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Math.max(start, Number(match[2] ?? match[1]));
    for (let n = start; n <= end && out.size < MAX_SNIPPET_LINES; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

interface SnippetLine {
  sign: string;
  number: number;
  code: string;
  flagged: boolean;
}

/** Pulls the cited lines (plus one line of context either side) out of the audited diff. */
function snippetFor(file: PayloadChangedFile | undefined, spec: string | undefined): SnippetLine[] {
  const flagged = new Set(parseLineSpec(spec));
  if (!file || flagged.size === 0) return [];
  const wanted = new Set<number>();
  for (const n of flagged) for (const m of [n - 1, n, n + 1]) wanted.add(m);

  const out: SnippetLine[] = [];
  for (const hunk of file.hunks) {
    for (const raw of hunk.lines) {
      const match = /^([+\- ])\s+(\d+)?\s*\|\s?(.*)$/.exec(raw);
      if (!match || !match[2]) continue;
      const number = Number(match[2]);
      if (!wanted.has(number)) continue;
      out.push({ sign: match[1] as string, number, code: match[3] ?? "", flagged: flagged.has(number) });
    }
  }
  return out.slice(0, MAX_SNIPPET_LINES + 8);
}

function renderSnippet(lines: SnippetLine[]): string {
  if (!lines.length) return "";
  const rows: string[] = [];
  let previous = 0;
  for (const line of lines) {
    if (previous && line.number > previous + 1) rows.push('<div class="ln gap"><span class="no">⋮</span><span class="src"></span></div>');
    rows.push(
      `<div class="ln${line.flagged ? " hit" : ""}"><span class="no">${line.number}</span>` +
        `<span class="src">${esc(line.code) || " "}</span></div>`,
    );
    previous = line.number;
  }
  return `<div class="code" role="group" aria-label="Cited lines">${rows.join("")}</div>`;
}

/** Unified-diff view of a suggested change: cited lines removed, replacement code added, context kept. */
function renderChange(lines: SnippetLine[], fixCode: string): string {
  const added = fixCode.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "").split("\n");
  const row = (cls: string, no: string | number, sign: string, code: string) =>
    `<div class="ln ${cls}"><span class="no">${no}</span><span class="sg">${sign}</span><span class="src">${esc(code) || " "}</span></div>`;
  const addRows = added.map((code) => row("add", "", "+", code));
  const lastHit = lines.map((l) => l.flagged).lastIndexOf(true);
  const rows: string[] = [];
  lines.forEach((line, index) => {
    rows.push(line.flagged ? row("del", line.number, "-", line.code) : row("", line.number, " ", line.code));
    if (index === lastHit) rows.push(...addRows);
  });
  if (lastHit < 0) rows.push(...addRows);
  return `<div class="label">Suggested change</div><div class="code diff" role="group" aria-label="Suggested change">${rows.join("")}</div>`;
}

function timestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5d6472;--line:#e2e5ea;--code:#f3f4f7;--hit:#fff1d6;
--fail:#c62828;--fail-bg:#fdecec;--pass:#1b7f4b;--pass-bg:#e6f5ec;--skip:#8a6100;--skip-bg:#fdf3d7;--na:#5d6472;--na-bg:#eceef2;--accent:#2f5bd8}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--ink:#e8eaee;--muted:#9aa2b1;--line:#2b303b;--code:#12141a;--hit:#40330f;
--fail:#ff8a80;--fail-bg:#3a1c1c;--pass:#6fd39c;--pass-bg:#163526;--skip:#f2c261;--skip-bg:#3a2f12;--na:#9aa2b1;--na-bg:#252a34;--accent:#8fb0ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.verdict{display:inline-block;margin:18px 0 14px;padding:6px 14px;border-radius:999px;font-weight:700;font-size:13px;letter-spacing:.04em}
.verdict.bad{background:var(--fail-bg);color:var(--fail)}.verdict.good{background:var(--pass-bg);color:var(--pass)}.verdict.open{background:var(--skip-bg);color:var(--skip)}
.cover{margin:0 0 18px;padding:12px 16px;border:1px solid var(--line);border-left:4px solid var(--skip);border-radius:0 12px 12px 0;background:var(--card);font-size:14px}
.cover ul{margin:6px 0 0;padding-left:18px;color:var(--muted)}.cover li{overflow-wrap:anywhere}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
@media (max-width:620px){.tiles{grid-template-columns:repeat(2,1fr)}}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.tile b{display:block;font-size:28px;line-height:1.1;font-variant-numeric:tabular-nums}
.tile span{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.tile.fail b{color:var(--fail)}.tile.pass b{color:var(--pass)}.tile.skipped b{color:var(--skip)}.tile.na b{color:var(--na)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:18px;position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:2}
.chip{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}
.chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
@media (prefers-color-scheme:dark){.chip[aria-pressed="true"]{color:#111318}}
#q{flex:1;min-width:180px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:7px 14px;font:inherit;font-size:13px}
details.file{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:14px;overflow:hidden}
details.file>summary{cursor:pointer;padding:13px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;list-style:none}
details.file>summary::-webkit-details-marker{display:none}
.path{font:600 13.5px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;flex:1;min-width:200px}
.pill{font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;white-space:nowrap}
.pill.fail{background:var(--fail-bg);color:var(--fail)}.pill.pass{background:var(--pass-bg);color:var(--pass)}
.pill.skipped{background:var(--skip-bg);color:var(--skip)}.pill.na{background:var(--na-bg);color:var(--na)}
.finding{border-top:1px solid var(--line);padding:14px 16px}
.head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.rid{font:600 12.5px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
.rule{font-weight:600;flex:1;min-width:220px}
.at{font:12.5px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);white-space:nowrap}
.why{margin:8px 0 0}
.fix{margin:8px 0 0;padding:8px 12px;border-left:3px solid var(--pass);background:var(--pass-bg);border-radius:0 8px 8px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.fix b{color:var(--pass)}
.src-of{margin-top:8px;font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.code{margin-top:10px;background:var(--code);border:1px solid var(--line);border-radius:8px;overflow-x:auto;font:12.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}
.ln{display:flex;min-width:max-content}.ln.hit{background:var(--hit)}
.no{flex:none;width:52px;padding:0 10px;text-align:right;color:var(--muted);user-select:none;border-right:1px solid var(--line)}
.src{padding:0 12px;white-space:pre}
.sg{flex:none;width:22px;text-align:center;color:var(--muted);user-select:none}
.diff .src{padding-left:4px}
.ln.del{background:var(--fail-bg)}.ln.del .sg{color:var(--fail)}
.ln.add{background:var(--pass-bg)}.ln.add .sg{color:var(--pass)}
.label{margin-top:12px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.label+.code{margin-top:6px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:6px}
.tab{border:0;background:none;color:var(--muted);font:inherit;font-weight:600;padding:10px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent)}
#rq{flex:1;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:7px 14px;font:inherit;font-size:13px}
.rules-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 16px}
ul.rules{list-style:none;margin:0;padding:0}
ul.rules li{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
ul.rules li:first-child{border-top:0}
ul.rules .rid{flex:none;width:44px}
ul.rules .txt{flex:1;color:var(--ink)}
ul.rules .from{display:block;font-size:12px;color:var(--muted)}
ul.rules .tally{flex:none;display:flex;gap:4px;align-items:flex-start;flex-wrap:wrap;justify-content:flex-end;max-width:210px}
section.meta{margin-top:28px;font-size:13px;color:var(--muted)}
section.meta h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;margin:18px 0 6px;color:var(--ink)}
section.meta ul{margin:0;padding-left:18px}section.meta li{overflow-wrap:anywhere}
.empty{padding:14px 16px;color:var(--muted);border-top:1px solid var(--line)}
[hidden]{display:none!important}
`;

const SCRIPT = `
(function(){
  var status="all", q="";
  var chips=[].slice.call(document.querySelectorAll(".chip")), box=document.getElementById("q");
  function apply(){
    [].forEach.call(document.querySelectorAll("details.file"),function(file){
      var shown=0;
      [].forEach.call(file.querySelectorAll(".finding"),function(f){
        var ok=(status==="all"||f.dataset.status===status)&&(!q||f.textContent.toLowerCase().indexOf(q)>=0||file.dataset.path.indexOf(q)>=0);
        f.hidden=!ok; if(ok) shown++;
      });
      file.hidden=shown===0&&(status!=="all"||!!q);
    });
  }
  chips.forEach(function(c){c.addEventListener("click",function(){
    status=c.dataset.status; chips.forEach(function(o){o.setAttribute("aria-pressed",o===c?"true":"false")}); apply();
  })});
  box.addEventListener("input",function(){q=box.value.trim().toLowerCase(); apply()});
  var tabs=[].slice.call(document.querySelectorAll(".tab"));
  function show(tab){
    tabs.forEach(function(t){
      var on=t===tab; t.setAttribute("aria-selected",on?"true":"false"); t.tabIndex=on?0:-1;
      document.getElementById(t.getAttribute("aria-controls")).hidden=!on;
    });
    try{history.replaceState(null,"",tab.id==="tab-rules"?"#rules":"#findings")}catch(e){}
  }
  tabs.forEach(function(t,i){
    t.addEventListener("click",function(){show(t)});
    t.addEventListener("keydown",function(e){
      if(e.key!=="ArrowRight"&&e.key!=="ArrowLeft") return;
      var next=tabs[(i+(e.key==="ArrowRight"?1:tabs.length-1))%tabs.length]; next.focus(); show(next);
    });
  });
  if(location.hash==="#rules") show(document.getElementById("tab-rules"));
  var rq=document.getElementById("rq");
  rq.addEventListener("input",function(){
    var v=rq.value.trim().toLowerCase();
    [].forEach.call(document.querySelectorAll("ul.rules li"),function(li){li.hidden=!!v&&li.textContent.toLowerCase().indexOf(v)<0});
  });
})();
`;

export async function renderReport(data: ReportData, reportDir = "", existingPath?: string): Promise<ReportResult> {
  const rules = new Map(data.rules.map((r) => [r.id, r]));
  const files = new Map(data.files.map((f) => [f.path, f]));
  const { coverage, meta } = data;
  const multiPart = coverage.total > 1;
  const stripLabel = (label: string) => label.replace(/ \((lines \d+-\d+|deleted lines)\)$/, "");
  const openFiles = new Set(coverage.pending.flatMap((p) => p.files.map(stripLabel)));

  // A file split over several parts has one unit per part; they are shown together.
  const byFile = new Map<string, ReportUnit[]>();
  for (const unit of data.units) byFile.set(unit.file, [...(byFile.get(unit.file) ?? []), unit]);

  const counts = { pass: 0, fail: 0, skipped: 0, not_applicable: 0 };
  const sections: string[] = [];
  const ruleTally = new Map<string, Record<FindingStatus, number>>();
  for (const [file, units] of byFile) {
    const list = units
      .flatMap((unit) => unit.findings.map((finding) => ({ ...finding, part: unit.part })))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.part - b.part);
    const notApplicable = units.reduce((sum, unit) => {
      const judged = new Set(unit.findings.map((f) => f.rule_id));
      return sum + unit.ruleIds.filter((id) => !judged.has(id)).length;
    }, 0);
    const tally = { Fail: 0, Pass: 0, Skipped: 0 };
    for (const f of list) {
      tally[f.status]++;
      const perRule = ruleTally.get(f.rule_id) ?? { Fail: 0, Pass: 0, Skipped: 0 };
      perRule[f.status]++;
      ruleTally.set(f.rule_id, perRule);
    }
    counts.fail += tally.Fail;
    counts.pass += tally.Pass;
    counts.skipped += tally.Skipped;
    counts.not_applicable += notApplicable;

    const cards = list.map((f) => {
      const rule = rules.get(f.rule_id);
      const cls = f.status.toLowerCase();
      const where = [multiPart ? `part ${f.part}` : "", f.line && /\d/.test(f.line) ? `line ${esc(f.line)}` : ""].filter(Boolean).join(" · ");
      return (
        `<div class="finding" data-status="${cls}">` +
        `<div class="head"><span class="pill ${cls}">${esc(f.status)}</span><span class="rid">${esc(f.rule_id)}</span>` +
        `<span class="rule">${esc(rule?.text ?? "")}</span>` +
        (where ? `<span class="at">${where}</span>` : "") +
        `</div>` +
        `<p class="why">${esc(f.explanation)}</p>` +
        (f.status === "Pass"
          ? ""
          : f.fix_code?.trim()
            ? renderChange(snippetFor(files.get(f.file), f.line), f.fix_code)
            : renderSnippet(snippetFor(files.get(f.file), f.line))) +
        (f.fix ? `<p class="fix"><b>Fix:</b> ${esc(f.fix)}</p>` : "") +
        (rule ? `<div class="src-of">Rule from ${esc(rule.source)}:${esc(rule.line)}${rule.section ? ` · ${esc(rule.section)}` : ""}</div>` : "") +
        `</div>`
      );
    });

    const pills =
      (tally.Fail ? `<span class="pill fail">${tally.Fail} fail</span>` : "") +
      (tally.Skipped ? `<span class="pill skipped">${tally.Skipped} skipped</span>` : "") +
      (tally.Pass ? `<span class="pill pass">${tally.Pass} pass</span>` : "") +
      `<span class="pill na">${notApplicable} n/a</span>` +
      (openFiles.has(file) ? `<span class="pill skipped">partly audited</span>` : "");

    sections.push(
      `<details class="file" data-path="${esc(file.toLowerCase())}"${tally.Fail ? " open" : ""}>` +
        `<summary><span class="path">${esc(file)}</span>${pills}</summary>` +
        (cards.length ? cards.join("") : `<div class="empty">No rule applied to the changes in this file.</div>`) +
        `</details>`,
    );
  }

  const complete = coverage.pending.length === 0;
  const verdict = counts.fail > 0 ? "NON-COMPLIANT" : complete ? "COMPLIANT" : "INCOMPLETE";
  const verdictClass = counts.fail > 0 ? "bad" : complete ? "good" : "open";
  const repoName = path.basename(meta.repo_root);
  const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : "<p>None.</p>");
  const coverNote = complete
    ? ""
    : `<div class="cover"><b>${coverage.judged.length} of ${coverage.total} parts audited` +
      (coverage.judged.length ? ` (part${coverage.judged.length > 1 ? "s" : ""} ${coverage.judged.join(", ")})` : "") +
      `.</b> The change was too large for one pass. Not audited yet:` +
      list(coverage.pending.map((p) => `Part ${p.part}: ${esc(p.files.slice(0, 8).join(", "))}${p.files.length > 8 ? ` and ${p.files.length - 8} more` : ""}`)) +
      `</div>`;

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Compliance report · ${esc(repoName)}</title><style>${STYLE}</style></head><body><main>` +
    `<h1>Compliance report · ${esc(repoName)}</h1>` +
    `<div class="sub">${esc(meta.comparison)} · ${esc(meta.repo_root)} · ${esc(new Date().toLocaleString())}</div>` +
    `<div class="verdict ${verdictClass}">${verdict}</div>` +
    coverNote +
    `<div class="tiles">` +
    `<div class="tile fail"><b>${counts.fail}</b><span>Fail</span></div>` +
    `<div class="tile skipped"><b>${counts.skipped}</b><span>Skipped</span></div>` +
    `<div class="tile pass"><b>${counts.pass}</b><span>Pass</span></div>` +
    `<div class="tile na"><b>${counts.not_applicable}</b><span>Not applicable</span></div></div>` +
    `<div class="tabs" role="tablist">` +
    `<button class="tab" role="tab" id="tab-findings" aria-controls="panel-findings" aria-selected="true">Findings (${counts.fail + counts.skipped + counts.pass})</button>` +
    `<button class="tab" role="tab" id="tab-rules" aria-controls="panel-rules" aria-selected="false" tabindex="-1">Rules (${data.rules.length})</button>` +
    `</div>` +
    `<div id="panel-findings" role="tabpanel" aria-labelledby="tab-findings">` +
    `<div class="bar">` +
    `<button class="chip" data-status="all" aria-pressed="true">All</button>` +
    `<button class="chip" data-status="fail" aria-pressed="false">Fail</button>` +
    `<button class="chip" data-status="skipped" aria-pressed="false">Skipped</button>` +
    `<button class="chip" data-status="pass" aria-pressed="false">Pass</button>` +
    `<input id="q" type="search" placeholder="Filter by file, rule or text" aria-label="Filter findings"></div>` +
    (sections.length ? sections.join("") : `<p class="sub">No files had applicable rules.</p>`) +
    `</div>` +
    `<div id="panel-rules" role="tabpanel" aria-labelledby="tab-rules" hidden>` +
    `<div class="bar"><input id="rq" type="search" placeholder="Filter rules by key, text or source file" aria-label="Filter rules"></div>` +
    `<div class="rules-card"><ul class="rules">` +
    data.rules
      .map((rule) => {
        const t = ruleTally.get(rule.id);
        const pills = t
          ? (t.Fail ? `<span class="pill fail">${t.Fail} fail</span>` : "") +
            (t.Skipped ? `<span class="pill skipped">${t.Skipped} skipped</span>` : "") +
            (t.Pass ? `<span class="pill pass">${t.Pass} pass</span>` : "")
          : `<span class="pill na">n/a</span>`;
        return (
          `<li><span class="rid">${esc(rule.id)}</span><span class="txt">${esc(rule.text)}` +
          `<span class="from">${esc(rule.source)}:${esc(rule.line)}${rule.section ? ` · ${esc(rule.section)}` : ""}</span></span>` +
          `<span class="tally">${pills}</span></li>`
        );
      })
      .join("") +
    `</ul></div></div>` +
    `<section class="meta">` +
    `<h2>Rule sources</h2>${list(meta.rule_sources.map((s) => `${esc(s.path)} — ${s.rules} rules`))}` +
    `<h2>Warnings</h2>${list(meta.warnings.map((w) => esc(w)))}` +
    `<h2>About</h2><p>${meta.audited_files} files audited against ${meta.rules_relevant} of ` +
    `${meta.rules_discovered} discovered rules (${meta.file_rule_pairs} file–rule pairs` +
    (multiPart ? `, in ${coverage.total} parts` : "") +
    `). Verdicts were written by the AI assistant that ran the audit; ${esc(meta.tool)} v${esc(meta.version)} supplied the diff, rules and code excerpts.</p>` +
    `</section></main><script>${SCRIPT}</script></body></html>`;

  let reportPath = existingPath;
  if (!reportPath) {
    const dir = reportDir.trim() || process.env.MCP_REPO_AUDITOR_REPORT_DIR?.trim() || path.join(os.tmpdir(), "mcp-repo-auditor");
    const safeName = repoName.replace(/[^\w.-]+/g, "_") || "repo";
    reportPath = path.join(dir, `${safeName}-${timestamp(new Date())}.html`);
  }
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, html, "utf8");

  return { report_path: reportPath, report_url: pathToFileURL(reportPath).href, verdict, counts };
}

// ---------------------------------------------------------------------------
// Totals and the Markdown rendering (used when the parts were judged by subagents)
// ---------------------------------------------------------------------------

export interface ReportSummary {
  verdict: ReportResult["verdict"];
  counts: ReportResult["counts"];
}

/** Counts and verdict over the judged parts; the same arithmetic the HTML report shows. */
export function summarize(data: ReportData): ReportSummary {
  const counts = { pass: 0, fail: 0, skipped: 0, not_applicable: 0 };
  for (const unit of data.units) {
    const judged = new Set(unit.findings.map((f) => f.rule_id));
    counts.not_applicable += unit.ruleIds.filter((id) => !judged.has(id)).length;
    for (const f of unit.findings) {
      if (f.status === "Fail") counts.fail += 1;
      else if (f.status === "Pass") counts.pass += 1;
      else counts.skipped += 1;
    }
  }
  const complete = data.coverage.pending.length === 0;
  return { verdict: counts.fail > 0 ? "NON-COMPLIANT" : complete ? "COMPLIANT" : "INCOMPLETE", counts };
}

function cutText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const cell = (text: string) => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

/**
 * The compliance matrix as Markdown, built from the recorded verdicts. Used
 * when subagents judged the parts: their verdicts only exist on the server,
 * so the server writes the table and the assistant prints it as is.
 */
export function renderMarkdown(data: ReportData): string {
  const rules = new Map(data.rules.map((r) => [r.id, r]));
  const files = new Map(data.files.map((f) => [f.path, f]));
  const { verdict, counts } = summarize(data);
  const order: Record<FindingStatus, number> = { Fail: 0, Pass: 1, Skipped: 2 };
  const findings = data.units
    .flatMap((unit) => unit.findings.map((f) => ({ ...f, part: unit.part })))
    .sort((a, b) => a.file.localeCompare(b.file) || order[a.status] - order[b.status] || a.part - b.part);

  const out: string[] = ["## Compliance Matrix"];
  if (findings.length) {
    out.push("| File | Rule Checked | Status (Pass/Fail/Skipped) | Line # | Explanation & Fix |", "|---|---|---|---|---|");
    for (const f of findings) {
      const rule = rules.get(f.rule_id);
      const text = [f.explanation, f.status === "Fail" && f.fix ? `Fix: ${f.fix}` : ""].filter(Boolean).join(" ");
      out.push(
        `| ${cell(f.file)} | ${cell(`${f.rule_id}: ${cutText(rule?.text ?? "", 70)}`)} | ${f.status} | ${cell(f.line && /\d/.test(f.line) ? f.line : "—")} | ${cell(text)} |`,
      );
    }
  } else {
    out.push("No rule applied to the audited changes.");
  }

  out.push("", "## Violations");
  const fails = findings.filter((f) => f.status === "Fail");
  if (!fails.length) out.push("None.");
  for (const f of fails) {
    const rule = rules.get(f.rule_id);
    const snippet = snippetFor(files.get(f.file), f.line);
    out.push(`### \`${f.file}:${f.line && /\d/.test(f.line) ? f.line : "—"}\` — ${f.rule_id} ${cutText(rule?.text ?? "", 70)}`);
    if (snippet.length) out.push("```diff", ...snippet.map((l) => `${l.sign === "+" ? "+" : " "} ${l.code}`), "```");
    if (f.fix) out.push(`**Fix:** ${f.fix.replace(/\s+/g, " ").trim()}`);
    if (f.fix_code?.trim()) {
      const added = f.fix_code.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "").split("\n");
      out.push("```diff", ...snippet.filter((l) => l.flagged).map((l) => `- ${l.code}`), ...added.map((l) => `+ ${l}`), "```");
    }
  }

  out.push("", "## Rules Considered");
  const used = new Set(findings.map((f) => f.rule_id));
  const considered = data.rules.filter((r) => used.has(r.id));
  if (!considered.length) out.push("None of the mapped rules concerned the audited changes.");
  for (const rule of considered) out.push(`- **${rule.id}** — ${cutText(rule.text, 140)} (\`${rule.source}:${rule.line}\`)`);

  out.push("", "## Result", `\`${counts.pass} Pass · ${counts.fail} Fail · ${counts.skipped} Skipped · ${counts.not_applicable} N/A\` — **${verdict}**`);
  if (data.coverage.total > 1) {
    out.push(`\`Parts audited: ${data.coverage.judged.join(", ") || "none"} of ${data.coverage.total}\``);
    for (const p of data.coverage.pending) {
      out.push(`- Not audited: part ${p.part} (${p.files.slice(0, 6).join(", ")}${p.files.length > 6 ? ` and ${p.files.length - 6} more` : ""})`);
    }
  }
  return out.join("\n");
}

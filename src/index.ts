#!/usr/bin/env node
/**
 * mcp-repo-auditor: stdio MCP server exposing `audit_repo_compliance`.
 *
 * IMPORTANT: "./logger.js" must stay the first import. It redirects every
 * stdout-bound console method to stderr before any other module (or
 * dependency) runs, so nothing but JSON-RPC ever reaches stdout.
 */
import { logger } from "./logger.js";

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  AUDIT_TOOL_NAME,
  describePlan,
  parallelBrief,
  partCounts,
  partPayload,
  planText,
  prepareAudit,
  recordFindings,
  reportData,
  REPORT_TOOL_NAME,
  sessionKey,
  STATUS_TOOL_NAME,
  type AuditSession,
} from "./audit.js";
import { resolveRepoRoot } from "./git.js";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  normalizePreferences,
  resolveReportDir,
  savePreferences,
  SETUP_QUESTIONS,
  toPathList,
  type Preferences,
} from "./preferences.js";
import { renderMarkdown, renderReport, summarize } from "./report.js";
import type { AuditInput } from "./types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

const TOOL_NAME = AUDIT_TOOL_NAME;
const CONFIGURE_TOOL_NAME = "configure_audit";

/**
 * The most recent audit of this session. A large change is handed out in
 * parts from this one snapshot, and the report tool records verdicts against it.
 */
let session: AuditSession | undefined;

/** Report writes run one at a time: subagents finishing together must not overwrite a newer report with an older one. */
let reportWrites: Promise<unknown> = Promise.resolve();

type SetupOutcome =
  | { kind: "ready"; preferences: Preferences; note?: string }
  | { kind: "ask" }
  | { kind: "cancelled" };

/** Normalises raw answers; `problem` is set when the report folder is not usable (it is then left empty). */
async function finalizePreferences(
  repoRoot: string,
  raw: Parameters<typeof normalizePreferences>[0],
): Promise<{ preferences: Preferences; problem?: string }> {
  const preferences = normalizePreferences(raw);
  const resolved = await resolveReportDir(repoRoot, typeof raw.reportDir === "string" ? raw.reportDir : "");
  if ("problem" in resolved) return { preferences: { ...preferences, reportDir: "" }, problem: resolved.problem };
  return { preferences: { ...preferences, reportDir: resolved.dir } };
}

/**
 * Asks the setup questions through the client's own form UI (MCP elicitation)
 * when it has one. Otherwise returns "ask" so the host LLM puts the questions
 * to the user in chat and saves the answers with configure_audit.
 */
async function runSetup(repoRoot: string, current: Preferences | undefined): Promise<SetupOutcome> {
  if (!server.server.getClientCapabilities()?.elicitation) return { kind: "ask" };
  const start = current ?? DEFAULT_PREFERENCES;
  const [format, folder, extra, base] = SETUP_QUESTIONS;
  const ask = (problem?: string) =>
    server.server.elicitInput(
      {
        message:
          (problem ? `${problem}\n\n` : "") +
          `Repo auditor setup for ${path.basename(repoRoot)}. Your answers are remembered for this repository.`,
        requestedSchema: {
          type: "object",
          properties: {
            report: {
              type: "string",
              title: format.question,
              description: format.options.join("; "),
              enum: ["markdown", "html"],
              // No default on a first run: the user has to choose, so HTML is never missed by accident.
              ...(current ? { default: current.report } : {}),
            },
            reportDir: { type: "string", title: "HTML report folder", description: folder.question, default: start.reportDir },
            customRulePaths: {
              type: "string",
              title: "Extra rule files",
              description: extra.question,
              default: start.customRulePaths.join(", "),
            },
            branch: { type: "string", title: "Base branch", description: base.question, default: start.branch },
          },
          required: ["report"],
        },
      },
      { timeout: 10 * 60_000 },
    );
  try {
    let result = await ask();
    if (result.action === "cancel") return { kind: "cancelled" };
    // Declining the form means "just use the defaults"; remember that so it is not asked again.
    let final = await finalizePreferences(repoRoot, result.action === "accept" ? (result.content ?? {}) : start);
    if (final.problem) {
      // One more chance to give a usable folder before falling back to the temp folder.
      result = await ask(final.problem);
      if (result.action === "cancel") return { kind: "cancelled" };
      if (result.action === "accept") final = await finalizePreferences(repoRoot, result.content ?? {});
    }
    await savePreferences(repoRoot, final.preferences);
    return {
      kind: "ready",
      preferences: final.preferences,
      ...(final.problem ? { note: `Report folder not set: ${final.problem} Reports go to the system temp folder.` } : {}),
    };
  } catch (error) {
    logger.warn(`setup form failed, falling back to chat questions: ${(error as Error).message}`);
    return { kind: "ask" };
  }
}

type PlanDecision = { kind: "go"; parallel: boolean; paths: string[] } | { kind: "ask" } | { kind: "cancelled" };

/**
 * A change that needs several parts is never started silently. The user sees
 * the plan and decides: through the client's form when it has one, otherwise
 * the assistant shows the plan in chat ("ask").
 */
async function approvePlan(audit: AuditSession): Promise<PlanDecision> {
  if (!server.server.getClientCapabilities()?.elicitation) return { kind: "ask" };
  try {
    const result = await server.server.elicitInput(
      {
        message: `${planText(audit)}\n\nChoose how to proceed. You will see each part as it is audited.`,
        requestedSchema: {
          type: "object",
          properties: {
            proceed: {
              type: "string",
              title: "How should this be audited?",
              description:
                "all = every part, one after another, shown as each is judged; " +
                "parallel = every part at the same time by subagents (faster, uses more tokens at once, needs a client with subagents); " +
                "cancel = stop, nothing is audited",
              enum: ["all", "parallel", "cancel"],
            },
            paths: {
              type: "string",
              title: "Or audit only these files or folders",
              description: "Comma-separated, relative to the repository (e.g. src/api, src/big.ts). Leave blank to audit everything.",
            },
          },
          required: ["proceed"],
        },
      },
      { timeout: 10 * 60_000 },
    );
    if (result.action !== "accept" || result.content?.proceed === "cancel") return { kind: "cancelled" };
    return { kind: "go", parallel: result.content?.proceed === "parallel", paths: toPathList(result.content?.paths) };
  } catch (error) {
    logger.warn(`plan form failed, falling back to chat: ${(error as Error).message}`);
    return { kind: "ask" };
  }
}

const server = new McpServer(
  { name: pkg.name, version: pkg.version },
  {
    capabilities: { tools: {} },
    instructions:
      "Use audit_repo_compliance to check local git changes against the repository's own AI steering rules " +
      "(.cursorrules, .clinerules, .windsurfrules, AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, .kiro/steering, docs). " +
      "The tool returns JSON; follow its system_evaluator_prompt field exactly when writing the answer. " +
      'When the user wants an HTML or browser report, call it with report: "html". ' +
      "A change too large for one result is audited in parts: the tool first returns a plan for the user to approve, then one part per call.",
  },
);

/**
 * Picks the repository directory: explicit tool argument > MCP_REPO_AUDITOR_ROOT
 * env var > first file:// root advertised by the client > process.cwd().
 */
async function pickStartDir(repoPath: string | undefined): Promise<string> {
  if (repoPath && repoPath.trim()) return path.resolve(repoPath.trim());
  const fromEnv = process.env.MCP_REPO_AUDITOR_ROOT;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());

  if (server.server.getClientCapabilities()?.roots) {
    try {
      const { roots } = await server.server.listRoots(undefined, { timeout: 5_000 });
      const fileRoot = roots.find((r) => r.uri.startsWith("file://"));
      if (fileRoot) return fileURLToPath(fileRoot.uri);
    } catch (error) {
      logger.warn(`roots/list failed, falling back to cwd: ${(error as Error).message}`);
    }
  }
  return process.cwd();
}

server.registerTool(
  TOOL_NAME,
  {
    title: "Audit repository compliance",
    description:
      "Deterministically collects the local git diff (staged, working tree, or branch vs base), discovers the repo's " +
      "steering/instruction files, extracts atomic rules, and maps only the relevant rules to each changed file. " +
      "Returns a JSON payload {meta, changed_files, discovered_rules, file_rule_mappings, system_evaluator_prompt}. " +
      "After calling, act as the compliance judge described in system_evaluator_prompt. " +
      "A change too large for one result returns plan_required instead: show the user the plan, let them choose, then request the parts one at a time with `part`.",
    inputSchema: {
      scope: z
        .enum(["staged", "working", "branch"])
        .default("staged")
        .describe(
          "staged = index vs HEAD; working = all uncommitted changes incl. untracked files; branch = commits on HEAD since merge-base with `branch`.",
        ),
      branch: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe('Base branch for scope "branch" (falls back to origin/<branch>). Omit to use the saved preference, or the repository\'s default branch if none.'),
      customRulePaths: z
        .array(z.string().min(1).max(1024))
        .max(100)
        .optional()
        .describe("Extra rule files, directories or globs, relative to the repository root, added to the saved ones. Paths outside the repo are refused."),
      repoPath: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          "Absolute path inside the git repository to audit. Defaults to MCP_REPO_AUDITOR_ROOT, the client's first root, or the server's working directory.",
        ),
      report: z
        .enum(["markdown", "html"])
        .optional()
        .describe(
          `Only set this when the user asked for a format in this request; otherwise omit it so their saved preference applies. markdown = print the compliance matrix in the reply; html = send the verdicts to ${REPORT_TOOL_NAME}, which writes a browsable HTML report.`,
        ),
      paths: z
        .array(z.string().min(1).max(1024))
        .max(200)
        .optional()
        .describe("Audit only these changed files, folders or globs, relative to the repository root (e.g. [\"src/api\", \"src/big.ts\"]). Omit to audit every changed file."),
      part: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe("Which part of a multi-part audit to return. Only set it after the user has approved the plan from a plan_required result, or when a result's NEXT STEP says so."),
      parallel: z
        .boolean()
        .optional()
        .describe("Set true only when the user chose, at the plan, to audit the parts in parallel with subagents. The result is then a brief for the subagents instead of a part."),
      reconfigure: z
        .boolean()
        .optional()
        .describe("Set true when the user wants to change their saved audit preferences; the setup questions are asked again."),
    },
    annotations: {
      title: "Audit repository compliance",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ scope, branch: branchArg, customRulePaths: extraRulePaths, repoPath, report: reportArg, reconfigure, paths, part, parallel }) => {
    const started = Date.now();
    try {
      const startDir = await pickStartDir(repoPath);
      const repoRoot = await resolveRepoRoot(startDir);

      // First audit of a repository: ask the user how they want it run, once.
      let saved = await loadPreferences(repoRoot);
      let setupNote: string | undefined;
      const setupOff = process.env.MCP_REPO_AUDITOR_SETUP?.trim().toLowerCase() === "off";
      if (reconfigure || (!saved && reportArg === undefined && !setupOff)) {
        const outcome = await runSetup(repoRoot, saved);
        if (outcome.kind === "cancelled") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ cancelled: true, message: "The user cancelled the setup questions. Do not audit; tell them nothing was run." }) }] };
        }
        if (outcome.kind === "ask") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  setup_required: true,
                  repo_root: repoRoot,
                  instructions:
                    "Nothing has been audited yet. Ask the user ALL of the questions below in one message (use your question/choice UI if you have one) and wait for the answers. " +
                    `Then call ${CONFIGURE_TOOL_NAME} with repoPath set to repo_root and their answers (omit anything left blank), and call ${TOOL_NAME} again with the same arguments as before, without reconfigure. Do not answer the questions yourself.`,
                  questions: SETUP_QUESTIONS,
                  current_preferences: saved ?? null,
                }),
              },
            ],
          };
        }
        saved = outcome.preferences;
        setupNote = outcome.note;
      }
      const preferences = saved ?? DEFAULT_PREFERENCES;
      const report = reportArg ?? preferences.report;
      const branch = branchArg ?? preferences.branch;
      const customRulePaths = [...new Set([...preferences.customRulePaths, ...(extraRulePaths ?? [])])];
      logger.info(`audit scope=${scope} branch=${branch || "(default)"} report=${report} repo=${repoRoot}`);

      const input: AuditInput = { scope, branch, customRulePaths, paths: paths ?? [], repoPath, report };
      const ctx = { repoRoot, toolName: TOOL_NAME, version: pkg.version };
      // A later part comes from the snapshot the plan was made from, so the parts always add up to one diff.
      // When the user narrowed the audit in the plan form, the assistant's arguments carry no paths: keep the user's selection.
      const continues =
        part !== undefined &&
        session !== undefined &&
        session.key === sessionKey({ ...input, paths: paths ?? session.input.paths }, repoRoot);
      let audit = continues && session ? session : await prepareAudit(input, ctx);
      session = audit;

      const total = Math.max(1, audit.parts.length);
      if (part !== undefined && part > total) {
        throw new Error(`This audit has ${total} part${total > 1 ? "s" : ""}; there is no part ${part}.`);
      }
      if (part === undefined && audit.parts.length > 1) {
        // Arguments that reproduce this audit; a subagent adds its part number to them.
        const briefFor = (current: AuditSession) =>
          parallelBrief(current, {
            repoPath: repoRoot,
            scope,
            ...(branchArg ? { branch: branchArg } : {}),
            ...(current.input.paths.length ? { paths: current.input.paths } : {}),
            ...(extraRulePaths?.length ? { customRulePaths: extraRulePaths } : {}),
            report,
          });
        const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

        // parallel: true means the user already saw the plan and chose it.
        const decision: PlanDecision = parallel ? { kind: "go", parallel: true, paths: [] } : await approvePlan(audit);
        if (decision.kind === "cancelled") {
          return asText({ cancelled: true, message: "The user cancelled at the audit plan. Nothing was audited; tell them so." });
        }
        if (decision.kind === "ask") {
          return asText({
            plan_required: true,
            repo_root: repoRoot,
            scope,
            comparison: audit.diff.comparison,
            summary: planText(audit),
            plan: describePlan(audit),
            instructions:
              "Nothing has been audited yet. Show the user the summary and a table of the parts (part, files, added lines), then ask how to proceed and wait for the answer. Do not choose for them. Options: " +
              `(1) audit everything, one part after another, shown as each part is judged: call ${TOOL_NAME} again with the same arguments plus part: 1, then follow each result's NEXT STEP through all parts; ` +
              "(2) audit everything in parallel with subagents (faster, uses more tokens at once, and only works if you can start subagents that can call this server's tools): call again with the same arguments plus parallel: true; " +
              "(3) audit only some parts: request just those part numbers, one call each; " +
              "(4) audit only some files or folders: call again with paths: [...] and no part; " +
              "(5) cancel.",
          });
        }
        if (decision.paths.length) {
          audit = await prepareAudit({ ...input, paths: decision.paths }, ctx);
          session = audit;
        }
        if (decision.parallel && audit.parts.length > 1) {
          audit.parallel = true;
          return asText(briefFor(audit));
        }
      }

      const payload = partPayload(audit, part ?? 1);
      if (setupNote) payload.meta.warnings.push(setupNote);
      payload.meta.preferences = {
        report,
        report_dir: preferences.reportDir || "system temp folder",
        custom_rule_paths: customRulePaths,
        branch: branch || "repository default (detected)",
        source: saved ? "saved for this repository" : "defaults",
      };
      const s = payload.meta.stats;
      logger.info(
        `audit done in ${Date.now() - started}ms: files=${s.changed_files} audited=${s.audited_files} ` +
          `rules=${s.rules_relevant}/${s.rules_discovered} pairs=${s.file_rule_pairs}`,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`audit failed: ${message}`);
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: message, tool: TOOL_NAME }) }],
      };
    }
  },
);

server.registerTool(
  REPORT_TOOL_NAME,
  {
    title: "Render compliance report",
    description:
      `Writes a self-contained HTML report for the most recent ${TOOL_NAME} call in this session from your verdicts, ` +
      "and returns its path. Rule text, offending code and N/A counts are filled in by the server. " +
      "In a multi-part audit, call it once per part with `part`: each call adds that part's verdicts, rewrites the same report file " +
      "(which states the parts still open) and returns next_step. " +
      "The file goes to the report folder the user chose at setup, or the system temp directory if they chose none.",
    inputSchema: {
      findings: z
        .array(
          z.object({
            file: z.string().min(1).max(4096).describe("File path exactly as in file_rule_mappings."),
            rule_id: z.string().min(1).max(32).describe('Rule id, e.g. "R12".'),
            status: z.enum(["Fail", "Pass", "Skipped"]),
            line: z.string().max(200).optional().describe('New-file line number(s), e.g. "42", "42-45" or "19, 23".'),
            explanation: z.string().min(1).max(2000).describe("One sentence explaining the verdict."),
            fix: z.string().max(4000).optional().describe("One sentence saying what to change; required for Fail."),
            fix_code: z
              .string()
              .max(8000)
              .optional()
              .describe("When the fix is a code change: the replacement code for the cited lines, original indentation, no diff markers or fences."),
          }),
        )
        .max(5000)
        .describe("One entry per non-N/A (file, rule) pair. Omit N/A pairs."),
      part: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe("In a multi-part audit: the part these findings belong to (required there). Omit for an audit with a single part."),
    },
    annotations: {
      title: "Render compliance report",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ findings, part }) => {
    try {
      if (!session) throw new Error(`No audit in this session yet. Call ${TOOL_NAME} first.`);
      const audit = session;
      const total = Math.max(1, audit.parts.length);
      const number = part ?? (total === 1 ? 1 : undefined);
      if (number === undefined) throw new Error(`This audit has ${total} parts. Pass part: <n> with the findings for that part.`);
      if (number > total) throw new Error(`This audit has ${total} part${total > 1 ? "s" : ""}; there is no part ${number}.`);
      if (!audit.served.has(number)) {
        throw new Error(`Part ${number} has not been requested yet. Call ${TOOL_NAME} with part: ${number} first and judge what it returns.`);
      }
      const ignored = recordFindings(audit, number, findings);
      const judged = [...audit.findings.keys()].sort((a, b) => a - b);
      const pending = audit.parts.filter((p) => !audit.findings.has(p.number)).map((p) => p.number);
      const progress = { ignored_findings: ignored, part_counts: partCounts(audit, number), parts: { total, judged, pending }, complete: pending.length === 0 };

      // A parallel Markdown audit has no report file: the combined table comes from the status tool.
      if (audit.parallel && audit.input.report !== "html") {
        logger.info(`verdicts recorded for part ${number} of ${total}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ recorded: true, ...summarize(reportData(audit)), ...progress, next_step: "Recorded. Reply with the one line your instructions ask for." }) }],
        };
      }

      // Read the folder now, not at audit time, so a preference changed in between is honoured.
      const reportDir = (await loadPreferences(audit.ctx.repoRoot))?.reportDir ?? "";
      const write = reportWrites.then(async () => {
        const written = await renderReport(reportData(audit), reportDir, audit.reportPath);
        audit.reportPath = written.report_path;
        return written;
      });
      reportWrites = write.catch(() => undefined);
      const report = await write;
      const result = {
        ...report,
        ...progress,
        ...(audit.parallel
          ? { next_step: "Recorded. Reply with the one line your instructions ask for." }
          : total > 1
            ? {
                next_step: pending.length
                  ? `Parts not audited yet: ${pending.join(", ")}. Unless the user asked for only some parts, call ${TOOL_NAME} now with the same arguments plus part: ${pending[0]}.`
                  : "Every part is audited and the report is complete. Give the user the final two lines.",
              }
            : {}),
      };
      logger.info(`report written to ${report.report_path} (part ${number} of ${total})`);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`report failed: ${message}`);
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: message, tool: REPORT_TOOL_NAME }) }],
      };
    }
  },
);

server.registerTool(
  STATUS_TOOL_NAME,
  {
    title: "Audit status",
    description:
      `Reports where the most recent ${TOOL_NAME} audit of this session stands: which parts have verdicts, the totals and the verdict so far. ` +
      "After a parallel audit it also returns the combined result: the report path (HTML) or the finished Markdown table. " +
      "Call it when the subagents of a parallel audit have returned, or when the user asks how far an audit got.",
    inputSchema: {},
    annotations: { title: "Audit status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      if (!session) throw new Error(`No audit in this session yet. Call ${TOOL_NAME} first.`);
      const audit = session;
      await reportWrites;
      const data = reportData(audit);
      const total = Math.max(1, audit.parts.length);
      const judged = [...audit.findings.keys()].sort((a, b) => a - b);
      const pending = audit.parts.filter((p) => !audit.findings.has(p.number)).map((p) => p.number);
      const html = audit.input.report === "html";
      const result = {
        ...summarize(data),
        parts: { total, judged, pending, handed_out_without_verdicts: pending.filter((n) => audit.served.has(n)) },
        complete: pending.length === 0,
        report_format: audit.input.report ?? "markdown",
        ...(html ? { report_path: audit.reportPath ?? null } : audit.parallel ? { markdown: renderMarkdown(data) } : {}),
        next_step: pending.length
          ? `Parts without verdicts: ${pending.join(", ")}. ` +
            (audit.parallel
              ? "Start a subagent for each of them once more (same brief), then call this tool again. If that was already tried, tell the user which parts are open."
              : `Request them from ${TOOL_NAME} with part: <n>, or tell the user which parts are open.`)
          : html
            ? "Every part has verdicts. Give the user the counts, the verdict and the report path."
            : audit.parallel
              ? "Every part has verdicts. Print the markdown field exactly as returned, and nothing else."
              : "Every part has been handed out.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`status failed: ${message}`);
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, tool: STATUS_TOOL_NAME }) }] };
    }
  },
);

server.registerTool(
  CONFIGURE_TOOL_NAME,
  {
    title: "Save audit preferences",
    description:
      `Saves the user's audit preferences for one repository (report format, HTML report folder, extra rule files, base branch). ` +
      `Call it with the user's own answers after ${TOOL_NAME} returns setup_required, or when they ask to change a preference. ` +
      "Only the fields you pass are changed. Preferences are stored in the user's home directory, not in the repository.",
    inputSchema: {
      repoPath: z.string().min(1).max(4096).optional().describe("Absolute path inside the repository. Same default as the audit tool."),
      report: z.enum(["markdown", "html"]).optional().describe("markdown = table in the chat/terminal; html = report file for the browser."),
      reportDir: z.string().max(4096).optional().describe("Folder for HTML reports. Empty string = system temp folder. Relative paths are taken from the repository root."),
      customRulePaths: z.array(z.string().min(1).max(1024)).max(100).optional().describe("Extra rule files, folders or globs relative to the repository root. Replaces the saved list."),
      branch: z.string().max(255).optional().describe("Base branch for branch audits. Empty string = the repository's default branch, detected automatically."),
    },
    annotations: { title: "Save audit preferences", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ repoPath, ...changes }) => {
    try {
      const repoRoot = await resolveRepoRoot(await pickStartDir(repoPath));
      const current = (await loadPreferences(repoRoot)) ?? DEFAULT_PREFERENCES;
      const given = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      // An explicit empty folder means "back to the temp folder", so it must not fall through to the default.
      const { preferences, problem } = await finalizePreferences(repoRoot, { ...current, ...given });
      if (problem) throw new Error(`${problem} Ask the user for the folder again; nothing was saved.`);
      const file = await savePreferences(repoRoot, preferences);
      logger.info(`preferences saved for ${repoRoot}`);
      return { content: [{ type: "text" as const, text: JSON.stringify({ saved: true, repo_root: repoRoot, preferences, stored_in: file }) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`configure failed: ${message}`);
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, tool: CONFIGURE_TOOL_NAME }) }] };
    }
  },
);

let shuttingDown = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down`);
  try {
    await server.close();
  } catch (error) {
    logger.error(`error during shutdown: ${(error as Error).message}`);
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// The client closing our stdin means the session is over.
process.stdin.on("end", () => void shutdown("stdin end"));
process.on("uncaughtException", (error) => {
  logger.error(`uncaught exception: ${error.stack ?? error.message}`);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  logger.error(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`${pkg.name} v${pkg.version} ready on stdio (cwd=${process.cwd()})`);
}

main().catch((error) => {
  logger.error(`fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});

/**
 * Per-repository user preferences (report format, report folder, extra rule
 * paths, base branch). Stored in the user's home directory, never in the
 * audited repository, so asking the setup questions once does not dirty it.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Preferences {
  report: "markdown" | "html";
  /** Folder for HTML reports; empty = system temp directory. */
  reportDir: string;
  /** Extra rule files, folders or globs, relative to the repository root. */
  customRulePaths: string[];
  /** Base branch used by scope "branch". */
  branch: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  report: process.env.MCP_REPO_AUDITOR_REPORT?.trim().toLowerCase() === "html" ? "html" : "markdown",
  reportDir: process.env.MCP_REPO_AUDITOR_REPORT_DIR?.trim() ?? "",
  customRulePaths: [],
  branch: "main",
};

/** The questions asked before a repository's first audit. Shared by the form and the chat fallback. */
export const SETUP_QUESTIONS = [
  {
    key: "report",
    question: "How do you want the results?",
    options: ["markdown = a table in the chat / terminal", "html = a report file you open in a browser"],
  },
  {
    key: "reportDir",
    question: "If HTML: which folder should reports be saved in? (absolute path; blank = system temp folder)",
  },
  {
    key: "customRulePaths",
    question:
      "Any extra instruction or rule files/folders to audit against, besides the ones found automatically? (paths relative to the repo, comma-separated; blank = none)",
  },
  {
    key: "branch",
    question: 'Which base branch should branch audits compare against? (blank = "main")',
  },
] as const;

const HOME_FOLDERS: Array<[RegExp, string]> = [
  [/\bdownloads?\b/i, "Downloads"],
  [/\bdesktop\b/i, "Desktop"],
  [/\bdocuments?\b/i, "Documents"],
];

/**
 * Turns what the user typed for the report folder into an absolute path.
 * People answer in words ("in the downloads folder"), so well-known home
 * folders are recognised; anything else that is not a path is rejected
 * rather than silently created as a oddly named folder inside the repository.
 */
export async function resolveReportDir(repoRoot: string, input: string): Promise<{ dir: string } | { problem: string }> {
  const value = input.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!value) return { dir: "" };
  if (value === "~" || /^~[\\/]/.test(value)) return { dir: path.join(os.homedir(), value.slice(1)) };
  if (path.isAbsolute(value)) return { dir: path.normalize(value) };

  const inRepo = path.resolve(repoRoot, value);
  const isDir = async (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false);
  if (await isDir(inRepo)) return { dir: inRepo };

  if (/\s/.test(value)) {
    for (const [pattern, folder] of HOME_FOLDERS) {
      const candidate = path.join(os.homedir(), folder);
      if (pattern.test(value) && (await isDir(candidate))) return { dir: candidate };
    }
    return { problem: `"${value}" is not a folder path. Give a full path such as ${path.join(os.homedir(), "Downloads")}, or leave it blank.` };
  }
  for (const [pattern, folder] of HOME_FOLDERS) {
    const candidate = path.join(os.homedir(), folder);
    if (new RegExp(`^${pattern.source}$`, "i").test(value) && (await isDir(candidate))) return { dir: candidate };
  }
  // A plain relative path ("audit-reports") is a new folder inside the repository.
  return { dir: inRepo };
}

function storePath(): string {
  const dir = process.env.MCP_REPO_AUDITOR_CONFIG_DIR?.trim() || path.join(os.homedir(), ".mcp-repo-auditor");
  return path.join(dir, "preferences.json");
}

function repoKey(repoRoot: string): string {
  const resolved = path.resolve(repoRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readStore(): Promise<Record<string, Partial<Preferences>>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(storePath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, Partial<Preferences>>)
      : {};
  } catch {
    return {};
  }
}

/** "a.md, docs/rules" or ["a.md"] -> clean list. */
export function toPathList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : [];
  return items.map((item) => String(item).trim()).filter(Boolean).slice(0, 100);
}

/** Fills gaps and discards anything malformed, so a hand-edited file cannot break an audit. */
export function normalizePreferences(raw: Partial<Record<keyof Preferences, unknown>>): Preferences {
  const report = String(raw.report ?? "").trim().toLowerCase();
  const reportDir = typeof raw.reportDir === "string" ? raw.reportDir.trim() : "";
  const branch = typeof raw.branch === "string" ? raw.branch.trim() : "";
  return {
    report: report === "html" || report === "markdown" ? report : DEFAULT_PREFERENCES.report,
    reportDir: reportDir || DEFAULT_PREFERENCES.reportDir,
    customRulePaths: toPathList(raw.customRulePaths),
    branch: branch || DEFAULT_PREFERENCES.branch,
  };
}

export async function loadPreferences(repoRoot: string): Promise<Preferences | undefined> {
  const saved = (await readStore())[repoKey(repoRoot)];
  return saved ? normalizePreferences(saved) : undefined;
}

export async function savePreferences(repoRoot: string, preferences: Preferences): Promise<string> {
  const file = storePath();
  const store = await readStore();
  store[repoKey(repoRoot)] = preferences;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return file;
}

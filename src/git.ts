/**
 * Git CLI integration and unified-diff parser.
 *
 * Security notes:
 *  - git is always invoked via execFile with an argument array (never a shell),
 *    so user-supplied values cannot inject shell syntax.
 *  - Branch names are validated and may not start with "-", so they cannot be
 *    interpreted as git options.
 *  - Untracked files are only read when they resolve inside the repository root.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { logger } from "./logger.js";
import type {
  ChangedFile,
  DiffHunk,
  DiffLine,
  DiffResult,
  DiffScope,
} from "./types.js";

// ---------------------------------------------------------------------------
// Limits (overridable through environment variables)
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const LIMITS = {
  /**
   * Target size of one tool result, in characters. Clients cap tool results
   * (Claude Code at 25,000 tokens by default), so a larger change is audited
   * in several parts of about this size.
   */
  maxPayloadChars: envInt("MCP_REPO_AUDITOR_MAX_CHARS", 64_000),
  /** Max size of an untracked file read from disk. */
  maxUntrackedBytes: envInt("MCP_REPO_AUDITOR_MAX_UNTRACKED_BYTES", 512 * 1024),
  /** git command timeout. */
  gitTimeoutMs: envInt("MCP_REPO_AUDITOR_GIT_TIMEOUT_MS", 60_000),
};

const MAX_BUFFER = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Git process helpers
// ---------------------------------------------------------------------------

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Global -c flags that make output deterministic regardless of user config. */
const GIT_CONFIG_FLAGS = [
  "-c", "core.quotepath=off",
  "-c", "color.ui=never",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicprefix=false",
  "-c", "diff.relative=false",
];

interface RunGitOptions {
  /** Exit codes treated as success (default [0]). */
  okExitCodes?: number[];
  /** Data written to stdin. */
  input?: string;
}

export function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> {
  const okExitCodes = options.okExitCodes ?? [0];
  const fullArgs = [...GIT_CONFIG_FLAGS, ...args];

  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      fullArgs,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        timeout: LIMITS.gitTimeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const errno = error as NodeJS.ErrnoException & { code?: string | number };
        if (errno.code === "ENOENT") {
          reject(new GitError("git executable not found on PATH.", args, null, ""));
          return;
        }
        const exitCode = typeof errno.code === "number" ? errno.code : null;
        if (exitCode !== null && okExitCodes.includes(exitCode)) {
          resolve(stdout);
          return;
        }
        const detail = (stderr || error.message).trim();
        reject(new GitError(`git ${args.join(" ")} failed: ${detail}`, args, exitCode, stderr));
      },
    );

    // Always close stdin so git never waits for input.
    if (child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input ?? "");
    }
  });
}

/** Absolute path of the repository top-level directory containing `startDir`. */
export async function resolveRepoRoot(startDir: string): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(startDir);
  } catch {
    throw new Error(`Repository path does not exist: ${startDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${startDir}`);
  }
  try {
    const out = await runGit(startDir, ["rev-parse", "--show-toplevel"]);
    return path.resolve(out.trim());
  } catch (error) {
    if (error instanceof GitError && error.exitCode === null) throw error;
    const detail = error instanceof GitError ? error.stderr.trim() : "";
    if (!detail || /not a git repository/i.test(detail)) {
      throw new Error(
        `Not inside a git repository: ${startDir}. Call again with repoPath set to the absolute path of the repository to audit ` +
          "(ask the user if you do not know it), or set MCP_REPO_AUDITOR_ROOT in the server's config.",
      );
    }
    // Anything else (e.g. git's "dubious ownership" refusal, a broken config) is not a wrong folder: pass git's own words on.
    throw new Error(`git could not open the repository at ${startDir}: ${detail}`);
  }
}

async function hasHead(repoRoot: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return true;
  } catch {
    return false;
  }
}

/** Empty tree object id for this repository's hash algorithm (SHA-1 or SHA-256). */
async function emptyTreeId(repoRoot: string): Promise<string> {
  const out = await runGit(repoRoot, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
  return out.trim();
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/@{}~^+-]*$/;

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

const COMMON_DEFAULT_BRANCHES = ["main", "master", "develop", "trunk"];

/**
 * The repository's default branch: what origin/HEAD points at, otherwise the
 * first conventional name that exists. A local branch wins over origin/<name>.
 */
async function detectDefaultBranch(repoRoot: string): Promise<string | undefined> {
  const names = [...COMMON_DEFAULT_BRANCHES];
  try {
    const head = (await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (head.startsWith("origin/")) names.unshift(head.slice("origin/".length));
  } catch {
    // No origin/HEAD (no remote, or never set): fall back to the conventional names.
  }
  for (const name of names) {
    for (const ref of [name, `origin/${name}`]) {
      if (await refExists(repoRoot, ref)) return ref;
    }
  }
  return undefined;
}

/** Up to 15 branch names, for error messages. */
async function listBranches(repoRoot: string): Promise<string> {
  try {
    const out = await runGit(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
    const names = out.split("\n").map((n) => n.trim()).filter((n) => n && n !== "origin" && !n.endsWith("/HEAD"));
    if (!names.length) return "";
    return ` Branches here: ${names.slice(0, 15).join(", ")}${names.length > 15 ? ", …" : ""}.`;
  } catch {
    return "";
  }
}

/**
 * Resolves the base for a branch audit to an existing commit-ish. An empty
 * `branch` means "the repository's default branch", which is detected.
 */
export async function resolveBaseRef(repoRoot: string, branch: string): Promise<string> {
  const candidate = branch.trim();
  if (!candidate) {
    const detected = await detectDefaultBranch(repoRoot);
    if (detected) return detected;
    throw new Error(
      `Could not work out which branch to compare against. Ask the user and pass it as "branch".${await listBranches(repoRoot)}`,
    );
  }
  if (!SAFE_REF.test(candidate) || candidate.includes("..")) {
    throw new Error(
      `Invalid branch name "${branch}". Use a plain ref such as "main", "origin/main" or a commit SHA.`,
    );
  }

  const candidates = [candidate];
  if (!candidate.startsWith("origin/")) candidates.push(`origin/${candidate}`);

  for (const ref of candidates) {
    if (await refExists(repoRoot, ref)) return ref;
  }
  const detected = await detectDefaultBranch(repoRoot);
  throw new Error(
    `Base branch "${candidate}" not found locally or as origin/${candidate}.` +
      (detected ? ` This repository's default branch looks like "${detected}"; call again with that as "branch" if it is what the user means.` : "") +
      (await listBranches(repoRoot)),
  );
}

// ---------------------------------------------------------------------------
// Unified diff parser
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Decodes a C-style quoted path as emitted by git for unusual file names. */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    n: 0x0a, t: 0x09, r: 0x0d, b: 0x08, f: 0x0c, v: 0x0b, a: 0x07, '"': 0x22, "\\": 0x5c,
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      for (const byte of Buffer.from(ch, "utf8")) bytes.push(byte);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? next;
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      i += octal.length;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

/** Parses a path following "--- " / "+++ " / "rename from " etc. */
function parsePathToken(raw: string): string {
  let value = raw;
  if (value.startsWith('"')) {
    // Find the closing quote, honoring escapes.
    let end = 1;
    while (end < value.length) {
      if (value[end] === "\\") end += 2;
      else if (value[end] === '"') break;
      else end += 1;
    }
    return unquoteGitPath(value.slice(0, end + 1));
  }
  // git appends a TAB after names containing spaces (GNU patch compatibility).
  const tab = value.indexOf("\t");
  if (tab !== -1) value = value.slice(0, tab);
  return value;
}

/** Best-effort path extraction from "diff --git a/X b/Y". Later headers override it. */
function parseDiffGitHeader(rest: string): { oldPath: string; newPath: string } {
  if (rest.startsWith('"')) {
    const first = parsePathToken(rest);
    let end = 1;
    while (end < rest.length) {
      if (rest[end] === "\\") end += 2;
      else if (rest[end] === '"') break;
      else end += 1;
    }
    const second = parsePathToken(rest.slice(end + 2));
    return { oldPath: stripPrefix(first), newPath: stripPrefix(second) };
  }
  // Common case: identical paths "a/P b/P".
  if ((rest.length - 5) % 2 === 0) {
    const half = (rest.length - 5) / 2;
    const left = rest.slice(2, 2 + half);
    const right = rest.slice(2 + half + 3);
    if (left === right && rest.startsWith("a/") && rest.slice(2 + half, 2 + half + 3) === " b/") {
      return { oldPath: left, newPath: right };
    }
  }
  const split = rest.lastIndexOf(" b/");
  if (split > 0) {
    return { oldPath: stripPrefix(rest.slice(0, split)), newPath: rest.slice(split + 3) };
  }
  return { oldPath: stripPrefix(rest), newPath: stripPrefix(rest) };
}

function newChangedFile(oldPath: string, newPath: string): ChangedFile {
  return {
    path: newPath,
    oldPath: oldPath !== newPath ? oldPath : undefined,
    status: "modified",
    isBinary: false,
    additions: 0,
    deletions: 0,
    addedLineNumbers: [],
    hunks: [],
  };
}

/**
 * Parses `git diff` unified output into structured file objects.
 * Hunk bodies are consumed by line count, so content lines that look like
 * headers (e.g. a deleted line starting with "-- ") are handled correctly.
 */
export function parseUnifiedDiff(diffText: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const lines = diffText.split("\n");

  let file: ChangedFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldLine = 0;
  let newLine = 0;

  const finishFile = () => {
    if (!file) return;
    if (file.oldPath === file.path) file.oldPath = undefined;
    files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    // Drop a trailing CR so CRLF files render cleanly.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    // Inside a hunk body: consume exactly the advertised number of lines.
    if (file && hunk && (oldRemaining > 0 || newRemaining > 0)) {
      const marker = line[0];
      const content = line.slice(1);
      let parsed: DiffLine | null = null;
      if (marker === "+") {
        parsed = { type: "add", content, newLineNumber: newLine };
        file.additions += 1;
        file.addedLineNumbers.push(newLine);
        newLine += 1;
        newRemaining -= 1;
      } else if (marker === "-") {
        parsed = { type: "del", content, oldLineNumber: oldLine };
        file.deletions += 1;
        oldLine += 1;
        oldRemaining -= 1;
      } else if (marker === " " || line === "") {
        parsed = { type: "context", content, oldLineNumber: oldLine, newLineNumber: newLine };
        oldLine += 1;
        newLine += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
      } else if (marker === "\\") {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noNewlineAtEof = true;
        continue;
      } else {
        // Malformed / unexpected: end the hunk and reprocess this line as a header.
        oldRemaining = 0;
        newRemaining = 0;
        i -= 1;
        continue;
      }
      hunk.lines.push(parsed);
      continue;
    }

    if (line.startsWith("diff --git ")) {
      finishFile();
      const { oldPath, newPath } = parseDiffGitHeader(line.slice("diff --git ".length));
      file = newChangedFile(oldPath, newPath);
      continue;
    }

    if (!file) continue;
    const current: ChangedFile = file;

    if (line.startsWith("@@ ")) {
      const match = HUNK_HEADER.exec(line);
      if (!match) continue;
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      hunk = {
        header: line,
        oldStart,
        oldLines: oldCount,
        newStart,
        newLines: newCount,
        section: match[5]?.trim() || undefined,
        lines: [],
      };
      current.hunks.push(hunk);
      oldRemaining = oldCount;
      newRemaining = newCount;
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" after the hunk's last line.
      const last = hunk?.lines[hunk.lines.length - 1];
      if (last) last.noNewlineAtEof = true;
      continue;
    }

    if (line.startsWith("new file mode")) {
      current.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      current.oldPath = parsePathToken(line.slice("rename from ".length));
      current.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      current.path = parsePathToken(line.slice("rename to ".length));
      current.status = "renamed";
    } else if (line.startsWith("copy from ")) {
      current.oldPath = parsePathToken(line.slice("copy from ".length));
      current.status = "copied";
    } else if (line.startsWith("copy to ")) {
      current.path = parsePathToken(line.slice("copy to ".length));
      current.status = "copied";
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.isBinary = true;
    } else if (line.startsWith("--- ")) {
      const p = parsePathToken(line.slice(4));
      if (p === "/dev/null") current.status = "added";
      else current.oldPath = stripPrefix(p);
    } else if (line.startsWith("+++ ")) {
      const p = parsePathToken(line.slice(4));
      if (p === "/dev/null") current.status = "deleted";
      else current.path = stripPrefix(p);
    }
  }
  finishFile();

  // For deletions, the meaningful path is the old one.
  for (const f of files) {
    if (f.status === "deleted" && f.oldPath) {
      f.path = f.oldPath;
      f.oldPath = undefined;
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Noise filtering and path selection
// ---------------------------------------------------------------------------

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "Cargo.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "Gemfile.lock", "composer.lock",
  "go.sum", "packages.lock.json", "flake.lock", "mix.lock", "pubspec.lock", "Podfile.lock",
]);

const GENERATED_DIRS = [
  "node_modules/", "dist/", "build/", "out/", ".next/", ".nuxt/", ".svelte-kit/", "coverage/",
  "vendor/", "__pycache__/", ".turbo/", ".cache/", "target/",
];

function skipReasonFor(file: ChangedFile): string | undefined {
  if (file.status === "deleted") return "file deleted (nothing to audit)";
  if (file.isBinary) return "binary file";
  const base = path.posix.basename(file.path);
  if (LOCKFILES.has(base)) return "lockfile";
  if (/\.min\.(js|css)$/i.test(base) || /\.map$/i.test(base)) return "minified/source-map artifact";
  if (/\.(snap)$/i.test(base)) return "test snapshot";
  const withSlash = `/${file.path}`;
  if (GENERATED_DIRS.some((dir) => withSlash.includes(`/${dir}`))) return "generated/vendored path";
  return undefined;
}

/** Marks the files that are never audited (deleted, binary, lockfiles, generated). Nothing else is dropped. */
function markSkipped(files: ChangedFile[]): void {
  for (const file of files) {
    const reason = skipReasonFor(file);
    if (!reason) continue;
    file.skippedReason = reason;
    file.hunks = [];
  }
}

/**
 * Test for the user's `paths` selection. Each entry is a file, a folder or a
 * glob, relative to the repository root (absolute paths inside it also work).
 */
function pathSelector(repoRoot: string, paths: string[]): ((filePath: string) => boolean) | undefined {
  const tests: Array<(filePath: string) => boolean> = [];
  for (const raw of paths) {
    let entry = raw.trim();
    if (!entry) continue;
    if (path.isAbsolute(entry)) entry = path.relative(repoRoot, entry);
    entry = entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!entry || entry === ".") return undefined;
    const isGlob = picomatch(entry, { dot: true });
    tests.push((filePath) => filePath === entry || filePath.startsWith(`${entry}/`) || isGlob(filePath));
  }
  return tests.length ? (filePath) => tests.some((test) => test(filePath)) : undefined;
}

// ---------------------------------------------------------------------------
// Untracked files (working scope)
// ---------------------------------------------------------------------------

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function untrackedFiles(repoRoot: string, warnings: string[]): Promise<ChangedFile[]> {
  const out = await runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = out.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];

  for (const relPath of paths) {
    const abs = path.resolve(repoRoot, relPath);
    if (!isInside(repoRoot, abs)) continue;

    const file: ChangedFile = {
      path: relPath.split(path.sep).join("/"),
      status: "untracked",
      isBinary: false,
      additions: 0,
      deletions: 0,
      addedLineNumbers: [],
      hunks: [],
    };

    try {
      const stat = await fs.lstat(abs);
      if (!stat.isFile()) continue;
      if (stat.size > LIMITS.maxUntrackedBytes) {
        file.skippedReason = `untracked file larger than ${LIMITS.maxUntrackedBytes} bytes`;
        files.push(file);
        continue;
      }
      const buffer = await fs.readFile(abs);
      if (buffer.subarray(0, 8000).includes(0)) {
        file.isBinary = true;
        files.push(file);
        continue;
      }
      const text = buffer.toString("utf8");
      const contentLines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
      const endsWithNewline = text.endsWith("\n");
      if (endsWithNewline) contentLines.pop();

      const hunkLines: DiffLine[] = contentLines.map((content, idx) => ({
        type: "add",
        content,
        newLineNumber: idx + 1,
      }));
      if (!endsWithNewline && hunkLines.length > 0) {
        (hunkLines[hunkLines.length - 1] as DiffLine).noNewlineAtEof = true;
      }
      file.additions = hunkLines.length;
      file.addedLineNumbers = hunkLines.map((l) => l.newLineNumber as number);
      if (hunkLines.length > 0) {
        file.hunks.push({
          header: `@@ -0,0 +1,${hunkLines.length} @@`,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: hunkLines.length,
          lines: hunkLines,
        });
      }
      files.push(file);
    } catch (error) {
      warnings.push(`Could not read untracked file ${relPath}: ${(error as Error).message}`);
    }
  }
  return files;
}

/** Number of files with unstaged or untracked changes; explains an empty staged audit. */
async function countUnstagedFiles(repoRoot: string): Promise<number> {
  try {
    const out = await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const entries = out.split("\0");
    let count = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      // Renames and copies are followed by a second field holding the old path.
      if (entry[0] === "R" || entry[0] === "C") i += 1;
      count += 1;
    }
    return count;
  } catch (error) {
    logger.warn(`git status failed: ${(error as Error).message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const DIFF_FLAGS = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--unified=3",
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short",
];

export async function getDiff(repoRoot: string, scope: DiffScope, branch: string, paths: string[] = []): Promise<DiffResult> {
  const warnings: string[] = [];
  const headExists = await hasHead(repoRoot);
  let args: string[];
  let comparison: string;

  switch (scope) {
    case "staged":
      // Works without HEAD too: git compares the index against the empty tree.
      args = [...DIFF_FLAGS, "--cached", "--"];
      comparison = headExists ? "index vs HEAD (staged changes)" : "index vs empty tree (initial commit)";
      break;
    case "working":
      if (headExists) {
        args = [...DIFF_FLAGS, "HEAD", "--"];
        comparison = "working tree vs HEAD (staged + unstaged + untracked)";
      } else {
        args = [...DIFF_FLAGS, await emptyTreeId(repoRoot), "--"];
        comparison = "working tree vs empty tree (no commits yet) + untracked";
      }
      break;
    case "branch": {
      if (!headExists) throw new Error("Branch scope requires at least one commit on HEAD.");
      const base = await resolveBaseRef(repoRoot, branch);
      args = [...DIFF_FLAGS, `${base}...HEAD`, "--"];
      comparison = `${base}...HEAD (committed changes since merge-base)`;
      break;
    }
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unknown scope: ${String(exhaustive)}`);
    }
  }

  logger.debug(`Running git ${args.join(" ")} in ${repoRoot}`);
  const diffText = await runGit(repoRoot, args);
  let files = parseUnifiedDiff(diffText);

  if (scope === "working") {
    const known = new Set(files.map((f) => f.path));
    const extra = (await untrackedFiles(repoRoot, warnings)).filter((f) => !known.has(f.path));
    files = files.concat(extra);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  // "Audit my changes" before any `git add` is common; say what is waiting instead of just "nothing".
  const unstagedFiles = scope === "staged" && files.length === 0 ? await countUnstagedFiles(repoRoot) : 0;

  const selected = pathSelector(repoRoot, paths);
  if (selected) {
    const all = files.length;
    files = files.filter((f) => selected(f.path));
    if (!files.length && all) warnings.push(`None of the ${all} changed file(s) match the requested paths: ${paths.join(", ")}.`);
  }
  markSkipped(files);

  return { repoRoot, scope, comparison, files, warnings, ...(unstagedFiles ? { unstagedFiles } : {}) };
}

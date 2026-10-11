/**
 * Shared type definitions for mcp-repo-auditor.
 */

// ---------------------------------------------------------------------------
// Git / diff
// ---------------------------------------------------------------------------

/** Which set of changes to audit. */
export type DiffScope = "staged" | "working" | "branch";

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked";

export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** Line content without the leading +/-/space marker and without trailing CR. */
  content: string;
  /** Line number in the old file (absent for added lines). */
  oldLineNumber?: number;
  /** Line number in the new file (absent for deleted lines). */
  newLineNumber?: number;
  /** True when git reported "\ No newline at end of file" for this line. */
  noNewlineAtEof?: boolean;
}

export interface DiffHunk {
  /** Raw hunk header, e.g. "@@ -10,7 +10,9 @@ function foo()". */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Optional function/section context git prints after the second "@@". */
  section?: string;
  lines: DiffLine[];
}

export interface ChangedFile {
  /** Repo-relative POSIX path of the file after the change. */
  path: string;
  /** Previous path for renames/copies. */
  oldPath?: string;
  status: FileStatus;
  isBinary: boolean;
  additions: number;
  deletions: number;
  /** New-file line numbers of every added line. */
  addedLineNumbers: number[];
  hunks: DiffHunk[];
  /** Set when hunks were omitted (lockfile, generated, binary, too large). */
  skippedReason?: string;
  /** True when hunks were cut to stay within the line or size budget. */
  truncated?: boolean;
}

export interface DiffResult {
  repoRoot: string;
  scope: DiffScope;
  /** Human-readable description of what was compared, e.g. "main...HEAD". */
  comparison: string;
  files: ChangedFile[];
  warnings: string[];
  /** Set when a staged audit found nothing: how many files have unstaged or untracked changes. */
  unstagedFiles?: number;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RuleCategory =
  | "UI/React"
  | "Backend/API"
  | "Backend/DB"
  | "Testing"
  | "Infra/DevOps"
  | "Documentation"
  | "General/Security"
  | "General/Style"
  | "General";

export type RuleSourceKind =
  | "cursor"
  | "cline"
  | "windsurf"
  | "agents"
  | "claude"
  | "copilot"
  | "kiro"
  | "docs"
  | "custom";

/** A file that steering rules were read from. */
export interface RuleSource {
  /** Repo-relative POSIX path. */
  path: string;
  kind: RuleSourceKind;
  format: "markdown" | "json" | "text";
  /** File-level globs from frontmatter (Cursor globs, Copilot applyTo, Kiro fileMatchPattern). */
  appliesTo: string[];
  /** True when frontmatter marks the file as always applied. */
  alwaysApply: boolean;
  /** Languages the whole file targets (from its name/title); inherited by its rules. */
  languages: string[];
  ruleCount: number;
}

export interface Rule {
  /** Stable short id, e.g. "R7". */
  id: string;
  /** The atomic rule text. */
  text: string;
  /** Repo-relative path of the file the rule came from. */
  sourceFile: string;
  sourceKind: RuleSourceKind;
  /** 1-based line number in the source file (0 for JSON sources). */
  sourceLine: number;
  /** Nearest enclosing Markdown heading(s), joined with " > ". */
  section?: string;
  /** Primary category. */
  category: RuleCategory;
  /** Every category the rule scored on, strongest first. */
  tags: RuleCategory[];
  /** Programming languages the rule explicitly targets (empty = language-agnostic). */
  languages: string[];
  /** Explicit globs restricting which files the rule applies to (empty = use category matching). */
  appliesTo: string[];
}

export interface SkippedRuleSource {
  path: string;
  reason: string;
}

export interface RuleDiscoveryResult {
  sources: RuleSource[];
  rules: Rule[];
  skipped: SkippedRuleSource[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Derived characteristics of a changed file used for rule relevance. */
export interface FileProfile {
  path: string;
  extension: string;
  language?: string;
  /** Domains inferred from extension/path plus added-line content. */
  domains: RuleCategory[];
  /** Subset of `domains` inferred only from the added lines' content. */
  contentDomains: RuleCategory[];
  isCode: boolean;
  isDoc: boolean;
}

export interface RuleMatch {
  ruleId: string;
  /** Why the rule was associated, e.g. "glob **\/*.tsx" or "category UI/React". */
  reason: string;
}

export interface FileRuleMapping {
  file: string;
  status: FileStatus;
  domains: RuleCategory[];
  language?: string;
  rules: RuleMatch[];
}

export interface MatchResult {
  mappings: FileRuleMapping[];
  /** Ids of rules mapped to at least one file. */
  relevantRuleIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Tool payload
// ---------------------------------------------------------------------------

export interface AuditInput {
  scope: DiffScope;
  branch: string;
  customRulePaths: string[];
  repoPath?: string;
  /** "html" asks the host LLM to send its verdicts to the report tool instead of printing a matrix. */
  report?: "markdown" | "html";
}

/** Compact, token-efficient rendering of a hunk for the host LLM. */
export interface PayloadHunk {
  header: string;
  /**
   * Annotated lines: "+  42 | code" (added), "-     | code" (deleted), "   43 | code" (context).
   * The number is the NEW-file line number used in the compliance matrix.
   */
  lines: string[];
}

export interface PayloadChangedFile {
  path: string;
  old_path?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  added_line_numbers: string;
  skipped_reason?: string;
  truncated?: boolean;
  hunks: PayloadHunk[];
}

export interface PayloadRule {
  id: string;
  text: string;
  source: string;
  line: number;
  section?: string;
  category: RuleCategory;
  applies_to?: string[];
  languages?: string[];
}

export interface PayloadMapping {
  file: string;
  domains: RuleCategory[];
  language?: string;
  rule_ids: string[];
  /** Why each rule was selected: reason -> rule ids. */
  match_basis: Record<string, string[]>;
}

export interface AuditPayload {
  meta: {
    tool: string;
    version: string;
    repo_root: string;
    scope: DiffScope;
    comparison: string;
    generated_at: string;
    stats: {
      changed_files: number;
      audited_files: number;
      rule_sources: number;
      rules_discovered: number;
      rules_relevant: number;
      rules_excluded: number;
      file_rule_pairs: number;
    };
    rule_sources: Array<{ path: string; kind: RuleSourceKind; rules: number }>;
    skipped_rule_sources: SkippedRuleSource[];
    /** Present when a staged audit found nothing staged: files with unstaged or new changes. */
    unstaged_files?: number;
    warnings: string[];
    /** The preferences this audit ran with, and where they came from. */
    preferences?: {
      report: "markdown" | "html";
      report_dir: string;
      custom_rule_paths: string[];
      branch: string;
      source: string;
    };
  };
  changed_files: PayloadChangedFile[];
  discovered_rules: PayloadRule[];
  file_rule_mappings: PayloadMapping[];
  system_evaluator_prompt: string;
}

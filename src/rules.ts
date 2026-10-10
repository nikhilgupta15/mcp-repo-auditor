/**
 * Discovery and parsing of repository steering / instruction files into
 * atomic, classified rules.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { runGit } from "./git.js";
import { logger } from "./logger.js";
import type {
  Rule,
  RuleCategory,
  RuleDiscoveryResult,
  RuleSource,
  RuleSourceKind,
  SkippedRuleSource,
} from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_RULE_FILE_BYTES = 256 * 1024;
const MAX_RULES_TOTAL = 1500;
const MAX_RULE_TEXT = 500;
const MIN_RULE_TEXT = 10;

interface DiscoveryPattern {
  pattern: string;
  kind: RuleSourceKind;
  /** Strict sources (general docs, specs) only yield sentences with directive language. */
  strict?: boolean;
}

/** Ordered by priority: dedicated AI rule files first, general docs last. */
const DISCOVERY_PATTERNS: DiscoveryPattern[] = [
  // Root-level single-file rule formats
  { pattern: ".cursorrules", kind: "cursor" },
  { pattern: ".clinerules", kind: "cline" },
  { pattern: ".windsurfrules", kind: "windsurf" },
  { pattern: "AGENTS.md", kind: "agents" },
  { pattern: "CLAUDE.md", kind: "claude" },
  // Directory-based rule formats
  { pattern: ".cursor/rules/**/*.{md,mdc}", kind: "cursor" },
  { pattern: ".clinerules/**/*.{md,txt}", kind: "cline" },
  { pattern: ".windsurf/rules/**/*.md", kind: "windsurf" },
  { pattern: ".github/copilot-instructions.md", kind: "copilot" },
  { pattern: ".github/instructions/**/*.instructions.md", kind: "copilot" },
  { pattern: ".kiro/steering/**/*.md", kind: "kiro" },
  { pattern: ".kiro/steering/**/*.json", kind: "kiro" },
  { pattern: ".kiro/**/*.md", kind: "kiro", strict: true },
  { pattern: ".claude/rules/**/*.md", kind: "claude" },
  { pattern: ".{agent,agents}/{rules,guidelines,workflows,steering}/**/*.{md,mdc}", kind: "agents" },
  { pattern: ".{agent,agents}/*/SKILL.md", kind: "agents" },
  { pattern: ".{agent,agents}/skills/*/SKILL.md", kind: "agents" },
  { pattern: ".claude/skills/*/SKILL.md", kind: "claude" },
  // Nested, directory-scoped agent files (apply only to their subtree)
  { pattern: "**/AGENTS.md", kind: "agents" },
  { pattern: "**/CLAUDE.md", kind: "claude" },
  // General documentation
  { pattern: "docs/CONTRIBUTING.md", kind: "docs", strict: true },
  { pattern: "docs/ARCHITECTURE.md", kind: "docs", strict: true },
  { pattern: "CONTRIBUTING.md", kind: "docs", strict: true },
  { pattern: "ARCHITECTURE.md", kind: "docs", strict: true },
  { pattern: ".github/CONTRIBUTING.md", kind: "docs", strict: true },
];

const GLOB_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/.next/**",
  "**/coverage/**",
  "**/target/**",
  "**/.venv/**",
  "**/venv/**",
  "**/env/**",
  "**/site-packages/**",
  "**/__pycache__/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/.ruff_cache/**",
  "**/.tox/**",
  "**/.cache/**",
  "**/.turbo/**",
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type Signals = Array<[RegExp, number]>;

/** Tie-break order: earlier categories win equal scores. */
const CATEGORY_ORDER: RuleCategory[] = [
  "General/Security",
  "Backend/DB",
  "Backend/API",
  "UI/React",
  "Testing",
  "Infra/DevOps",
  "Documentation",
  "General/Style",
];

const CATEGORY_SIGNALS: Record<Exclude<RuleCategory, "General">, Signals> = {
  "General/Security": [
    [/\b(secrets?|credentials?|passwords?|api[ -]?keys?|private keys?|access tokens?|tokens?)\b/i, 3],
    [/\b(xss|csrf|ssrf|sql injection|injection|sanitiz\w*|escap(e|ing) (user|html|input)|untrusted)\b/i, 3],
    [/\b(auth(entication|orization)?|permissions?|rbac|acl|least privilege|oauth|jwt|sessions?)\b/i, 2],
    [/\b(encrypt\w*|hash(ed|ing)? passwords?|bcrypt|argon2|tls|https only|cors|csp|security|vulnerab\w*|cve)\b/i, 3],
    [/\b(\.env|environment variables?|hard-?cod\w* (secrets?|keys?|credentials?)|pii|personal data|gdpr)\b/i, 2],
    [/\b(validate|validation of) (all )?(user )?input\b/i, 2],
  ],
  "Backend/DB": [
    [/\b(databases?|db|sql|queries|query|migrations?|schemas?|orm|transactions?|indexes|indices)\b/i, 2],
    [/\b(prisma|drizzle|typeorm|sequelize|knex|mongoose|sqlalchemy|alembic|active ?record|hibernate|jpa|gorm)\b/i, 3],
    [/\b(postgres(ql)?|mysql|mariadb|sqlite|mongo(db)?|redis|dynamodb|cassandra|supabase|tables?|columns?|foreign keys?)\b/i, 2],
    [/\b(n\+1|connection pool\w*|repository pattern|repositories)\b/i, 2],
  ],
  "Backend/API": [
    [/\b(api|apis|endpoints?|routes?|routers?|controllers?|handlers?|middlewares?|rest(ful)?|graphql|grpc|trpc|webhooks?)\b/i, 2],
    [/\b(http|status codes?|requests?|responses?|payloads?|rate[- ]limit\w*|pagination|idempoten\w*)\b/i, 1.5],
    [/\b(express|fastify|koa|nestjs|hono|django|flask|fastapi|spring|gin|rails|laravel|server[- ]side|backend)\b/i, 2],
  ],
  "UI/React": [
    [/\b(react|jsx|tsx|components?|props|hooks?|use(State|Effect|Memo|Callback|Ref|Context|Reducer)|server components?|client components?)\b/i, 3],
    [/\b(ui|ux|frontend|front-end|css|tailwind|styled-components|scss|sass|stylesheets?|theme|design system|layout|responsive)\b/i, 2],
    [/\b(accessib\w*|a11y|aria|alt text|keyboard navigation|screen readers?|semantic html|html|dom|render(ing|s)?)\b/i, 2],
    [/\b(vue|svelte|angular|next\.?js|nuxt|remix|solid(js)?|astro|redux|zustand|tanstack|react query|storybook|shadcn|mui|chakra)\b/i, 3],
    [/\b(buttons?|forms?|modals?|pages?|screens?|views?|animations?|icons?)\b/i, 1],
  ],
  Testing: [
    [/\b(tests?|testing|unit tests?|integration tests?|e2e|end-to-end|test coverage|coverage|assertions?|test cases?)\b/i, 3],
    [/\b(jest|vitest|mocha|chai|pytest|unittest|playwright|cypress|testing library|rtl|junit|rspec|mocks?|mocking|stubs?|fixtures?|snapshots?)\b/i, 3],
    [/\b(tdd|spec files?|describe\(|it\()\b/i, 2],
  ],
  "Infra/DevOps": [
    [/\b(docker(file)?|containeri[sz]\w*|container images?|docker containers?|kubernetes|k8s|helm|terraform|pulumi|ansible|cloudformation|cdk)\b/i, 3],
    [/\b(ci|cd|ci\/cd|pipelines?|github actions|workflows?|gitlab ci|jenkins|deploy\w*|releases?|infrastructure|infra)\b/i, 2],
    [/\b(aws|gcp|azure|lambda|s3|ec2|cloud run|vercel|netlify|nginx|load balancer)\b/i, 2],
  ],
  Documentation: [
    [/\b(documentation|docs|readme|changelog|jsdoc|tsdoc|docstrings?|comments?|commenting|adr|architecture decision)\b/i, 3],
    [/\b(document(ed|ing)?|explain\w* why)\b/i, 1.5],
  ],
  "General/Style": [
    [/\b(code style|coding style|style guides?|style conventions?|conventions?|best practices)\b/i, 3],
    [/\b(naming|names?|camel ?case|pascal ?case|snake_case|kebab-case|prefix(ed)?|suffix(ed)?)\b/i, 2],
    [/\b(format\w*|prettier|eslint|lint\w*|indent\w*|semicolons?|quotes|line length|whitespace|tabs|spaces)\b/i, 2],
    [/\b(imports?|exports?|default exports?|named exports?|types?|interfaces?|any|strict mode|immutab\w*|const|let|var|functions?|classes?|async|await|promises?|errors?|exceptions?|logging|console\.log)\b/i, 1],
    [/\b(readab\w*|clean code|dry|solid|single responsibility|complexity|magic numbers?|dead code|duplicat\w*|refactor\w*)\b/i, 1.5],
  ],
};

const LANGUAGE_SIGNALS: Array<[string, RegExp]> = [
  ["typescript", /\b(typescript|tsx?|\.tsx?|tsconfig)\b/i],
  ["javascript", /\b(javascript|jsx|node\.?js|\.jsx?|ecmascript|es6|commonjs)\b/i],
  ["python", /\b(python|pep ?8|pydantic|django|flask|fastapi|pytest|\.py|mypy|ruff|black formatter)\b/i],
  ["go", /\b(golang|go modules?|go code|go files?|\.go|gofmt|goroutines?)\b/i],
  ["rust", /\b(rust|cargo|crates?|\.rs|clippy|borrow checker|unsafe blocks?)\b/i],
  ["java", /\b(java|spring boot|maven|\.java)\b/i],
  ["scala", /\b(scala|sbt|scalafmt|scalafix|scalatest|akka|pekko|zio|cats effect|\.scala)\b/i],
  ["kotlin", /\b(kotlin|\.kt|ktor|jetpack compose)\b/i],
  ["csharp", /(\bc#|\.net\b|\bdotnet\b|\basp\.net\b|\.cs\b)/i],
  ["ruby", /\b(ruby|rails|\.rb|rubocop|gems?)\b/i],
  ["php", /\b(php|laravel|symfony|composer|\.php)\b/i],
  ["swift", /\b(swift|swiftui|\.swift|xcode)\b/i],
  ["cpp", /(\bc\+\+|\bcpp\b|\bcmake\b|\bclang(-tidy|-format)?\b|\.(cpp|hpp|cc)\b)/i],
  ["elixir", /\b(elixir|phoenix|ecto|mix\.exs|\.exs?)\b/i],
  ["dart", /\b(dart|flutter|\.dart)\b/i],
];

export interface Classification {
  category: RuleCategory;
  tags: RuleCategory[];
  languages: string[];
}

function scoreText(text: string, weight: number, scores: Map<RuleCategory, number>): void {
  if (!text) return;
  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS) as Array<[RuleCategory, Signals]>) {
    for (const [regex, points] of signals) {
      if (regex.test(text)) scores.set(category, (scores.get(category) ?? 0) + points * weight);
    }
  }
}

/** Classifies rule text using the rule itself, its section heading and its source file name. */
export function classifyRule(text: string, section = "", sourcePath = "", hint = ""): Classification {
  const scores = new Map<RuleCategory, number>();
  scoreText(text, 1, scores);
  scoreText(section, 0.6, scores);
  scoreText(hint, 1.5, scores);
  // File names like ".kiro/steering/frontend.md" or "react.instructions.md".
  scoreText(path.posix.basename(sourcePath).replace(/[._-]+/g, " "), 0.5, scores);

  const ranked = CATEGORY_ORDER.filter((c) => (scores.get(c) ?? 0) > 0).sort(
    (a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
  );

  // Only the rule text (not headings) decides language restrictions.
  const languages = LANGUAGE_SIGNALS.filter(([, regex]) => regex.test(text)).map(([lang]) => lang);

  return {
    category: ranked[0] ?? "General",
    tags: ranked.length ? ranked : ["General"],
    languages,
  };
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

type FrontmatterValue = string | boolean | string[];

interface Frontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
  /** Number of lines consumed by the frontmatter block (to keep line numbers accurate). */
  lineOffset: number;
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseScalar(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item))
      .filter(Boolean);
  }
  return unquote(value);
}

/** Minimal YAML frontmatter parser (key: value, inline arrays, block lists). */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^﻿/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: {}, body: normalized, lineOffset: 0 };

  const end = lines.findIndex((line, idx) => idx > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end === -1) return { data: {}, body: normalized, lineOffset: 0 };

  const data: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    const listItem = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      const existing = data[currentKey];
      const list = Array.isArray(existing) ? existing : [];
      list.push(unquote(listItem[1] ?? ""));
      data[currentKey] = list;
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1] as string;
      const rawValue = kv[2] ?? "";
      data[currentKey] = rawValue.trim() === "" ? [] : parseScalar(rawValue);
    }
  }
  return { data, body: lines.slice(end + 1).join("\n"), lineOffset: end + 1 };
}

function toGlobList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined || typeof value === "boolean") return [];
  const list = Array.isArray(value) ? value : value.split(",");
  return list.map((g) => g.trim()).filter((g) => g.length > 0 && g !== "*" && g !== "**" && g !== "**/*");
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

interface Candidate {
  text: string;
  line: number;
  section?: string;
  appliesTo?: string[];
  hint?: string;
}

const DIRECTIVE =
  /\b(must|must not|never|always|should|should not|shouldn't|do not|don't|avoid|prefer|ensure|require[sd]?|shall|use|using|only|forbid\w*|prohibit\w*|disallow\w*|mandatory|need to|needs to|make sure|keep|enforce|limit|follow|no more than|at least|at most)\b/i;

const NON_RULE_PREFIX =
  /^(you are\b|you're an?\b|this (file|document|repo|repository|project|guide)\b|these (rules|guidelines|instructions)\b|the following\b|below (are|is)\b|see (also|the)\b|table of contents|toc\b|note:|example:|e\.g\.)/i;

/**
 * Instructions about how the agent should work in a session ("before answering
 * questions, read ...", "after modifying code, run ...") rather than about the
 * code itself. They cannot be judged against a diff.
 */
const AGENT_PROCESS =
  /\b(before (answering|responding|starting|beginning|you (start|begin|answer))|in this session|when (asked|answering|the user)|if the user\b|for .{0,40}\bquestions?\b|after (modifying|editing|changing) (code|files?)\b.{0,40}\brun\b|instead of reading\b|(guidelines|documentation|rules|standards) (located |found |defined )?in the\b.{0,80}\b(directory|folder)\b)/i;

function cleanMarkdown(text: string): string {
  return text
    .replace(/<!--.*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/^[\s>]+/, "")
    .replace(/^(✅|❌|⚠️|🚫|👉|✔️|✖️|☑️)\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isAcceptable(text: string, strict: boolean): boolean {
  if (text.length < MIN_RULE_TEXT) return false;
  if (text.split(/\s+/).length < 2) return false;
  if (NON_RULE_PREFIX.test(text)) return false;
  if (AGENT_PROCESS.test(text)) return false;
  if (/^[#|`\-=*_~\s]+$/.test(text)) return false;
  if (strict && !DIRECTIVE.test(text)) return false;
  return true;
}

function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface BulletFrame {
  indent: number;
  text: string;
  candidate: Candidate & { dropped?: boolean };
}

/** Extracts atomic rule candidates from Markdown / plain text. */
export function extractMarkdownRules(body: string, lineOffset: number, strict: boolean): Candidate[] {
  const out: Array<Candidate & { dropped?: boolean }> = [];
  const lines = body.split(/\r?\n/);
  const headings: Array<{ level: number; text: string }> = [];
  const bulletStack: BulletFrame[] = [];

  let fence: string | null = null;
  let paragraph: { text: string; line: number } | null = null;
  let bullet: { text: string; line: number; parent?: BulletFrame; indent: number } | null = null;

  const sectionName = () => (headings.length ? headings.map((h) => h.text).join(" > ") : undefined);

  const flushParagraph = () => {
    if (!paragraph) return;
    const section = sectionName();
    for (const sentence of splitSentences(cleanMarkdown(paragraph.text))) {
      // Lead-in sentences ("Follow these rules:") introduce lists; they are not rules.
      if (sentence.endsWith(":")) continue;
      // Prose is mostly context ("This is the backend for X", "Your architect is Y"), so a
      // sentence only counts as a rule when it uses directive language. Bullets are exempt.
      if (isAcceptable(sentence, true)) {
        out.push({ text: sentence, line: paragraph.line, section });
      }
    }
    paragraph = null;
  };

  const flushBullet = () => {
    if (!bullet) return;
    const text = cleanMarkdown(bullet.text);
    const parentText = bullet.parent?.text.replace(/:$/, "").trim();
    const full = parentText && bullet.parent?.text.endsWith(":") ? `${parentText}: ${text}` : text;
    const candidate: Candidate & { dropped?: boolean } = { text: full, line: bullet.line, section: sectionName() };
    if (bullet.parent?.text.endsWith(":")) bullet.parent.candidate.dropped = true;
    out.push(candidate);
    bulletStack.push({ indent: bullet.indent, text, candidate });
    bullet = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNo = i + 1 + lineOffset;

    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      flushParagraph();
      flushBullet();
      const marker = (fenceMatch[1] as string).slice(0, 3);
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null) continue;

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      flushBullet();
      bulletStack.length = 0;
      const level = (heading[1] as string).length;
      while (headings.length && (headings[headings.length - 1] as { level: number }).level >= level) headings.pop();
      headings.push({ level, text: cleanMarkdown(heading[2] ?? "") });
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushBullet();
      continue;
    }

    // Setext heading underline or horizontal rule.
    if (/^\s*(=+|-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushBullet();
      continue;
    }

    // Tables: treat each data row as a candidate line.
    if (/^\s*\|/.test(line)) {
      flushParagraph();
      flushBullet();
      const isSeparator = (l: string | undefined) => l !== undefined && /^\s*\|?\s*:?-{2,}/.test(l);
      // Separator rows and header rows (the row right above a separator) are not rules.
      if (isSeparator(line) || isSeparator(lines[i + 1])) continue;
      const cells = line.split("|").map((c) => cleanMarkdown(c)).filter(Boolean);
      const text = cells.join(" — ");
      if (isAcceptable(text, true)) out.push({ text, line: lineNo, section: sectionName() });
      continue;
    }

    const bulletMatch = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bulletMatch) {
      flushParagraph();
      flushBullet();
      const indent = (bulletMatch[1] ?? "").replace(/\t/g, "    ").length;
      while (bulletStack.length && (bulletStack[bulletStack.length - 1] as BulletFrame).indent >= indent) {
        bulletStack.pop();
      }
      bullet = { text: bulletMatch[2] ?? "", line: lineNo, parent: bulletStack[bulletStack.length - 1], indent };
      continue;
    }

    if (bullet && /^\s+\S/.test(line)) {
      bullet.text += ` ${line.trim()}`;
      continue;
    }

    flushBullet();
    bulletStack.length = 0;
    if (paragraph) paragraph.text += ` ${line.trim()}`;
    else paragraph = { text: line.trim(), line: lineNo };
  }
  flushParagraph();
  flushBullet();

  return out
    .filter((c) => !c.dropped)
    .filter((c) => !(c.text.endsWith(":") && c.text.length < 80))
    .filter((c) => isAcceptable(c.text, strict))
    .map(({ dropped: _dropped, ...rest }) => rest);
}

const JSON_TEXT_KEYS = new Set([
  "rule", "text", "instruction", "instructions", "guideline", "content", "requirement",
  "policy", "directive", "prompt", "description", "message", "body", "do", "dont", "don't",
]);
const JSON_GLOB_KEYS = new Set(["filematchpattern", "globs", "glob", "applyto", "appliesto", "files", "include", "paths", "pattern"]);
const JSON_CATEGORY_KEYS = new Set(["category", "scope", "area", "domain", "type", "tag", "tags"]);
const JSON_META_KEYS = new Set([
  "name", "id", "version", "title", "$schema", "schema", "author", "created", "updated",
  "inclusion", "enabled", "severity", "level", "priority", "url", "link", "path",
]);

function lineOfString(raw: string, value: string): number {
  const encoded = JSON.stringify(value).slice(1, -1);
  const idx = raw.indexOf(encoded);
  if (idx === -1) return 0;
  return raw.slice(0, idx).split("\n").length;
}

/** Walks arbitrary steering JSON and extracts rule candidates. */
export function extractJsonRules(raw: string): Candidate[] {
  const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ""));
  const out: Candidate[] = [];

  const visit = (node: unknown, keyPath: string[], globs: string[], hint: string, parentKey: string | null) => {
    if (typeof node === "string") {
      const text = cleanMarkdown(node);
      const key = (parentKey ?? "").toLowerCase();
      const isListItem = parentKey === null;
      const isTextKey = JSON_TEXT_KEYS.has(key);
      if (JSON_META_KEYS.has(key) || JSON_GLOB_KEYS.has(key) || JSON_CATEGORY_KEYS.has(key)) return;
      if ((isListItem || isTextKey) ? isAcceptable(text, false) : isAcceptable(text, true) && text.length >= 15) {
        out.push({
          text,
          line: lineOfString(raw, node),
          section: keyPath.filter((k) => !/^\d+$/.test(k)).join(" > ") || undefined,
          appliesTo: globs.length ? globs : undefined,
          hint: hint || undefined,
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, idx) => visit(item, [...keyPath, String(idx)], globs, hint, null));
      return;
    }
    if (node && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      let localGlobs = globs;
      let localHint = hint;
      for (const [key, value] of entries) {
        const lower = key.toLowerCase();
        if (JSON_GLOB_KEYS.has(lower)) {
          const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? value.split(",") : [];
          const cleaned = list.map((g) => g.trim()).filter(Boolean);
          if (cleaned.length) localGlobs = cleaned;
        } else if (JSON_CATEGORY_KEYS.has(lower)) {
          const v = Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : "";
          if (v) localHint = `${localHint} ${v}`.trim();
        }
      }
      for (const [key, value] of entries) {
        const lower = key.toLowerCase();
        if (JSON_GLOB_KEYS.has(lower) || JSON_CATEGORY_KEYS.has(lower) || JSON_META_KEYS.has(lower)) continue;
        visit(value, [...keyPath, key], localGlobs, localHint, key);
      }
    }
  };

  visit(parsed, [], [], "", null);
  return out;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface SourceCandidate {
  relPath: string;
  kind: RuleSourceKind;
  strict: boolean;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function formatFor(relPath: string): RuleSource["format"] {
  const ext = path.posix.extname(relPath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".md" || ext === ".mdc" || ext === ".markdown") return "markdown";
  return "text";
}

async function globFiles(repoRoot: string, patterns: string | string[]): Promise<string[]> {
  return fg(patterns, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    caseSensitiveMatch: false,
    suppressErrors: true,
    ignore: GLOB_IGNORE,
    deep: 12,
  });
}

async function autoDiscover(repoRoot: string): Promise<SourceCandidate[]> {
  const seen = new Map<string, SourceCandidate>();
  for (const { pattern, kind, strict } of DISCOVERY_PATTERNS) {
    const matches = (await globFiles(repoRoot, pattern)).sort();
    for (const match of matches) {
      const key = match.toLowerCase();
      if (!seen.has(key)) seen.set(key, { relPath: match, kind, strict: strict ?? false });
    }
  }
  return [...seen.values()];
}

const POINTER_LINE = /\b(follow|adhere|comply|guidelines?|rules?|standards?|conventions?|style guides?)\b/i;
const POINTER_PATH = /`([^`\s]+)`|(?:^|[\s(])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+\/?)/g;
const POINTER_TARGET = /(^|\/)\.?[\w-]*(guidelines?|rules?|standards?|conventions?|steering|style-?guides?)[\w-]*(\/|\.mdc?$|$)/i;
const MAX_POINTER_FILES = 50;

/**
 * Rule files often just point elsewhere ("follow the guidelines in `.agent/guidelines/`").
 * Returns the markdown files behind such pointers so their rules are audited too.
 */
async function followPointers(repoRoot: string, sources: SourceCandidate[]): Promise<SourceCandidate[]> {
  const out = new Map<string, SourceCandidate>();
  for (const source of sources) {
    let raw: string;
    try {
      const abs = path.resolve(repoRoot, source.relPath);
      if ((await fs.stat(abs)).size > MAX_RULE_FILE_BYTES) continue;
      raw = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!POINTER_LINE.test(line)) continue;
      for (const match of line.matchAll(POINTER_PATH)) {
        const ref = (match[1] ?? match[2] ?? "").replace(/[.,;:)]+$/, "");
        if (!ref.includes("/") || /^[a-z]+:\/\//i.test(ref) || /[*?]/.test(ref)) continue;
        const abs = path.resolve(repoRoot, ref);
        if (!isInside(repoRoot, abs) || abs === repoRoot) continue;
        if (!POINTER_TARGET.test(toPosix(path.relative(repoRoot, abs)))) continue;
        let files: string[] = [];
        try {
          const stat = await fs.stat(abs);
          const rel = toPosix(path.relative(repoRoot, abs));
          if (stat.isDirectory()) files = (await globFiles(repoRoot, `${fg.escapePath(rel)}/**/*.{md,mdc}`)).sort();
          else if (/\.(md|mdc)$/i.test(rel)) files = [rel];
        } catch {
          continue;
        }
        for (const file of files.slice(0, MAX_POINTER_FILES)) {
          const key = file.toLowerCase();
          if (!out.has(key)) out.set(key, { relPath: file, kind: "docs", strict: false });
        }
      }
    }
  }
  return [...out.values()];
}

async function resolveCustomPaths(
  repoRoot: string,
  customRulePaths: string[],
  skipped: SkippedRuleSource[],
): Promise<SourceCandidate[]> {
  const out: SourceCandidate[] = [];
  for (const input of customRulePaths) {
    const trimmed = input.trim();
    if (!trimmed) continue;

    if (fg.isDynamicPattern(trimmed.replace(/\\/g, "/"))) {
      if (path.isAbsolute(trimmed) || trimmed.split(/[\\/]/).includes("..")) {
        skipped.push({ path: trimmed, reason: "glob patterns must be relative to the repository root" });
        continue;
      }
      const matches = await globFiles(repoRoot, trimmed.replace(/\\/g, "/"));
      if (!matches.length) skipped.push({ path: trimmed, reason: "glob matched no files" });
      for (const m of matches) out.push({ relPath: m, kind: "custom", strict: false });
      continue;
    }

    const abs = path.resolve(repoRoot, trimmed);
    if (!isInside(repoRoot, abs)) {
      skipped.push({ path: trimmed, reason: "outside the repository root (refused)" });
      continue;
    }
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        const rel = toPosix(path.relative(repoRoot, abs));
        const matches = await globFiles(repoRoot, `${fg.escapePath(rel)}/**/*.{md,mdc,txt,json}`);
        if (!matches.length) skipped.push({ path: trimmed, reason: "directory contains no .md/.mdc/.txt/.json files" });
        for (const m of matches) out.push({ relPath: m, kind: "custom", strict: false });
      } else if (stat.isFile()) {
        out.push({ relPath: toPosix(path.relative(repoRoot, abs)), kind: "custom", strict: false });
      }
    } catch {
      skipped.push({ path: trimmed, reason: "not found" });
    }
  }
  return out;
}

/**
 * Removes auto-discovered files that git ignores (virtualenvs, vendored
 * packages, build output), so third-party AGENTS.md / CLAUDE.md files are
 * never mistaken for the repository's own rules.
 */
async function dropGitIgnored(
  repoRoot: string,
  candidates: SourceCandidate[],
  skipped: SkippedRuleSource[],
): Promise<SourceCandidate[]> {
  if (!candidates.length) return candidates;
  let ignored: Set<string>;
  try {
    // Exit code 1 means "none of the paths are ignored".
    const out = await runGit(repoRoot, ["check-ignore", "-z", "--stdin"], {
      input: `${candidates.map((c) => c.relPath).join("\0")}\0`,
      okExitCodes: [0, 1],
    });
    ignored = new Set(out.split("\0").filter(Boolean));
  } catch (error) {
    logger.warn(`git check-ignore failed, keeping all rule candidates: ${(error as Error).message}`);
    return candidates;
  }
  return candidates.filter((c) => {
    if (!ignored.has(c.relPath)) return true;
    skipped.push({ path: c.relPath, reason: "ignored by .gitignore" });
    return false;
  });
}

/** Glob scope for directory-nested agent files, e.g. "packages/web/AGENTS.md" -> "packages/web/**". */
function nestedScope(relPath: string, kind: RuleSourceKind): string[] {
  if (kind !== "agents" && kind !== "claude") return [];
  if (!/^(agents|claude)\.md$/i.test(path.posix.basename(relPath))) return [];
  const dir = path.posix.dirname(relPath);
  return dir === "." ? [] : [`${dir}/**`];
}

/** Parses one source file into a RuleSource plus raw candidates, or a skip reason. */
async function parseSource(
  repoRoot: string,
  candidate: SourceCandidate,
): Promise<{ source: RuleSource; candidates: Candidate[] } | { skipped: string }> {
  const abs = path.resolve(repoRoot, candidate.relPath);
  if (!isInside(repoRoot, abs)) return { skipped: "outside the repository root" };

  const stat = await fs.stat(abs);
  if (stat.size > MAX_RULE_FILE_BYTES) return { skipped: `larger than ${MAX_RULE_FILE_BYTES} bytes` };
  if (stat.size === 0) return { skipped: "empty file" };

  const raw = await fs.readFile(abs, "utf8");
  const format = formatFor(candidate.relPath);
  const source: RuleSource = {
    path: candidate.relPath,
    kind: candidate.kind,
    format,
    appliesTo: nestedScope(candidate.relPath, candidate.kind),
    alwaysApply: false,
    languages: [],
    ruleCount: 0,
  };

  if (format === "json") {
    try {
      return { source, candidates: extractJsonRules(raw) };
    } catch (error) {
      return { skipped: `invalid JSON: ${(error as Error).message}` };
    }
  }

  const { data, body, lineOffset } = parseFrontmatter(raw);

  // Kiro: inclusion always | fileMatch | manual | auto
  const inclusion = typeof data.inclusion === "string" ? data.inclusion.toLowerCase() : "";
  if (inclusion === "manual") return { skipped: "Kiro steering with inclusion: manual" };
  // Windsurf: trigger always_on | manual | model_decision | glob
  const trigger = typeof data.trigger === "string" ? data.trigger.toLowerCase() : "";
  if (trigger === "manual") return { skipped: "Windsurf rule with trigger: manual" };

  const globs = [
    ...toGlobList(data.globs),
    ...toGlobList(data.applyTo),
    ...toGlobList(data.fileMatchPattern),
  ];
  if (globs.length) source.appliesTo = globs;
  source.alwaysApply = data.alwaysApply === true || inclusion === "always" || trigger === "always_on";

  const hint = typeof data.description === "string" ? data.description : "";
  if (candidate.kind !== "custom") {
    const workflow = workflowReason(candidate.relPath, hint, body);
    if (workflow) return { skipped: workflow };
  }
  source.languages = sourceLanguages(candidate.relPath, hint, body);
  const candidates = extractMarkdownRules(body, lineOffset, candidate.strict).map((c) => ({ ...c, hint }));
  return { source, candidates };
}

const WORKFLOW_FILENAME = /(^|[-_.\s])(review|reviews|pr|prs|pull[-_]?request|commit|commits|gitcommit|comments?|changelog|release|releases)([-_.\s]|$)/i;
const WORKFLOW_DESCRIPTION = /\b(workflow|when making commits|commit messages?|pull requests?|pr reviews?|review comments?|code reviews?)\b/i;

/**
 * Procedure files (PR review playbooks, commit conventions, "Step 1: run gh ...")
 * describe how an agent should *act*, not properties the code must have. Their
 * steps are not auditable against a diff, so they are skipped.
 */
/** File name without extension; a SKILL.md is identified by its folder instead. */
function sourceStem(relPath: string): string {
  const base = path.posix.basename(relPath);
  const name = /^skill\.md$/i.test(base) ? path.posix.basename(path.posix.dirname(relPath)) : base;
  return name.replace(/\.(md|mdc|txt)$/i, "");
}

function workflowReason(relPath: string, description: string, body: string): string | undefined {
  const stepHeadings = (body.match(/^#{1,6}\s*step\s*\d+/gim) ?? []).length;
  if (stepHeadings >= 2) return `workflow/procedure file (${stepHeadings} "Step N" sections), not code rules`;
  const stem = sourceStem(relPath);
  if (WORKFLOW_FILENAME.test(stem)) return "workflow/procedure file (by name), not code rules";
  if (WORKFLOW_DESCRIPTION.test(description)) return "workflow/procedure file (by description), not code rules";
  return undefined;
}

/**
 * Languages a whole rule file targets, from its file name ("python.md"), its
 * description, or its title ("# Guidelines for TypeScript Code Quality").
 * Rules without their own language mention inherit these.
 */
function sourceLanguages(relPath: string, description: string, body: string): string[] {
  const stem = sourceStem(relPath).replace(/[-_.]+/g, " ");
  const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? "";
  const generic = /^(agents|claude|copilot instructions|cursorrules|clinerules|windsurfrules|readme|contributing|architecture)$/i;
  const probe = [generic.test(stem.trim()) ? "" : stem, description, title].join(" \n ");
  return LANGUAGE_SIGNALS.filter(([, regex]) => regex.test(probe)).map(([lang]) => lang);
}

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Discovers steering files in the repository (plus any custom paths) and
 * returns atomic, classified rules with stable ids.
 */
export async function discoverRules(repoRoot: string, customRulePaths: string[] = []): Promise<RuleDiscoveryResult> {
  const skipped: SkippedRuleSource[] = [];
  const warnings: string[] = [];

  const custom = await resolveCustomPaths(repoRoot, customRulePaths, skipped);
  const found = await autoDiscover(repoRoot);
  const pointed = await followPointers(repoRoot, [...custom, ...found]);
  const auto = await dropGitIgnored(repoRoot, [...found, ...pointed], skipped);

  // Custom paths first so they take priority; dedupe by path.
  const ordered: SourceCandidate[] = [];
  const seen = new Set<string>();
  for (const c of [...custom, ...auto]) {
    const key = c.relPath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(c);
  }

  const sources: RuleSource[] = [];
  const rules: Rule[] = [];
  const dedupe = new Set<string>();
  let truncated = false;

  for (const candidate of ordered) {
    let parsed;
    try {
      parsed = await parseSource(repoRoot, candidate);
    } catch (error) {
      skipped.push({ path: candidate.relPath, reason: `read error: ${(error as Error).message}` });
      continue;
    }
    if ("skipped" in parsed) {
      skipped.push({ path: candidate.relPath, reason: parsed.skipped });
      continue;
    }

    const { source, candidates } = parsed;
    for (const c of candidates) {
      if (rules.length >= MAX_RULES_TOTAL) {
        truncated = true;
        break;
      }
      const appliesTo = c.appliesTo ?? source.appliesTo;
      const text = c.text.length > MAX_RULE_TEXT ? `${c.text.slice(0, MAX_RULE_TEXT - 1)}…` : c.text;
      const cls = classifyRule(text, c.section, source.path, c.hint);
      // A language-specific file (python.md) is authoritative: a PyO3 note inside rust.md that
      // mentions Python is still a Rust-project rule, not a rule for every .py file.
      const languages = source.languages.length ? source.languages : cls.languages;

      // Identical bullets in python.md and javascript.md are different rules: they target
      // different files. Scope (globs + languages) is part of the identity.
      const scopeKey = `${normalizeForDedupe(c.text)}|${appliesTo.join(",")}|`;
      const key = `${scopeKey}${languages.join(",")}`;
      // ...but if the same rule already exists for every language, a narrower copy adds nothing.
      if (dedupe.has(key) || dedupe.has(scopeKey)) continue;
      dedupe.add(key);
      rules.push({
        id: `R${rules.length + 1}`,
        text,
        sourceFile: source.path,
        sourceKind: source.kind,
        sourceLine: c.line,
        section: c.section,
        category: cls.category,
        tags: cls.tags,
        languages,
        appliesTo,
      });
      source.ruleCount += 1;
    }
    if (source.ruleCount === 0) {
      skipped.push({ path: source.path, reason: "no actionable rules extracted" });
    } else {
      sources.push(source);
    }
    if (truncated) break;
  }

  if (truncated) {
    warnings.push(`Rule extraction stopped at ${MAX_RULES_TOTAL} rules; remaining sources were not parsed.`);
  }
  logger.debug(`Discovered ${rules.length} rules from ${sources.length} sources (${skipped.length} skipped).`);
  return { sources, rules, skipped, warnings };
}

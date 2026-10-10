/**
 * Rule-to-file relevance matcher.
 *
 * Every changed file gets a profile (language + domains derived from its
 * extension, path and the content of its added lines). A rule is associated
 * with a file only when:
 *   1. the rule carries explicit globs and the file matches one of them, or
 *   2. the rule has no globs, is compatible with the file's language, and its
 *      category is relevant to the file's domains.
 * Everything else is excluded so the host LLM only sees rules that matter.
 */
import path from "node:path";
import picomatch from "picomatch";
import type {
  ChangedFile,
  FileProfile,
  FileRuleMapping,
  MatchResult,
  Rule,
  RuleCategory,
  RuleMatch,
} from "./types.js";

const MAX_RULES_PER_FILE = Number.parseInt(process.env.MCP_REPO_AUDITOR_MAX_RULES_PER_FILE ?? "", 10) || 80;

// ---------------------------------------------------------------------------
// File profiling
// ---------------------------------------------------------------------------

const EXT_LANGUAGE: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin", ".kts": "kotlin",
  ".cs": "csharp",
  ".rb": "ruby", ".erb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".scala": "scala", ".sc": "scala", ".sbt": "scala",
  ".c": "cpp", ".h": "cpp", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  ".ex": "elixir", ".exs": "elixir",
  ".dart": "dart",
  ".vue": "javascript", ".svelte": "javascript", ".astro": "javascript",
};

/** Which rule languages are compatible with a file language. */
const LANGUAGE_COMPAT: Record<string, string[]> = {
  typescript: ["typescript", "javascript"],
  javascript: ["javascript", "typescript"],
};

const CODE_EXT = new Set([
  ...Object.keys(EXT_LANGUAGE),
  ".c", ".h", ".cpp", ".cc", ".hpp", ".m", ".mm", ".scala", ".clj", ".ex", ".exs", ".erl", ".dart",
  ".lua", ".r", ".jl", ".sh", ".bash", ".zsh", ".ps1", ".sql", ".prisma", ".graphql", ".gql",
  ".css", ".scss", ".sass", ".less", ".html", ".htm", ".proto", ".tf", ".hcl",
]);
const DOC_EXT = new Set([".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"]);
const UI_EXT = new Set([".tsx", ".jsx", ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less", ".html", ".htm"]);

const UI_PATH = /\/(components?|pages|views?|ui|frontend|client|screens|layouts?|styles?|hooks|widgets|templates)\//;
const UI_FILE = /(^|\/)use[A-Z][A-Za-z0-9]*\.(t|j)sx?$/;

const API_PATH = /\/(api|apis|routes?|routers?|controllers?|handlers?|endpoints?|server|backend|middlewares?|services?|resolvers?|graphql|rpc|trpc|lambdas?|functions|webhooks?)\//;
const API_FILE = /(\.(controller|route|routes|router|handler|resolver|service|middleware|api)\.[a-z]+$)|((^|\/)(server|route)\.(ts|js|mjs|cjs|py|go)$)/;

const DB_EXT = new Set([".sql", ".prisma"]);
const DB_PATH = /\/(db|database|models?|migrations?|prisma|schemas?|repositor(y|ies)|entities|dao|seeds?|drizzle|alembic)\//;
const DB_FILE = /\.(model|entity|repository|repo|schema|migration|dao|query|queries)\.[a-z]+$/;

const TEST_PATH = /\/(__tests__|__mocks__|tests?|e2e|cypress|playwright|specs?)\//;
const TEST_FILE = /(\.(test|spec|e2e|cy)\.[a-z0-9]+$)|(_(test|spec)\.[a-z0-9]+$)|((^|\/)test_[^/]+\.py$)|((Tests?|Spec|Suite|IT)\.(java|kt|cs|scala|swift)$)/;

const INFRA_PATH = /\/(\.github\/workflows|\.circleci|\.gitlab|k8s|kubernetes|helm|charts|terraform|infra|infrastructure|deploy|deployment|ops|ansible|docker)\//;
const INFRA_FILE = /(^|\/)(dockerfile[^/]*|docker-compose[^/]*|compose\.ya?ml|\.gitlab-ci\.yml|jenkinsfile|procfile|vercel\.json|netlify\.toml|fly\.toml|serverless\.ya?ml|skaffold\.ya?ml)$/i;
const INFRA_EXT = new Set([".tf", ".tfvars", ".hcl"]);

const DOC_PATH = /\/docs?\//;

const JS_FAMILY = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".astro"]);

/** Signals in ADDED lines that pull in a domain regardless of the file's location. */
const CONTENT_SIGNALS: Array<[RuleCategory, RegExp[]]> = [
  ["Backend/DB", [
    /\b(SELECT\s+[\s\S]{1,200}?\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX)|ALTER\s+TABLE)\b/i,
    /\.(query|execute|raw|queryRaw|executeRaw|findMany|findUnique|findFirst|findOne|insertOne|insertMany|updateOne|aggregate)\s*\(/,
    /\b(prisma|knex|sequelize|mongoose|drizzle|typeorm|sqlalchemy|createPool|createConnection)\b/,
  ]],
  ["Backend/API", [
    /\b(app|router|server|api)\.(get|post|put|patch|delete|use|route|all)\s*\(/,
    /\b(req|request)\.(body|params|query|headers|cookies)\b/,
    /\bres\.(json|status|send|sendStatus|redirect)\s*\(/,
    /@(Get|Post|Put|Patch|Delete|Controller|RestController|RequestMapping)\b/,
    /@(app|router|bp)\.(get|post|put|patch|delete|route)\b/,
    /\bexport\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|\bNextResponse\b/,
  ]],
  ["UI/React", [
    /\bclassName=|\b(useState|useEffect|useMemo|useCallback|useRef|useContext|useReducer)\s*\(/,
    /<\/?[A-Z][A-Za-z0-9]*(\s[^>]*)?\/?>/,
  ]],
  ["Testing", [
    /\b(describe|it|test)\s*\(\s*['"`]/,
    /\bexpect\s*\(|\bassert\w*\s*\(/,
  ]],
];

export function profileFile(filePath: string, addedText = ""): FileProfile {
  const posix = filePath.replace(/\\/g, "/");
  const ext = path.posix.extname(posix).toLowerCase();
  const slashed = `/${posix}`;
  const lowered = slashed.toLowerCase();
  const domains = new Set<RuleCategory>();

  if (UI_EXT.has(ext) || (CODE_EXT.has(ext) && UI_PATH.test(lowered)) || UI_FILE.test(posix)) domains.add("UI/React");
  if (CODE_EXT.has(ext) && (API_PATH.test(lowered) || API_FILE.test(lowered))) domains.add("Backend/API");
  if (DB_EXT.has(ext) || (CODE_EXT.has(ext) && (DB_PATH.test(lowered) || DB_FILE.test(lowered)))) domains.add("Backend/DB");
  if (TEST_FILE.test(posix) || TEST_PATH.test(lowered)) domains.add("Testing");
  if (INFRA_EXT.has(ext) || INFRA_FILE.test(posix) || INFRA_PATH.test(lowered)) domains.add("Infra/DevOps");
  if (DOC_EXT.has(ext) || (DOC_PATH.test(lowered) && !CODE_EXT.has(ext))) domains.add("Documentation");

  // Content sniffing: a handler in utils/ that builds SQL still deserves DB rules.
  const contentDomains: RuleCategory[] = [];
  if (CODE_EXT.has(ext) && addedText) {
    for (const [category, signals] of CONTENT_SIGNALS) {
      if (category === "UI/React" && !JS_FAMILY.has(ext)) continue;
      if (!domains.has(category) && signals.some((re) => re.test(addedText))) {
        domains.add(category);
        contentDomains.push(category);
      }
    }
  }

  return {
    path: posix,
    extension: ext,
    language: EXT_LANGUAGE[ext],
    domains: [...domains],
    contentDomains,
    isCode: CODE_EXT.has(ext),
    isDoc: DOC_EXT.has(ext),
  };
}

function addedTextOf(file: ChangedFile): string {
  const parts: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) if (line.type === "add") parts.push(line.content);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

const globCache = new Map<string, (p: string) => boolean>();

function globMatcher(glob: string): (p: string) => boolean {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let normalized = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/")) normalized = normalized.slice(1);
  // Patterns without a slash ("*.tsx") match against the basename, like .gitignore.
  const basenameOnly = !normalized.includes("/");
  let matcher: (p: string) => boolean;
  try {
    const isMatch = picomatch(normalized, { dot: true, basename: basenameOnly, nocase: false });
    matcher = (p) => isMatch(p);
  } catch {
    matcher = () => false;
  }
  globCache.set(glob, matcher);
  return matcher;
}

function matchingGlob(globs: string[], filePath: string): string | undefined {
  return globs.find((g) => globMatcher(g)(filePath));
}

// ---------------------------------------------------------------------------
// Relevance
// ---------------------------------------------------------------------------

function languageCompatible(fileLanguage: string | undefined, ruleLanguages: string[]): boolean {
  if (ruleLanguages.length === 0) return true;
  if (!fileLanguage) return false;
  const accepted = LANGUAGE_COMPAT[fileLanguage] ?? [fileLanguage];
  return ruleLanguages.some((lang) => accepted.includes(lang));
}

const CODE_DOC_RULE = /\b(jsdoc|tsdoc|docstrings?|comments?|commenting|document (all |every |public |exported )?(functions?|methods?|apis?|classes?))\b/i;

/** Returns the reason a rule applies to a file, or undefined if it does not. */
export function ruleAppliesTo(rule: Rule, profile: FileProfile): string | undefined {
  if (rule.appliesTo.length) {
    const glob = matchingGlob(rule.appliesTo, profile.path);
    return glob ? `glob ${glob}` : undefined;
  }

  if (!languageCompatible(profile.language, rule.languages)) return undefined;

  switch (rule.category) {
    case "General/Security":
      return "security (all files)";
    case "General/Style":
    case "General":
      return profile.isCode ? (rule.category === "General" ? "general (source file)" : "style (source file)") : undefined;
    case "Documentation":
      if (profile.isDoc) return "docs (doc file)";
      if (profile.isCode && CODE_DOC_RULE.test(rule.text)) return "code docs (source file)";
      return undefined;
    default:
      if (profile.contentDomains.includes(rule.category)) return `content ${rule.category}`;
      return profile.domains.includes(rule.category) ? `domain ${rule.category}` : undefined;
  }
}

/** Lower is more important; used when a file exceeds the per-file rule budget. */
function priority(rule: Rule, reason: string): number {
  if (reason.startsWith("glob")) return 0;
  if (rule.category === "General/Security") return 1;
  if (reason.startsWith("domain") || reason.startsWith("content")) return 2;
  if (rule.category === "Documentation") return 4;
  return 3;
}

export function matchRulesToFiles(files: ChangedFile[], rules: Rule[], warnings: string[] = []): MatchResult {
  const mappings: FileRuleMapping[] = [];
  const relevantRuleIds = new Set<string>();

  for (const file of files) {
    if (file.skippedReason || file.hunks.length === 0) continue;
    const profile = profileFile(file.path, addedTextOf(file));

    let matches: Array<RuleMatch & { order: number; prio: number }> = [];
    rules.forEach((rule, order) => {
      const reason = ruleAppliesTo(rule, profile);
      if (reason) matches.push({ ruleId: rule.id, reason, order, prio: priority(rule, reason) });
    });

    if (matches.length > MAX_RULES_PER_FILE) {
      warnings.push(
        `${file.path}: ${matches.length} relevant rules, kept the ${MAX_RULES_PER_FILE} highest-priority (MCP_REPO_AUDITOR_MAX_RULES_PER_FILE).`,
      );
      matches = matches
        .sort((a, b) => a.prio - b.prio || a.order - b.order)
        .slice(0, MAX_RULES_PER_FILE)
        .sort((a, b) => a.order - b.order);
    }

    for (const m of matches) relevantRuleIds.add(m.ruleId);
    mappings.push({
      file: file.path,
      status: file.status,
      domains: profile.domains,
      language: profile.language,
      rules: matches.map(({ ruleId, reason }) => ({ ruleId, reason })),
    });
  }

  return { mappings, relevantRuleIds };
}

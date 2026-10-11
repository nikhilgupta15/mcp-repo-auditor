/** Unit tests for the pure parsing helpers, run against the built files. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMarkdownRules, splitList } from "../dist/rules.js";

test("splitList keeps commas inside braces, brackets and quotes", () => {
  assert.deepEqual(splitList("**/*.{ts,tsx}"), ["**/*.{ts,tsx}"]);
  assert.deepEqual(splitList("src/**/*.ts, src/**/*.tsx").map((s) => s.trim()), ["src/**/*.ts", "src/**/*.tsx"]);
  assert.deepEqual(splitList('"a/{b,c}/*.js", lib/[x,y].ts').map((s) => s.trim()), ['"a/{b,c}/*.js"', "lib/[x,y].ts"]);
  assert.deepEqual(splitList(""), [""]);
});

const texts = (markdown) => extractMarkdownRules(markdown, 0, false).map((c) => c.text);

test("reference notes in a CLAUDE.md are not extracted as rules", () => {
  const markdown = [
    "# CLAUDE.md",
    "",
    "This file provides guidance to Claude Code when working with code in this repository.",
    "",
    "## Commands",
    "",
    "- `npm run build` - compile TypeScript to dist/",
    "- `npm test` - run the vitest suite",
    "- Always run `npm run lint` before committing.",
    "",
    "## Architecture",
    "",
    "- `src/api/` holds the Express route handlers",
    "- The server entry point is `src/index.ts`",
    "- All database access goes through the repository layer.",
    "",
    "## Code style",
    "",
    "- Never use `any`; prefer `unknown` and narrow it.",
    "- Named exports only.",
    "- `console.log` is not allowed in committed code.",
    "- `any` casts need a comment explaining them.",
    "- Functions stay under 50 lines.",
  ].join("\n");
  assert.deepEqual(texts(markdown), [
    "Always run `npm run lint` before committing.",
    "All database access goes through the repository layer.",
    "Never use `any`; prefer `unknown` and narrow it.",
    "Named exports only.",
    "`console.log` is not allowed in committed code.",
    "`any` casts need a comment explaining them.",
    "Functions stay under 50 lines.",
  ]);
});

test("a descriptive heading that also says 'rules' keeps its bullets", () => {
  const markdown = ["## Architecture rules", "", "- Handlers call services; services call repositories.", "", "## Project structure", "", "### Conventions", "", "- One component per file."].join("\n");
  assert.deepEqual(texts(markdown), ["Handlers call services; services call repositories.", "One component per file."]);
});

test("a directive word inside a code span does not make a reference note a rule", () => {
  assert.deepEqual(texts("- `use-client.ts` - marks the client boundary\n- `make all` - build everything\n"), []);
});

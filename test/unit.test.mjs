/** Unit tests for the pure parsing helpers, run against the built files. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitList } from "../dist/rules.js";

test("splitList keeps commas inside braces, brackets and quotes", () => {
  assert.deepEqual(splitList("**/*.{ts,tsx}"), ["**/*.{ts,tsx}"]);
  assert.deepEqual(splitList("src/**/*.ts, src/**/*.tsx").map((s) => s.trim()), ["src/**/*.ts", "src/**/*.tsx"]);
  assert.deepEqual(splitList('"a/{b,c}/*.js", lib/[x,y].ts').map((s) => s.trim()), ['"a/{b,c}/*.js"', "lib/[x,y].ts"]);
  assert.deepEqual(splitList(""), [""]);
});

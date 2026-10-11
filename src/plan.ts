/**
 * Splits a change into parts that each fit in one tool result.
 *
 * MCP clients cap how much a tool may return, so a large change cannot be
 * handed over in one piece. Nothing is cut: the diff is divided in path
 * order, and a file too big for one part continues in the next with its line
 * numbers intact. Every changed line belongs to exactly one part.
 */
import type { ChangedFile, DiffHunk, DiffLine, FileRuleMapping, Rule } from "./types.js";

/** A single line longer than this (minified code, embedded data) is shortened in the result. */
export const MAX_LINE_CHARS = 2_000;
/** The diff of a part always gets at least this much room, however many rules apply. */
const MIN_DIFF_CHARS = 12_000;

const HUNK_COST = 80;
const FILE_COST = 260;

/** The lines of one file that belong to one part. */
export interface PartSlice {
  file: ChangedFile;
  hunks: DiffHunk[];
  /** Diff lines (added, deleted and context) in this slice. */
  lines: number;
  added: number;
  /** First and last new-file line number shown; 0 when the slice has only deletions. */
  firstLine: number;
  lastLine: number;
  /** True when the file's change is spread over more than one part. */
  partial: boolean;
}

export interface AuditPart {
  number: number;
  slices: PartSlice[];
  /** Ids of the rules mapped to this part's files, in rule order. */
  ruleIds: string[];
  lines: number;
  added: number;
  /** Estimated size of this part's tool result, in characters. */
  chars: number;
}

/** Approximate size of one diff line in the JSON result: escaped content plus its "+ 123 | " annotation. */
function lineCost(line: DiffLine): number {
  return JSON.stringify(line.content.slice(0, MAX_LINE_CHARS)).length + 14;
}

function ruleCost(rule: Rule): number {
  return rule.text.length + rule.sourceFile.length + (rule.section?.length ?? 0) + 160;
}

function mappingCost(mapping: FileRuleMapping | undefined): number {
  return mapping ? 140 + mapping.file.length + mapping.rules.length * 16 : 0;
}

/**
 * Divides `files` (already filtered to the auditable ones) into parts whose
 * estimated result size stays within `budget`. `baseCost` is the size of what
 * every result carries regardless of content (prompt, meta).
 */
export function splitIntoParts(
  files: ChangedFile[],
  mappings: Map<string, FileRuleMapping>,
  rules: Map<string, Rule>,
  budget: number,
  baseCost: number,
): AuditPart[] {
  interface Draft {
    slices: PartSlice[];
    ruleIds: Set<string>;
    fixed: number;
    diff: number;
    lines: number;
  }
  const newDraft = (): Draft => ({ slices: [], ruleIds: new Set(), fixed: 0, diff: 0, lines: 0 });
  const drafts: Draft[] = [];
  let current = newDraft();

  const room = (draft: Draft, extraFixed = 0) =>
    Math.max(MIN_DIFF_CHARS, budget - baseCost - draft.fixed - extraFixed) - draft.diff;
  const closePart = () => {
    drafts.push(current);
    current = newDraft();
  };

  for (const file of files) {
    const mapping = mappings.get(file.path);
    const ruleIds = mapping?.rules.map((r) => r.ruleId) ?? [];
    /** What adding this file to `draft` costs besides its lines: its entry, its mapping, and any rule not yet in the part. */
    const fileFixed = (draft: Draft) =>
      FILE_COST +
      file.path.length +
      mappingCost(mapping) +
      ruleIds.reduce((sum, id) => sum + (draft.ruleIds.has(id) ? 0 : ruleCost(rules.get(id) as Rule)), 0);

    let slice: PartSlice | null = null;
    const openSlice = () => {
      current.fixed += fileFixed(current);
      for (const id of ruleIds) current.ruleIds.add(id);
      slice = { file, hunks: [], lines: 0, added: 0, firstLine: 0, lastLine: 0, partial: false };
      current.slices.push(slice);
    };

    for (const hunk of file.hunks) {
      let piece: DiffHunk | null = null;
      for (const line of hunk.lines) {
        let cost = lineCost(line) + (piece ? 0 : HUNK_COST);
        if (!slice) {
          // Start the file in a new part when this one cannot take even its first line.
          if (current.lines > 0 && room(current, fileFixed(current)) < cost) closePart();
          openSlice();
        } else if (room(current) < cost) {
          // This part is full: the file continues in the next one.
          closePart();
          openSlice();
          if (piece) cost += HUNK_COST;
          piece = null;
        }
        const target = slice as unknown as PartSlice;
        if (!piece) {
          piece = { ...hunk, lines: [] };
          target.hunks.push(piece);
        }
        piece.lines.push(line);
        current.diff += cost;
        current.lines += 1;
        target.lines += 1;
        if (line.type === "add") target.added += 1;
        if (line.newLineNumber !== undefined && line.type !== "del") {
          if (!target.firstLine) target.firstLine = line.newLineNumber;
          target.lastLine = line.newLineNumber;
        }
      }
    }
  }
  if (current.lines > 0) closePart();

  const sliceCount = new Map<string, number>();
  for (const draft of drafts) for (const s of draft.slices) sliceCount.set(s.file.path, (sliceCount.get(s.file.path) ?? 0) + 1);

  const ruleOrder = [...rules.keys()];
  return drafts.map((draft, index) => {
    for (const s of draft.slices) s.partial = (sliceCount.get(s.file.path) ?? 0) > 1;
    return {
      number: index + 1,
      slices: draft.slices,
      ruleIds: ruleOrder.filter((id) => draft.ruleIds.has(id)),
      lines: draft.lines,
      added: draft.slices.reduce((sum, s) => sum + s.added, 0),
      chars: baseCost + draft.fixed + draft.diff,
    };
  });
}

// A workflow as the CI proposal edits it: jobs, their steps, and where each step's command
// sits on which line. Read line by line, never re-serialised, so an edit leaves the rest of
// the file byte for byte as it was. Pure.

/** Where a step's command text sits: one line, from one column to another. */
export interface CommandLine {
  readonly line: number;
  readonly from: number;
  readonly to: number;
}

export interface Step {
  /** The line holding the step's dash. */
  readonly start: number;
  /** The step's last line of its own, before trailing blanks and the next step's comments. */
  readonly last: number;
  readonly dashIndent: number;
  readonly keyIndent: number;
  /** The command lines of `run:`, inline or a block scalar's; empty for a `uses:` step. */
  readonly run: ReadonlyArray<CommandLine>;
  /** The `env:` key: its line, its children's indent and names; `childIndent` -1 for a flow map. */
  readonly env: {
    readonly line: number;
    readonly childIndent: number;
    readonly names: ReadonlyArray<string>;
  } | null;
  readonly workingDirectory: string | null;
}

export interface Job {
  readonly id: string;
  /** The matrix's keys, or those a computed matrix is read by; null without a matrix. */
  readonly matrix: ReadonlyArray<string> | null;
  readonly steps: ReadonlyArray<Step>;
}

export const indentOf = (line: string) => line.length - line.trimStart().length;

/** A line that holds YAML: neither blank nor a whole-line comment. */
const isContent = (line: string) => {
  const t = line.trim();
  return t !== "" && !t.startsWith("#");
};

const BLOCK = /^(?:[|>][+-]?\d*)?\s*(?:#.*)?$/;
const KEY = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/;

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

/** The first line from `from` holding YAML, before `to`; -1 when there is none. */
const firstContent = (lines: ReadonlyArray<string>, from: number, to: number) => {
  for (let i = from; i < to; i++) if (isContent(lines[i] ?? "")) return i;
  return -1;
};

/** The region a key at `indent` owns: the lines after it until one at or above its indent. */
const blockEnd = (lines: ReadonlyArray<string>, at: number, indent: number, to: number) => {
  let i = at + 1;
  while (i < to) {
    const l = lines[i] ?? "";
    if (isContent(l) && indentOf(l) <= indent) break;
    i++;
  }
  return i;
};

/** An inline scalar's text range: a trailing ` # comment` and the quotes are not command. */
const inlineRange = (line: string, from: number): { from: number; to: number } => {
  let to = line.length;
  const comment = /\s+#/.exec(line.slice(from));
  const value = line.slice(from);
  if (comment && !/^["']/.test(value)) to = from + comment.index;
  while (to > from && /\s/.test(line[to - 1] ?? "")) to--;
  const quote = line[from];
  if ((quote === '"' || quote === "'") && to - from >= 2 && line[to - 1] === quote)
    return { from: from + 1, to: to - 1 };
  return { from, to };
};

const readStep = (lines: ReadonlyArray<string>, start: number, next: number): Step => {
  const dash = lines[start] ?? "";
  const dashIndent = indentOf(dash);
  let last = start;
  for (let i = start + 1; i < next; i++) {
    const l = lines[i] ?? "";
    if (l.trim() !== "" && indentOf(l) > dashIndent) last = i;
  }
  const lead = /^\s*-\s*/.exec(dash)?.[0].length ?? dashIndent + 1;
  const afterDash = firstContent(lines, start + 1, last + 1);
  const keyIndent =
    dash.slice(lead).trim() !== "" || afterDash < 0 ? lead : indentOf(lines[afterDash] ?? "");
  let run: CommandLine[] = [];
  let env: Step["env"] = null;
  let workingDirectory: string | null = null;
  for (let i = start; i <= last; i++) {
    const l = lines[i] ?? "";
    if (i !== start && (!isContent(l) || indentOf(l) !== keyIndent)) continue;
    const key = KEY.exec(l.slice(keyIndent));
    if (!key) continue;
    const value = key[2] ?? "";
    const valueAt = l.length - value.length;
    if (key[1] === "run") {
      if (BLOCK.test(value)) {
        const end = blockEnd(lines, i, keyIndent, last + 1);
        run = [];
        for (let j = i + 1; j < end; j++) {
          const b = lines[j] ?? "";
          if (b.trim() !== "") run.push({ line: j, from: indentOf(b), to: b.trimEnd().length });
        }
      } else run = [{ line: i, ...inlineRange(l, valueAt) }];
    } else if (key[1] === "env") {
      if (!BLOCK.test(value) || /^[|>]/.test(value)) {
        env = { line: i, childIndent: -1, names: [] };
        continue;
      }
      const end = blockEnd(lines, i, keyIndent, last + 1);
      const first = firstContent(lines, i + 1, end);
      const childIndent = first < 0 ? keyIndent + 2 : indentOf(lines[first] ?? "");
      const names: string[] = [];
      for (let j = i + 1; j < end; j++) {
        const c = lines[j] ?? "";
        const name = isContent(c) && indentOf(c) === childIndent ? KEY.exec(c.trim()) : null;
        if (name?.[1]) names.push(name[1]);
      }
      env = { line: i, childIndent, names };
    } else if (key[1] === "working-directory") workingDirectory = unquote(value) || null;
  }
  return { start, last, dashIndent, keyIndent, run, env, workingDirectory };
};

const readSteps = (lines: ReadonlyArray<string>, at: number, to: number): Step[] => {
  const first = firstContent(lines, at + 1, to);
  if (first < 0 || !(lines[first] ?? "").trimStart().startsWith("-")) return [];
  const indent = indentOf(lines[first] ?? "");
  const starts: number[] = [];
  let end = to;
  for (let i = first; i < to; i++) {
    const l = lines[i] ?? "";
    if (!isContent(l)) continue;
    const d = indentOf(l);
    const dash = /^-(\s|$)/.test(l.trimStart());
    if (d < indent || (d === indent && !dash)) {
      end = i;
      break;
    }
    if (d === indent) starts.push(i);
  }
  return starts.map((s, n) => readStep(lines, s, starts[n + 1] ?? end));
};

/** The matrix's keys under `strategy:`, without `include` and `exclude`. */
const readMatrix = (
  lines: ReadonlyArray<string>,
  from: number,
  to: number,
  keyIndent: number,
): ReadonlyArray<string> | null => {
  const strategy = lines.findIndex(
    (l, i) => i >= from && i < to && indentOf(l) === keyIndent && /^strategy:/.test(l.trim()),
  );
  if (strategy < 0) return null;
  const end = blockEnd(lines, strategy, keyIndent, to);
  const at = lines.findIndex((l, i) => i > strategy && i < end && /^matrix:/.test(l.trim()));
  if (at < 0) return null;
  const value = /^matrix:\s*(.*)$/.exec((lines[at] ?? "").trim())?.[1] ?? "";
  // A computed matrix names its keys only where the job reads them.
  if (!BLOCK.test(value)) {
    const used = lines
      .slice(from, to)
      .flatMap((l) => [...l.matchAll(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g)]);
    return [...new Set(used.map((m) => m[1] ?? ""))].filter((k) => k !== "");
  }
  const matrixEnd = blockEnd(lines, at, indentOf(lines[at] ?? ""), end);
  const first = firstContent(lines, at + 1, matrixEnd);
  if (first < 0) return [];
  const childIndent = indentOf(lines[first] ?? "");
  const keys: string[] = [];
  for (let i = first; i < matrixEnd; i++) {
    const l = lines[i] ?? "";
    const key = isContent(l) && indentOf(l) === childIndent ? KEY.exec(l.trim()) : null;
    if (key?.[1] && key[1] !== "include" && key[1] !== "exclude") keys.push(key[1]);
  }
  return keys;
};

/** Every job under the top-level `jobs:` with its matrix keys and steps. */
export const readJobs = (lines: ReadonlyArray<string>): ReadonlyArray<Job> => {
  const at = lines.findIndex((l) => /^jobs:\s*(?:#.*)?$/.test(l));
  if (at < 0) return [];
  const end = blockEnd(lines, at, 0, lines.length);
  const first = firstContent(lines, at + 1, end);
  if (first < 0) return [];
  const jobIndent = indentOf(lines[first] ?? "");
  const starts: Array<{ line: number; id: string }> = [];
  for (let i = first; i < end; i++) {
    const l = lines[i] ?? "";
    if (!isContent(l) || indentOf(l) !== jobIndent) continue;
    const id = /^([^#\s][^:]*?)\s*:\s*(?:#.*)?$/.exec(l.trim())?.[1];
    if (id) starts.push({ line: i, id: unquote(id) });
  }
  return starts.map(({ line, id }, n) => {
    const to = starts[n + 1]?.line ?? end;
    const body = firstContent(lines, line + 1, to);
    const keyIndent = body < 0 ? jobIndent + 2 : indentOf(lines[body] ?? "");
    const stepsAt = lines.findIndex(
      (l, i) =>
        i > line && i < to && indentOf(l) === keyIndent && /^steps:\s*(?:#.*)?$/.test(l.trim()),
    );
    return {
      id,
      matrix: readMatrix(lines, line + 1, to, keyIndent),
      steps: stepsAt < 0 ? [] : readSteps(lines, stepsAt, to),
    };
  });
};

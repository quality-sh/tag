// Line edits on a text file: the edited text, and the unified diff a reviewer reads. Pure.

/** What happens at one line of the original: lines added before it, a new text, lines after. */
export interface LineEdit {
  readonly before: ReadonlyArray<string>;
  readonly replace?: string;
  readonly after: ReadonlyArray<string>;
}

export type LineEdits = ReadonlyMap<number, LineEdit>;

/** The text's lines without their line ends, and whether it uses CRLF and ends in a newline. */
export const splitLines = (text: string) => {
  const raw = text === "" ? [] : text.split("\n");
  const trailing = text.endsWith("\n");
  if (trailing) raw.pop();
  return {
    lines: raw.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)),
    crlf: raw.map((l) => l.endsWith("\r")),
    trailing,
    usesCrlf: text.includes("\r\n"),
  };
};

/** Apply the edits; untouched lines keep their own line ends, added lines take the file's. */
export const applyEdits = (text: string, edits: LineEdits): string => {
  const { lines, crlf, trailing, usesCrlf } = splitLines(text);
  const added = (l: string) => (usesCrlf ? `${l}\r` : l);
  const out: string[] = [];
  lines.forEach((line, i) => {
    const edit = edits.get(i);
    const end = crlf[i] ? "\r" : "";
    out.push(...(edit?.before ?? []).map(added));
    out.push((edit?.replace ?? line) + end);
    out.push(...(edit?.after ?? []).map(added));
  });
  return out.join("\n") + (trailing ? "\n" : "");
};

interface Op {
  readonly kind: " " | "-" | "+";
  readonly text: string;
  /** Original lines consumed before this op, and new lines produced before it. */
  readonly oldAt: number;
  readonly newAt: number;
}

const CONTEXT = 3;

/** A unified diff of the edits, with three lines of context. */
export const unifiedDiff = (path: string, text: string, edits: LineEdits): string => {
  const { lines } = splitLines(text);
  const ops: Op[] = [];
  let oldAt = 0;
  let newAt = 0;
  const push = (kind: Op["kind"], t: string) => {
    ops.push({ kind, text: t, oldAt, newAt });
    if (kind !== "+") oldAt++;
    if (kind !== "-") newAt++;
  };
  lines.forEach((line, i) => {
    const edit = edits.get(i);
    const replaced = edit?.replace !== undefined && edit.replace !== line;
    if (replaced) push("-", line);
    for (const l of edit?.before ?? []) push("+", l);
    push(replaced ? "+" : " ", edit?.replace ?? line);
    for (const l of edit?.after ?? []) push("+", l);
  });
  const changed = ops.flatMap((op, i) => (op.kind === " " ? [] : [i]));
  const hunks: Array<[number, number]> = [];
  for (const i of changed) {
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(ops.length, i + CONTEXT + 1);
    const last = hunks.at(-1);
    if (last && from <= last[1]) last[1] = to;
    else hunks.push([from, to]);
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to);
    const first = slice[0];
    if (first === undefined) continue;
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    const oldStart = oldCount === 0 ? first.oldAt : first.oldAt + 1;
    const newStart = newCount === 0 ? first.newAt : first.newAt + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return out.join("\n") + "\n";
};

/** The diff of a file that did not exist. */
export const createdDiff = (path: string, text: string): string => {
  const { lines } = splitLines(text);
  return (
    [
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
    ].join("\n") + "\n"
  );
};

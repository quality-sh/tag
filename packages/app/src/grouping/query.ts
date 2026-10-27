// The query language: the fields a query can name, the filters it parses into, and
// how filters format back to query text and search-bar chips.
import { Schema } from "effect";

export const FIELDS = [
  "org",
  "repo",
  "branch",
  "commit",
  "tool",
  "workflow",
  "environment",
  "tag",
  "release",
  "pull_request",
  "day",
  "failed",
  "passed",
  "flaky",
  "tests",
  "text",
] as const;
export const Field = Schema.Literals(FIELDS).annotate({ identifier: "Field" });
export type Field = typeof Field.Type;

export const ALIASES: Record<string, Field> = {
  env: "environment",
  pr: "pull_request",
  tags: "tag",
  tool: "tool",
  tools: "tool",
  repository: "repo",
  owner: "org",
  sha: "commit",
};

export const FIELD_INFO: Record<
  Field,
  { readonly label: string; readonly kind: "enum" | "number" | "text"; readonly from: string }
> = {
  org: { label: "org", kind: "enum", from: "the run" },
  repo: { label: "repo", kind: "enum", from: "the run" },
  branch: { label: "branch", kind: "enum", from: "the run" },
  commit: { label: "commit", kind: "text", from: "the run" },
  tool: { label: "tool", kind: "enum", from: "the report" },
  workflow: { label: "workflow", kind: "enum", from: "the run" },
  environment: { label: "environment", kind: "enum", from: "the report" },
  tag: { label: "tag", kind: "enum", from: "the report" },
  release: { label: "release", kind: "enum", from: "GitHub" },
  pull_request: { label: "pull request", kind: "enum", from: "GitHub" },
  day: { label: "day", kind: "enum", from: "the run" },
  failed: { label: "failed", kind: "number", from: "the report" },
  passed: { label: "passed", kind: "number", from: "the report" },
  flaky: { label: "flaky", kind: "number", from: "the report" },
  tests: { label: "tests", kind: "number", from: "the report" },
  text: { label: "text", kind: "text", from: "anywhere" },
};

export const isField = (s: string): s is Field => (FIELDS as ReadonlyArray<string>).includes(s);
export const fieldOf = (s: string): Field | undefined => {
  const k = s.toLowerCase();
  return isField(k) ? k : ALIASES[k];
};

export type Op = "is" | "not" | "in" | "gt" | "lt" | "contains";

export interface Filter {
  readonly field: Field;
  readonly op: Op;
  readonly value: string;
  /** For `in`: the alternatives. */
  readonly values?: ReadonlyArray<string> | undefined;
}

const tokenize = (q: string): string[] => {
  const out: string[] = [];
  const re = /(-?[a-z_]+:)?("([^"]*)"|'([^']*)'|[^\s]+)|"([^"]*)"|'([^']*)'/gi;
  for (const m of q.matchAll(re)) {
    const prefix = m[1] ?? "";
    const value = m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[2] ?? "";
    if (prefix || value) out.push(prefix + value);
  }
  return out;
};

/** `repo:acme/widgets failed:>0 -tag:slow env:staging,production some text` */
export function parseQuery(q: string): Filter[] {
  const filters: Filter[] = [];
  const text: string[] = [];
  for (const tok of tokenize(q)) {
    const m = /^(-?)([a-z_]+):(.*)$/i.exec(tok);
    if (!m) {
      text.push(tok);
      continue;
    }
    const neg = m[1] === "-";
    const field = fieldOf(m[2] ?? "");
    const raw = m[3] ?? "";
    if (!field || raw === "") {
      text.push(tok);
      continue;
    }
    if (
      !neg &&
      (raw.startsWith(">") || raw.startsWith("<")) &&
      FIELD_INFO[field].kind === "number"
    ) {
      filters.push({ field, op: raw.startsWith(">") ? "gt" : "lt", value: raw.slice(1) });
      continue;
    }
    if (!neg && raw.includes(",")) {
      const values = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      filters.push({ field, op: "in", value: raw, values });
      continue;
    }
    filters.push({ field, op: neg ? "not" : field === "commit" ? "contains" : "is", value: raw });
  }
  if (text.length) filters.push({ field: "text", op: "contains", value: text.join(" ") });
  return filters;
}

export const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

export function formatFilter(f: Filter): string {
  if (f.field === "text") return quote(f.value);
  switch (f.op) {
    case "not":
      return `-${f.field}:${quote(f.value)}`;
    case "gt":
      return `${f.field}:>${f.value}`;
    case "lt":
      return `${f.field}:<${f.value}`;
    default:
      return `${f.field}:${quote(f.value)}`;
  }
}

export const formatQuery = (filters: ReadonlyArray<Filter>) => filters.map(formatFilter).join(" ");

/** The chip text: `repo: acme/widgets`, `failed: > 0`, `not tag: slow`. */
export function chipOf(f: Filter): { readonly field: string; readonly value: string } {
  const label = FIELD_INFO[f.field].label;
  switch (f.op) {
    case "not":
      return { field: `not ${label}`, value: f.value };
    case "gt":
      return { field: label, value: `> ${f.value}` };
    case "lt":
      return { field: label, value: `< ${f.value}` };
    case "in":
      return { field: label, value: (f.values ?? []).join(", ") };
    case "contains":
      return f.field === "text"
        ? { field: "text", value: f.value }
        : { field: label, value: `${f.value}…` };
    default:
      return { field: label, value: f.value };
  }
}

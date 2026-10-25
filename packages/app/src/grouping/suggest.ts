// Suggestions for the search bar: what the word being typed can mean — fields,
// their values, or a plain text search.
import { dayOf } from "./match.ts";
import type { ReportLite } from "./report.ts";
import { ALIASES, FIELDS, FIELD_INFO, fieldOf, quote, type Field } from "./query.ts";
import { assign, type Ref } from "./refs.ts";

export interface ValueIndex {
  /** field -> value -> report count */
  readonly values: ReadonlyMap<Field, ReadonlyMap<string, number>>;
}

export function indexValues(
  reports: ReadonlyArray<ReportLite>,
  refs: ReadonlyArray<Ref>,
): ValueIndex {
  const values = new Map<Field, Map<string, number>>();
  const bump = (f: Field, v: string | null) => {
    if (v === null || v === "") return;
    const m = values.get(f) ?? new Map<string, number>();
    m.set(v, (m.get(v) ?? 0) + 1);
    values.set(f, m);
  };
  for (const r of reports) {
    const a = assign(r, refs);
    bump("org", r.owner);
    bump("repo", `${r.owner}/${r.repo}`);
    bump("branch", r.branch);
    bump("tool", r.tool);
    bump("workflow", r.workflow);
    bump("environment", r.environment);
    for (const t of r.tags) bump("tag", t);
    bump("day", dayOf(r.timestamp));
    bump(
      "release",
      a.release === null ? null : a.release === "unreleased" ? "unreleased" : a.release.key,
    );
    bump("pull_request", a.pullRequest?.key ?? null);
  }
  return { values };
}

export interface Suggestion {
  readonly kind: "field" | "value" | "text";
  readonly field: Field | null;
  readonly value: string;
  readonly count: number | null;
  readonly note: string;
  /** What to append to the query when chosen. */
  readonly token: string;
}

/** Suggestions for the word being typed: fields first, then values, then text search. */
export function suggest(index: ValueIndex, typed: string, limit = 8): Suggestion[] {
  const raw = typed.trim();
  if (!raw) return [];
  const out: Suggestion[] = [];
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const field = fieldOf(raw.slice(0, colon));
    const partial = raw.slice(colon + 1).toLowerCase();
    if (field) {
      const vals = [...(index.values.get(field) ?? new Map<string, number>()).entries()]
        .filter(([v]) => v.toLowerCase().includes(partial))
        .sort((a, b) => b[1] - a[1]);
      for (const [v, n] of vals.slice(0, limit))
        out.push({
          kind: "value",
          field,
          value: v,
          count: n,
          note: "",
          token: `${field}:${quote(v)}`,
        });
      if (FIELD_INFO[field].kind === "number" && partial === "") {
        out.push({
          kind: "value",
          field,
          value: "> 0",
          count: null,
          note: "",
          token: `${field}:>0`,
        });
      }
    }
    return out;
  }
  const q = raw.toLowerCase();
  for (const f of FIELDS) {
    if (f === "text") continue;
    const hit =
      f.startsWith(q) ||
      FIELD_INFO[f].label.startsWith(q) ||
      Object.entries(ALIASES).some(([a, t]) => t === f && a.startsWith(q));
    if (!hit) continue;
    const n = index.values.get(f)?.size ?? 0;
    out.push({
      kind: "field",
      field: f,
      value: FIELD_INFO[f].label,
      count: FIELD_INFO[f].kind === "enum" ? n : null,
      note: `from ${FIELD_INFO[f].from}`,
      token: `${f}:`,
    });
  }
  const valueHits: Suggestion[] = [];
  for (const [f, m] of index.values) {
    for (const [v, n] of m) {
      if (v.toLowerCase().includes(q))
        valueHits.push({
          kind: "value",
          field: f,
          value: v,
          count: n,
          note: "",
          token: `${f}:${quote(v)}`,
        });
    }
  }
  valueHits.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  out.push(...valueHits.slice(0, Math.max(0, limit - out.length)));
  out.push({
    kind: "text",
    field: null,
    value: raw,
    count: null,
    note: "search",
    token: quote(raw),
  });
  return out;
}

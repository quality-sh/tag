// Response, query and filter helpers shared by the dashboard API routes.
import { Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  isGroupBy,
  isRange,
  matching,
  parseQuery,
  runsOf,
  type Collection,
  type GroupBy,
  type Range,
  type Ref,
  type ReportLite,
} from "../grouping.ts";
import type { ResultStore } from "./result-store.ts";

export const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status });

export const notFound = (what: string) => json({ error: `${what} not found` }, 404);

export const query = (req: HttpServerRequest.HttpServerRequest) =>
  new URL(req.url, "http://local").searchParams;
export const optional = (v: string | null): string | undefined =>
  v && v.length > 0 ? v : undefined;

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  detail: Schema.String,
}) {}

export const groupByOf = (s: string | null, fallback: GroupBy = "release"): GroupBy =>
  s && isGroupBy(s) ? s : fallback;
export const rangeOf = (s: string | null, fallback: Range = "30d"): Range =>
  s && isRange(s) ? s : fallback;
export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "collection";

/** Each collection with what it holds now: groups, runs and failing groups. */
export const collectionRows = (
  list: ReadonlyArray<Collection>,
  reports: ReadonlyArray<ReportLite>,
  refs: ReadonlyArray<Ref>,
  since: string | undefined,
) =>
  list.map((c) => {
    const filters = parseQuery(c.query);
    const runs = runsOf(matching({ reports, refs, filters, since }).kept);
    return {
      ...c,
      runs: runs.length,
      failing: runs.filter((r) => r.failed > 0).length,
      repos: new Set(runs.map((r) => `${r.owner}/${r.repo}`)).size,
    };
  });

/** The filters a request means: a collection's query (by `c`), then the request's own. */
export const filtersOf = (
  collections: ReadonlyArray<Collection>,
  c: string | null,
  q: string | null,
) => {
  const scope = c ? collections.find((x) => x.id === c) : undefined;
  return [...parseQuery(scope?.query ?? ""), ...parseQuery(q ?? "")];
};

/** owner/repo → the repository's own default branch, from its scan row. */
export const defaultBranchesOf = (scans: ReadonlyArray<ResultStore.ScanRow>) => {
  const out: Record<string, string> = {};
  for (const s of scans) if (s.defaultBranch) out[`${s.owner}/${s.repo}`] = s.defaultBranch;
  return out;
};

export const VIEW_COUNTS = [
  "release",
  "branch",
  "pull_request",
  "environment",
  "tag",
  "tool",
  "workflow",
] as const;

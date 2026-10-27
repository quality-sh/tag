// The read model: overview, groups, a group's page, runs, reports, test history, fields,
// collections and suggestions, computed from the result store. The HTTP API and the MCP
// tools both call this service, so the two transports cannot answer differently.
import { Context, Effect, Layer, Option, Schema } from "effect";
import { artifactsOf } from "@quality-sh/tag-schema";
import {
  computeGroups,
  computeOverview,
  indexValues,
  matching,
  runsOf,
  sinceOf,
  suggest,
  suggestFor,
  type Collection,
  type OrgSuggestion,
  type Ref,
  type ReportLite,
  type Range,
  type RunSummary,
  type Suggestion,
} from "../grouping.ts";
import { ResultStore } from "./result-store.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { collectionRows, defaultBranchesOf, filtersOf, VIEW_COUNTS } from "./http-helpers.ts";
import type {
  CollectionSummary,
  GroupPage,
  GroupParams,
  GroupsParams,
  GroupsView,
  HistoryParams,
  Overview,
  ReportPage,
  RunsParams,
  ScopedRunsParams,
  ViewParams,
} from "./read-schemas.ts";

export class NotFound extends Schema.TaggedError<NotFound>()("Reads.NotFound", {
  what: Schema.String,
}) {}

type Failure = ResultStore.DbError | ArtifactStore.StoreError;

export interface Interface {
  readonly repos: () => Effect.Effect<ReadonlyArray<ResultStore.RepoCount>, Failure>;
  readonly repositories: () => Effect.Effect<ReadonlyArray<ResultStore.RepositoryRow>, Failure>;
  readonly runs: (params: RunsParams) => Effect.Effect<ReadonlyArray<ResultStore.RunRow>, Failure>;
  /** Runs in a view's scope, one summary per CI run, newest first. */
  readonly scopedRuns: (
    params: ScopedRunsParams,
  ) => Effect.Effect<ReadonlyArray<RunSummary>, Failure>;
  readonly overview: (params: ViewParams) => Effect.Effect<Overview, Failure>;
  readonly groups: (params: GroupsParams) => Effect.Effect<GroupsView, Failure>;
  readonly group: (params: GroupParams) => Effect.Effect<GroupPage, Failure | NotFound>;
  /** Search-bar suggestions for the word being typed: fields, then values with counts. */
  readonly fields: (typed: string) => Effect.Effect<ReadonlyArray<Suggestion>, Failure>;
  readonly report: (reportId: string) => Effect.Effect<ReportPage, Failure | NotFound>;
  readonly testHistory: (
    params: HistoryParams,
  ) => Effect.Effect<ReadonlyArray<ResultStore.TestHistoryRow>, Failure>;
  readonly collections: () => Effect.Effect<ReadonlyArray<CollectionSummary>, Failure>;
  /** What TAG suggests saving for an org, or for every org when none is named. */
  readonly suggestions: (
    org: string | null,
  ) => Effect.Effect<ReadonlyArray<OrgSuggestion>, Failure>;
}

export class Service extends Context.Service<Service, Interface>()("@tag/Reads") {}

/** How far back the collection suggestions look at runs; tags are read in full. */
const SUGGESTION_RANGE = "90d";

export const make = (results: ResultStore.Interface): Interface => {
  /** Group counts per view, so the rail can show them without a request per group-by. */
  const countsOf = (
    reports: ReadonlyArray<ReportLite>,
    refs: ReadonlyArray<Ref>,
    since: string | undefined,
    defaultBranches: Record<string, string>,
  ) => ({
    ...Object.fromEntries(
      VIEW_COUNTS.map((g) => [
        g,
        computeGroups({ reports, refs, by: g, filters: [], since, defaultBranches }).length,
      ]),
    ),
    run: runsOf(reports).length,
  });

  const scope = (collections: ReadonlyArray<Collection>, params: ViewParams) =>
    filtersOf(collections, params.c ?? null, params.q ?? null);

  /** The reports in a view's time window: `from` or the range's start, up to `to`. */
  const windowOf = Effect.fn("Reads.windowOf")(function* (params: ViewParams, fallback: Range) {
    const range = params.range ?? fallback;
    const since = params.from ?? sinceOf(range);
    const all = yield* results.reports({ since });
    const { to } = params;
    const reports = to === undefined ? all : all.filter((r) => r.timestamp <= to);
    return { range, since, reports };
  });

  const overview = Effect.fn("Reads.overview")(function* (params: ViewParams) {
    const { range, since, reports: all } = yield* windowOf(params, "30d");
    const refs = yield* results.refs();
    const collections = yield* results.collections();
    const scans = yield* results.scans();
    const branches = defaultBranchesOf(scans);
    const filters = scope(collections, params);
    const reports = filters.length ? matching({ reports: all, refs, filters, since }).kept : all;
    return {
      range,
      query: params.q ?? "",
      repos: computeOverview({ reports, refs, since, defaultBranches: branches }),
      scans: Object.fromEntries(scans.map((s) => [`${s.owner}/${s.repo}`, s])),
      collections: collectionRows(collections, all, refs, since),
      counts: countsOf(reports, refs, since, branches),
      repoList: yield* results.repos(),
    };
  });

  const groups = Effect.fn("Reads.groups")(function* (params: GroupsParams) {
    const by = params.by ?? "release";
    const { range, since, reports } = yield* windowOf(params, "30d");
    const refs = yield* results.refs();
    const collections = yield* results.collections();
    const branches = defaultBranchesOf(yield* results.scans());
    const filters = scope(collections, params);
    const rows = computeGroups({
      reports,
      refs,
      by,
      filters,
      since,
      defaultBranches: branches,
      releaseGroups: yield* results.releaseGroups(),
    });
    const latest = rows.flatMap((g) => (g.latest ? [g.latest] : []));
    const counts = countsOf(reports, refs, since, branches);
    return {
      by,
      range,
      query: params.q ?? "",
      groups: rows,
      totals: {
        runs: runsOf(matching({ reports, refs, filters, since }).kept).length,
        passRate:
          latest.length === 0 ? null : latest.reduce((a, r) => a + r.passRate, 0) / latest.length,
        failingNow: rows.filter((g) => g.verdict === "failed").length,
        flaky: latest.reduce((a, r) => a + r.flaky, 0),
      },
      counts,
      repos: yield* results.repos(),
      collections,
    };
  });

  /** The tests marked flaky across a group's runs, most often first. */
  const flakyOf = Effect.fn("Reads.flakyOf")(function* (runs: ReadonlyArray<RunSummary>) {
    const counted = new Map<string, { name: string; tool: string; n: number }>();
    for (const run of runs)
      for (const id of run.reportIds)
        for (const t of yield* results.testsOf(id)) {
          if (!t.flaky) continue;
          const cur = counted.get(t.testId) ?? { name: t.name, tool: t.tool, n: 0 };
          cur.n++;
          counted.set(t.testId, cur);
        }
    return [...counted]
      .map(([testId, v]) => ({ testId, name: v.name, tool: v.tool, occurrences: v.n }))
      .sort((a, b) => b.occurrences - a.occurrences);
  });

  const group = Effect.fn("Reads.group")(function* (params: GroupParams) {
    const { since, reports } = yield* windowOf(params, "90d");
    const refs = yield* results.refs();
    const filters = scope(yield* results.collections(), params);
    const rows = computeGroups({
      reports,
      refs,
      by: params.by,
      filters,
      since,
      trendPoints: 60,
      defaultBranches: defaultBranchesOf(yield* results.scans()),
    });
    const found = rows.find((g) => g.key === params.key);
    if (!found) return yield* new NotFound({ what: "group" });
    const mine = reports.filter((r) => r.owner === found.owner && r.repo === found.repo);
    const runIds = new Set(found.trend.map((t) => t.runId));
    const runs = runsOf(mine.filter((r) => runIds.has(r.runId)));
    const failing: Array<GroupPage["failing"][number]> = [];
    const errors = new Map<string, number>();
    for (const reportId of found.latest?.reportIds ?? [])
      for (const t of yield* results.testsOf(reportId)) {
        if (t.status !== "failed") continue;
        const { testId, name, suite, tool, message, duration } = t;
        failing.push({ testId, name, suite, tool, reportId, message, duration });
        const head = (message ?? "unknown error").split("\n")[0]?.slice(0, 120) ?? "";
        errors.set(head, (errors.get(head) ?? 0) + 1);
      }
    const neighbours = rows.map((g) => g.key);
    const at = neighbours.indexOf(params.key);
    return {
      group: found,
      runs,
      failing,
      errors: [...errors]
        .map(([message, count]) => ({ message, count }))
        .sort((a, b) => b.count - a.count),
      flaky: yield* flakyOf(runs),
      previous: neighbours[at + 1] ?? null,
      next: at > 0 ? (neighbours[at - 1] ?? null) : null,
    };
  });

  const scopedRuns = Effect.fn("Reads.scopedRuns")(function* (params: ScopedRunsParams) {
    const { since, reports } = yield* windowOf(params, "30d");
    const refs = yield* results.refs();
    const filters = scope(yield* results.collections(), params);
    return runsOf(matching({ reports, refs, filters, since }).kept).slice(0, params.limit ?? 50);
  });

  const report = Effect.fn("Reads.report")(function* (reportId: string) {
    const run = yield* results.getRun(reportId);
    if (Option.isNone(run)) return yield* new NotFound({ what: "report" });
    const { owner, repo, runId } = run.value;
    const stored = yield* results.getReport(reportId);
    const siblings = yield* results.listRuns({ owner, repo, runId, limit: 50 });
    return {
      run: run.value,
      tests: yield* results.testsOf(reportId),
      metrics: yield* results.metricsOf(reportId),
      artifacts: yield* results.artifactsOfRun(owner, repo, runId),
      siblings: siblings.filter((s) => s.reportId !== reportId),
      report: Option.getOrNull(stored),
      artifactRefs: Option.isSome(stored) ? artifactsOf(stored.value) : [],
    };
  });

  const fields = Effect.fn("Reads.fields")(function* (typed: string) {
    const reports = yield* results.reports({});
    const refs = yield* results.refs();
    return suggest(indexValues(reports, refs), typed);
  });

  const collections = Effect.fn("Reads.collections")(function* () {
    const list = yield* results.collections();
    const since = sinceOf("30d");
    const reports = yield* results.reports({ since });
    const refs = yield* results.refs();
    return collectionRows(list, reports, refs, since);
  });

  const suggestions = Effect.fn("Reads.suggestions")(function* (org: string | null) {
    const refs = yield* results.refs();
    const reports = yield* results.reports({ since: sinceOf(SUGGESTION_RANGE) });
    const collections = yield* results.collections();
    const releaseGroups = yield* results.releaseGroups();
    const defaultBranches = defaultBranchesOf(yield* results.scans());
    const dismissed = yield* results.dismissedSuggestions();
    const orgs = org === null ? [...new Set([...refs, ...reports].map((r) => r.owner))] : [org];
    return orgs
      .flatMap((o) =>
        suggestFor({ org: o, refs, reports, defaultBranches, collections, releaseGroups }),
      )
      .filter((s) => !dismissed.has(s.id));
  });

  return {
    repos: () => results.repos(),
    repositories: () => results.repositories(),
    runs: ({ limit, ...filter }) => results.listRuns({ ...filter, limit: limit ?? 100 }),
    scopedRuns,
    overview,
    groups,
    group,
    fields,
    report,
    testHistory: ({ owner, repo, testId, limit }) =>
      results.testHistory(owner, repo, testId, limit ?? 50),
    collections,
    suggestions,
  };
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of(make(yield* ResultStore.Service));
  }),
);

export * as Reads from "./reads.ts";

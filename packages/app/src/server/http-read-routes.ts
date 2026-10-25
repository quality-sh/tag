// The read routes: the overview, the groups and a group's page, runs, reports and fields.
import { Effect, Option } from "effect";
import { HttpRouter } from "effect/http";
import { artifactsOf } from "@quality-sh/tag-schema";
import {
  computeGroups,
  computeOverview,
  indexValues,
  matching,
  runsOf,
  sinceOf,
  suggest,
} from "../grouping.ts";
import { ResultStore } from "./result-store.ts";
import {
  collectionRows,
  defaultBranchesOf,
  filtersOf,
  groupByOf,
  json,
  notFound,
  optional,
  query,
  rangeOf,
  VIEW_COUNTS,
} from "./http-helpers.ts";

export const addReadRoutes = (deps: {
  readonly router: HttpRouter.HttpRouter;
  readonly results: ResultStore.Interface;
}) =>
  Effect.gen(function* () {
    const { router, results } = deps;

    yield* router.add(
      "GET",
      "/api/repos",
      Effect.map(results.repos(), (r) => json(r)),
    );

    yield* router.add("GET", "/api/runs", (req) => {
      const q = query(req);
      const limitRaw = Number(q.get("limit") ?? "100");
      const owner = optional(q.get("owner"));
      const repo = optional(q.get("repo"));
      const branch = optional(q.get("branch"));
      const tool = optional(q.get("tool"));
      const runId = optional(q.get("runId"));
      return Effect.map(
        results.listRuns({
          ...(owner ? { owner } : {}),
          ...(repo ? { repo } : {}),
          ...(branch ? { branch } : {}),
          ...(tool ? { tool } : {}),
          ...(runId ? { runId } : {}),
          limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        }),
        (rows) => json(rows),
      );
    });

    /** The home page: what state each repository is in, then the collections. */
    /** The overview, or a scope of it: every repository the filters leave, with its state. */
    yield* router.add("GET", "/api/overview", (req) =>
      Effect.gen(function* () {
        const q = query(req);
        const range = rangeOf(q.get("range"));
        const since = sinceOf(range);
        const all = yield* results.reports({ since });
        const refs = yield* results.refs();
        const collections = yield* results.collections();
        const scans = yield* results.scans();
        const branches = defaultBranchesOf(scans);
        const filters = filtersOf(collections, q.get("c"), q.get("q"));
        const reports = filters.length
          ? matching({ reports: all, refs, filters, since }).kept
          : all;
        const counts = Object.fromEntries(
          VIEW_COUNTS.map((g) => [
            g,
            computeGroups({ reports, refs, by: g, filters: [], since, defaultBranches: branches })
              .length,
          ]),
        );
        return json({
          range,
          query: q.get("q") ?? "",
          repos: computeOverview({ reports, refs, since, defaultBranches: branches }),
          scans: Object.fromEntries(scans.map((s) => [`${s.owner}/${s.repo}`, s])),
          collections: collectionRows(collections, all, refs, since),
          counts: { ...counts, run: runsOf(reports).length },
          repoList: yield* results.repos(),
        });
      }),
    );

    /** A view: runs grouped by a field, filtered by a query, inside a time range. */
    yield* router.add("GET", "/api/groups", (req) =>
      Effect.gen(function* () {
        const q = query(req);
        const by = groupByOf(q.get("by"));
        const range = rangeOf(q.get("range"));
        const since = sinceOf(range);
        const reports = yield* results.reports({ since });
        const refs = yield* results.refs();
        const collections = yield* results.collections();
        const branches = defaultBranchesOf(yield* results.scans());
        const filters = filtersOf(collections, q.get("c"), q.get("q"));
        const rows = computeGroups({
          reports,
          refs,
          by,
          filters,
          since,
          defaultBranches: branches,
        });
        const latest = rows.flatMap((g) => (g.latest ? [g.latest] : []));
        const counts = Object.fromEntries(
          VIEW_COUNTS.map((g) => [
            g,
            computeGroups({ reports, refs, by: g, filters: [], since, defaultBranches: branches })
              .length,
          ]),
        );
        return json({
          by,
          range,
          query: q.get("q") ?? "",
          groups: rows,
          totals: {
            runs: runsOf(matching({ reports, refs, filters, since }).kept).length,
            passRate:
              latest.length === 0
                ? null
                : latest.reduce((a, r) => a + r.passRate, 0) / latest.length,
            failingNow: rows.filter((g) => g.verdict === "failed").length,
            flaky: latest.reduce((a, r) => a + r.flaky, 0),
          },
          counts: { ...counts, run: runsOf(reports).length },
          repos: yield* results.repos(),
          collections,
        });
      }),
    );

    /** One group: its runs, the failing tests of the latest run, the common errors. */
    yield* router.add("GET", "/api/groups/:by/:key", (req) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const by = groupByOf(params.by ?? null);
        const key = params.key ?? "";
        const q = query(req);
        const range = rangeOf(q.get("range"), "90d");
        const since = sinceOf(range);
        const reports = yield* results.reports({ since });
        const refs = yield* results.refs();
        const filters = filtersOf(yield* results.collections(), q.get("c"), q.get("q"));
        const rows = computeGroups({
          reports,
          refs,
          by,
          filters,
          since,
          trendPoints: 60,
          defaultBranches: defaultBranchesOf(yield* results.scans()),
        });
        const group = rows.find((g) => g.key === key);
        if (!group) return notFound("group");
        const mine = reports.filter((r) => r.owner === group.owner && r.repo === group.repo);
        const runIds = new Set(group.trend.map((t) => t.runId));
        const runs = runsOf(mine.filter((r) => runIds.has(r.runId)));
        const latestIds = group.latest?.reportIds ?? [];
        const failing: Array<{
          testId: string;
          name: string;
          suite: string | null;
          tool: string;
          reportId: string;
          message: string | null;
          duration: number;
        }> = [];
        const errors = new Map<string, number>();
        for (const id of latestIds) {
          const tests = yield* results.testsOf(id);
          for (const t of tests) {
            if (t.status !== "failed") continue;
            failing.push({
              testId: t.testId,
              name: t.name,
              suite: t.suite,
              tool: t.tool,
              reportId: id,
              message: t.message,
              duration: t.duration,
            });
            const head = (t.message ?? "unknown error").split("\n")[0]?.slice(0, 120) ?? "";
            errors.set(head, (errors.get(head) ?? 0) + 1);
          }
        }
        const flaky: Array<{ testId: string; name: string; tool: string; occurrences: number }> =
          [];
        const flakyCount = new Map<string, { name: string; tool: string; n: number }>();
        for (const run of runs) {
          for (const id of run.reportIds) {
            const tests = yield* results.testsOf(id);
            for (const t of tests) {
              if (!t.flaky) continue;
              const cur = flakyCount.get(t.testId) ?? { name: t.name, tool: t.tool, n: 0 };
              cur.n++;
              flakyCount.set(t.testId, cur);
            }
          }
        }
        for (const [testId, v] of flakyCount)
          flaky.push({ testId, name: v.name, tool: v.tool, occurrences: v.n });
        flaky.sort((a, b) => b.occurrences - a.occurrences);
        const neighbours = rows.map((g) => g.key);
        const at = neighbours.indexOf(key);
        return json({
          group,
          runs,
          failing,
          errors: [...errors.entries()]
            .map(([message, count]) => ({ message, count }))
            .sort((a, b) => b.count - a.count),
          flaky,
          previous: neighbours[at + 1] ?? null,
          next: at > 0 ? (neighbours[at - 1] ?? null) : null,
        });
      }),
    );

    /** Suggestions for the search bar: fields, then values with counts. */
    yield* router.add("GET", "/api/fields", (req) =>
      Effect.gen(function* () {
        const typed = query(req).get("q") ?? "";
        const reports = yield* results.reports({});
        const refs = yield* results.refs();
        return json(suggest(indexValues(reports, refs), typed));
      }),
    );

    yield* router.add("GET", "/api/repositories", () =>
      Effect.map(results.repositories(), (rows) => json(rows)),
    );

    yield* router.add("GET", "/api/reports/:reportId", () =>
      Effect.gen(function* () {
        const { reportId = "" } = yield* HttpRouter.params;
        const run = yield* results.getRun(reportId);
        if (Option.isNone(run)) return notFound("report");
        const report = yield* results.getReport(reportId);
        const tests = yield* results.testsOf(reportId);
        const metrics = yield* results.metricsOf(reportId);
        const artifacts = yield* results.artifactsOfRun(
          run.value.owner,
          run.value.repo,
          run.value.runId,
        );
        const siblings = yield* results.listRuns({
          owner: run.value.owner,
          repo: run.value.repo,
          runId: run.value.runId,
          limit: 50,
        });
        return json({
          run: run.value,
          tests,
          metrics,
          artifacts,
          siblings: siblings.filter((s) => s.reportId !== reportId),
          report: Option.getOrNull(report),
          artifactRefs: Option.isSome(report) ? artifactsOf(report.value) : [],
        });
      }),
    );

    yield* router.add("GET", "/api/tests/:owner/:repo/:testId/history", (req) =>
      Effect.gen(function* () {
        const { owner = "", repo = "", testId = "" } = yield* HttpRouter.params;
        const limitRaw = Number(query(req).get("limit") ?? "50");
        const rows = yield* results.testHistory(
          owner,
          repo,
          testId,
          Number.isFinite(limitRaw) ? limitRaw : 50,
        );
        return json(rows);
      }),
    );
  });

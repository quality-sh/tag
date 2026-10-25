// Run, test and metric reads: the queries behind the report, history and group views.
import type { Database } from "bun:sqlite";
import { Effect, Option } from "effect";
import { validateReport, type CtrfReport } from "@quality-sh/tag-schema";
import {
  DbError,
  type Interface,
  type MetricRow,
  type RunFilter,
  type RunRow,
  type TestRow,
} from "./result-store-rows.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { trySync, type Params } from "./result-store-db.ts";
import { reportKeyOf } from "./result-store-index.ts";

const RUN_COLS = `report_id AS reportId, run_id AS runId, owner, repo, tool, tool_version AS toolVersion, branch, commit_sha AS "commit",
  build_url AS buildUrl, workflow, environment, timestamp, tests, passed, failed, skipped, pending, other, flaky, duration,
  artifact_id AS artifactId, artifact_name AS artifactName, adapter, ingested_at AS ingestedAt`;

const TEST_COLS = `t.report_id AS reportId, r.run_id AS runId, t.test_id AS testId, t.name, t.status, t.duration, t.file_path AS filePath,
  t.suite, t.flaky, t.retries, t.message, r.timestamp, r.branch, r.tool`;

const METRIC_COLS = `report_id AS reportId, test_id AS testId, name, value, threshold, comparator, passed`;

export const makeQueries = (
  db: Database,
  store: ArtifactStore.Interface,
): Pick<
  Interface,
  "listRuns" | "getRun" | "getReport" | "testsOf" | "metricsOf" | "testHistory"
> => {
  const listRuns = (filter: RunFilter) =>
    trySync("listRuns", () => {
      const where: string[] = [];
      const params: Params = {};
      if (filter.owner) {
        where.push("owner = $owner");
        params.$owner = filter.owner;
      }
      if (filter.repo) {
        where.push("repo = $repo");
        params.$repo = filter.repo;
      }
      if (filter.branch) {
        where.push("branch = $branch");
        params.$branch = filter.branch;
      }
      if (filter.tool) {
        where.push("tool = $tool");
        params.$tool = filter.tool;
      }
      if (filter.runId) {
        where.push("run_id = $runId");
        params.$runId = filter.runId;
      }
      params.$limit = Math.min(filter.limit ?? 100, 1000);
      const sql = `SELECT ${RUN_COLS} FROM reports ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY timestamp DESC LIMIT $limit`;
      return db.query<RunRow, Params>(sql).all(params);
    });

  const getRun = (reportId: string) =>
    trySync("getRun", () =>
      Option.fromNullOr(
        db
          .query<RunRow, [string]>(`SELECT ${RUN_COLS} FROM reports WHERE report_id = ?`)
          .get(reportId),
      ),
    );

  const getReport = Effect.fn("ResultStore.getReport")(function* (reportId: string) {
    const run = yield* getRun(reportId);
    if (Option.isNone(run)) return Option.none<CtrfReport>();
    const blob = yield* store.get(reportKeyOf(run.value.owner, run.value.repo, reportId));
    if (Option.isNone(blob)) return Option.none<CtrfReport>();
    const parsed = yield* trySync(
      "getReport.parse",
      () => JSON.parse(new TextDecoder().decode(blob.value.bytes)) as unknown,
    );
    const v = validateReport(parsed);
    if (!v.ok)
      return yield* Effect.fail(
        new DbError({ operation: "getReport.validate", cause: v.errors.join("; ") }),
      );
    return Option.some(v.report);
  });

  const testsOf = (reportId: string) =>
    trySync("testsOf", () =>
      db
        .query<TestRow, [string]>(
          `SELECT ${TEST_COLS} FROM tests t JOIN reports r ON r.report_id = t.report_id WHERE t.report_id = ? ORDER BY t.rowid`,
        )
        .all(reportId),
    );

  const metricsOfReport = (reportId: string) =>
    trySync("metricsOf", () =>
      db
        .query<MetricRow, [string]>(`SELECT ${METRIC_COLS} FROM metrics WHERE report_id = ?`)
        .all(reportId),
    );

  const testHistory = (owner: string, repo: string, testId: string, limit: number) =>
    trySync("testHistory", () => {
      const rows = db
        .query<TestRow, [string, string, string, number]>(
          `SELECT ${TEST_COLS} FROM tests t JOIN reports r ON r.report_id = t.report_id
           WHERE r.owner = ? AND r.repo = ? AND t.test_id = ? ORDER BY r.timestamp DESC LIMIT ?`,
        )
        .all(owner, repo, testId, limit);
      const metricQ = db.query<MetricRow, [string, string]>(
        `SELECT ${METRIC_COLS} FROM metrics WHERE report_id = ? AND test_id = ?`,
      );
      return rows.map((r) => ({ ...r, metrics: metricQ.all(r.reportId, testId) }));
    });

  return { listRuns, getRun, getReport, testsOf, metricsOf: metricsOfReport, testHistory };
};

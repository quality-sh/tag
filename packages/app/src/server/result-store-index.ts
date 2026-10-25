// Report indexing: a report, its tags, tests and metrics, written to SQLite once.
import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { withIdentity, metricsOf, tagsOf, type CtrfReport } from "@quality-sh/tag-schema";
import type { Interface, ReportOrigin } from "./result-store-rows.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { trySync, type Params } from "./result-store-db.ts";

export const reportKeyOf = (owner: string, repo: string, reportId: string) =>
  `reports/${owner}/${repo}/${reportId}.ctrf.json`;

export const makeIndex = (
  db: Database,
  store: ArtifactStore.Interface,
): {
  readonly ingest: Interface["ingest"];
  readonly indexReport: (report: CtrfReport, origin: ReportOrigin) => boolean;
} => {
  const insertReport = db.prepare<unknown, Params>(
    `INSERT INTO reports (report_id, run_id, owner, repo, tool, tool_version, branch, commit_sha, build_url, workflow, environment, timestamp, tests, passed, failed, skipped, pending, other, flaky, duration, artifact_id, artifact_name, adapter, ingested_at)
     VALUES ($reportId, $runId, $owner, $repo, $tool, $toolVersion, $branch, $commit, $buildUrl, $workflow, $environment, $timestamp, $tests, $passed, $failed, $skipped, $pending, $other, $flaky, $duration, $artifactId, $artifactName, $adapter, $ingestedAt)`,
  );
  const insertTag = db.prepare<unknown, Params>(
    `INSERT OR IGNORE INTO report_tags (report_id, tag) VALUES ($reportId, $tag)`,
  );
  const insertTest = db.prepare<unknown, Params>(
    `INSERT INTO tests (report_id, test_id, name, status, duration, file_path, suite, flaky, retries, message)
     VALUES ($reportId, $testId, $name, $status, $duration, $filePath, $suite, $flaky, $retries, $message)`,
  );
  const insertMetric = db.prepare<unknown, Params>(
    `INSERT INTO metrics (report_id, test_id, name, value, threshold, comparator, passed) VALUES ($reportId, $testId, $name, $value, $threshold, $comparator, $passed)`,
  );
  const hasReport = db.prepare<{ 1: number }, [string]>(
    `SELECT 1 FROM reports WHERE report_id = ?`,
  );

  const indexReport = db.transaction((report: CtrfReport, origin: ReportOrigin): boolean => {
    const reportId = report.reportId ?? "";
    if (hasReport.get(reportId)) return false;
    const env = report.results.environment ?? {};
    const s = report.results.summary;
    const timestamp = report.timestamp ?? new Date(s.start).toISOString();
    insertReport.run({
      $reportId: reportId,
      $runId: report.runId ?? env.buildId ?? "unknown",
      $owner: origin.owner,
      $repo: origin.repo,
      $tool: report.results.tool.name,
      $toolVersion: report.results.tool.version ?? null,
      $branch: env.branchName ?? null,
      $commit: env.commit ?? null,
      $buildUrl: env.buildUrl ?? null,
      $workflow: env.buildName ?? null,
      $environment: env.testEnvironment ?? null,
      $timestamp: timestamp,
      $tests: s.tests,
      $passed: s.passed,
      $failed: s.failed,
      $skipped: s.skipped,
      $pending: s.pending,
      $other: s.other,
      $flaky: s.flaky ?? report.results.tests.filter((t) => t.flaky).length,
      $duration: s.duration ?? Math.max(0, s.stop - s.start),
      $artifactId: origin.artifactId ?? null,
      $artifactName: origin.artifactName ?? null,
      $adapter: origin.adapter,
      $ingestedAt: new Date().toISOString(),
    });
    for (const tag of tagsOf(report)) insertTag.run({ $reportId: reportId, $tag: tag });
    for (const t of report.results.tests) {
      const testId = t.testId ?? "";
      insertTest.run({
        $reportId: reportId,
        $testId: testId,
        $name: t.name,
        $status: t.status,
        $duration: t.duration,
        $filePath: t.filePath ?? null,
        $suite: t.suite ? t.suite.join(" › ") : null,
        $flaky: t.flaky ? 1 : 0,
        $retries: t.retries ?? 0,
        $message: t.message ?? null,
      });
      for (const m of metricsOf(t)) {
        insertMetric.run({
          $reportId: reportId,
          $testId: testId,
          $name: m.name,
          $value: m.value,
          $threshold: m.threshold ?? null,
          $comparator: m.comparator ?? null,
          $passed: m.passed === undefined ? null : m.passed ? 1 : 0,
        });
      }
    }
    return true;
  });

  const ingest = Effect.fn("ResultStore.ingest")(function* (
    input: CtrfReport,
    origin: ReportOrigin,
  ) {
    const report = withIdentity(input);
    const reportId = report.reportId ?? "";
    const exists = yield* trySync("ingest.exists", () => hasReport.get(reportId) !== null);
    if (exists) return { inserted: false, reportId };
    yield* store.put(
      reportKeyOf(origin.owner, origin.repo, reportId),
      new TextEncoder().encode(JSON.stringify(report)),
      "application/json",
    );
    const inserted = yield* trySync("ingest.index", () => indexReport(report, origin));
    return { inserted, reportId };
  });

  return { ingest, indexReport };
};

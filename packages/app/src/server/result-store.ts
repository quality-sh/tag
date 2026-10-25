// The query index: SQLite via bun:sqlite. Derived from reports/ in the artifact store and rebuildable.
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  metricsOf,
  tagsOf,
  validateReport,
  withIdentity,
  type CtrfReport,
} from "@quality-sh/tag-schema";
import type { Collection, Ref, ReportLite } from "../grouping.ts";
import { AppConfig } from "./config.ts";
import { ArtifactStore } from "./artifact-store.ts";

export class DbError extends Schema.TaggedError<DbError>()("ResultStore.DbError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface ReportOrigin {
  readonly owner: string;
  readonly repo: string;
  readonly adapter: string;
  readonly artifactId?: string;
  readonly artifactName?: string;
}

export interface RunRow {
  readonly reportId: string;
  readonly runId: string;
  readonly owner: string;
  readonly repo: string;
  readonly tool: string;
  readonly toolVersion: string | null;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly buildUrl: string | null;
  readonly workflow: string | null;
  readonly environment: string | null;
  readonly timestamp: string;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
  readonly other: number;
  readonly flaky: number;
  readonly duration: number;
  readonly artifactId: string | null;
  readonly artifactName: string | null;
  readonly adapter: string;
  readonly ingestedAt: string;
}

export interface TestRow {
  readonly reportId: string;
  readonly runId: string;
  readonly testId: string;
  readonly name: string;
  readonly status: string;
  readonly duration: number;
  readonly filePath: string | null;
  readonly suite: string | null;
  readonly flaky: number;
  readonly retries: number;
  readonly message: string | null;
  readonly timestamp: string;
  readonly branch: string | null;
  readonly tool: string;
}

export interface MetricRow {
  readonly reportId: string;
  readonly testId: string;
  readonly name: string;
  readonly value: number | null;
  readonly threshold: number | null;
  readonly comparator: string | null;
  readonly passed: number | null;
}

export interface ArtifactRow {
  readonly artifactId: string;
  readonly owner: string;
  readonly repo: string;
  readonly runId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly expiresAt: string | null;
  readonly state: "listed" | "cached" | "expired";
  readonly cachedAt: string | null;
}

/** Where a repository stands: first sight, walking its history back, or caught up. */
export interface RepositoryRow {
  readonly owner: string;
  readonly repo: string;
  readonly state: "new" | "backfilling" | "current";
  readonly backfillDone: number;
  readonly backfillTotal: number | null;
  readonly firstSeenAt: string;
  readonly updatedAt: string;
}

export interface RunFilter {
  readonly owner?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly tool?: string;
  readonly runId?: string;
  readonly limit?: number;
}

export interface Interface {
  readonly ingest: (
    report: CtrfReport,
    origin: ReportOrigin,
  ) => Effect.Effect<
    { readonly inserted: boolean; readonly reportId: string },
    DbError | ArtifactStore.StoreError
  >;
  readonly listRuns: (filter: RunFilter) => Effect.Effect<ReadonlyArray<RunRow>, DbError>;
  readonly getRun: (reportId: string) => Effect.Effect<Option.Option<RunRow>, DbError>;
  readonly getReport: (
    reportId: string,
  ) => Effect.Effect<Option.Option<CtrfReport>, DbError | ArtifactStore.StoreError>;
  readonly testsOf: (reportId: string) => Effect.Effect<ReadonlyArray<TestRow>, DbError>;
  readonly metricsOf: (reportId: string) => Effect.Effect<ReadonlyArray<MetricRow>, DbError>;
  readonly testHistory: (
    owner: string,
    repo: string,
    testId: string,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<TestRow & { readonly metrics: ReadonlyArray<MetricRow> }>,
    DbError
  >;
  readonly upsertArtifact: (row: ArtifactRow) => Effect.Effect<void, DbError>;
  readonly artifactsOfRun: (
    owner: string,
    repo: string,
    runId: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactRow>, DbError>;
  readonly getArtifact: (artifactId: string) => Effect.Effect<Option.Option<ArtifactRow>, DbError>;
  /** A completed run never changes: once its artifacts are listed, later passes read them from here. */
  readonly markRunSeen: (
    owner: string,
    repo: string,
    runId: string,
  ) => Effect.Effect<void, DbError>;
  readonly seenRuns: (owner: string, repo: string) => Effect.Effect<ReadonlySet<string>, DbError>;
  readonly repository: (
    owner: string,
    repo: string,
  ) => Effect.Effect<Option.Option<RepositoryRow>, DbError>;
  readonly repositories: () => Effect.Effect<ReadonlyArray<RepositoryRow>, DbError>;
  /** Insert on first sight, keeping that time; later calls move the state and progress. */
  readonly upsertRepository: (
    row: Pick<RepositoryRow, "owner" | "repo" | "state" | "backfillDone" | "backfillTotal">,
  ) => Effect.Effect<void, DbError>;
  /** After a sweep: the files are gone, so the row is "listed" again, or "expired" when the source is too. */
  readonly markArtifactSwept: (
    artifactId: string,
    state: "listed" | "expired",
  ) => Effect.Effect<void, DbError>;
  /** Cached artifacts whose run (or, failing that, cache time) is older than `cutoff`. */
  readonly cachedArtifactsBefore: (
    cutoff: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactRow>, DbError>;
  readonly repos: () => Effect.Effect<
    ReadonlyArray<{ readonly owner: string; readonly repo: string; readonly reports: number }>,
    DbError
  >;
  /** Every report with what groupings need, newest first; `since` is an ISO timestamp. */
  readonly reports: (opts: {
    readonly since?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<ReportLite>, DbError>;
  readonly upsertRef: (ref: Ref) => Effect.Effect<void, DbError>;
  readonly refs: (repo?: {
    readonly owner: string;
    readonly repo: string;
  }) => Effect.Effect<ReadonlyArray<Ref>, DbError>;
  readonly collections: () => Effect.Effect<ReadonlyArray<Collection>, DbError>;
  readonly saveCollection: (c: Collection) => Effect.Effect<void, DbError>;
  readonly deleteCollection: (id: string) => Effect.Effect<boolean, DbError>;
  /** One key/value row; the GitHub App installation id lives here between boots. */
  readonly getSetting: (key: string) => Effect.Effect<Option.Option<string>, DbError>;
  readonly setSetting: (key: string, value: string) => Effect.Effect<void, DbError>;
  /** Drop the index and rebuild it from reports/ in the artifact store. */
  readonly rebuild: () => Effect.Effect<
    { readonly reports: number },
    DbError | ArtifactStore.StoreError
  >;
}

export class Service extends Context.Service<Service, Interface>()("@tag/ResultStore") {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
  tool TEXT NOT NULL, tool_version TEXT, branch TEXT, commit_sha TEXT, build_url TEXT, timestamp TEXT NOT NULL,
  tests INTEGER NOT NULL, passed INTEGER NOT NULL, failed INTEGER NOT NULL, skipped INTEGER NOT NULL,
  pending INTEGER NOT NULL, other INTEGER NOT NULL, flaky INTEGER NOT NULL, duration INTEGER NOT NULL,
  artifact_id TEXT, artifact_name TEXT, adapter TEXT NOT NULL, ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_repo_ts ON reports(owner, repo, timestamp DESC);
CREATE INDEX IF NOT EXISTS reports_run ON reports(owner, repo, run_id);
CREATE TABLE IF NOT EXISTS tests (
  report_id TEXT NOT NULL, test_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  duration INTEGER NOT NULL, file_path TEXT, suite TEXT, flaky INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0, message TEXT
);
CREATE INDEX IF NOT EXISTS tests_report ON tests(report_id);
CREATE INDEX IF NOT EXISTS tests_test ON tests(test_id);
CREATE TABLE IF NOT EXISTS metrics (
  report_id TEXT NOT NULL, test_id TEXT NOT NULL, name TEXT NOT NULL,
  value REAL, threshold REAL, comparator TEXT, passed INTEGER
);
CREATE INDEX IF NOT EXISTS metrics_report ON metrics(report_id);
CREATE INDEX IF NOT EXISTS metrics_test ON metrics(test_id, name);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, run_id TEXT NOT NULL, name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, expires_at TEXT, state TEXT NOT NULL, cached_at TEXT
);
CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts(owner, repo, run_id);
CREATE TABLE IF NOT EXISTS runs_seen (
  owner TEXT NOT NULL, repo TEXT NOT NULL, run_id TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (owner, repo, run_id)
);
CREATE TABLE IF NOT EXISTS repositories (
  owner TEXT NOT NULL, repo TEXT NOT NULL, state TEXT NOT NULL, backfill_done INTEGER NOT NULL DEFAULT 0,
  backfill_total INTEGER, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner, repo)
);
CREATE TABLE IF NOT EXISTS report_tags (report_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (report_id, tag));
CREATE INDEX IF NOT EXISTS report_tags_tag ON report_tags(tag);
CREATE TABLE IF NOT EXISTS refs (
  kind TEXT NOT NULL, key TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
  commit_sha TEXT, branch TEXT, timestamp TEXT NOT NULL, title TEXT, url TEXT, meta TEXT NOT NULL,
  PRIMARY KEY (owner, repo, kind, key)
);
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, query TEXT NOT NULL,
  group_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`;

/** Columns added after the first schema; applied when missing so old indexes keep working. */
const MIGRATIONS: ReadonlyArray<readonly [table: string, column: string, ddl: string]> = [
  ["reports", "workflow", "ALTER TABLE reports ADD COLUMN workflow TEXT"],
  ["reports", "environment", "ALTER TABLE reports ADD COLUMN environment TEXT"],
];

const RUN_COLS = `report_id AS reportId, run_id AS runId, owner, repo, tool, tool_version AS toolVersion, branch, commit_sha AS "commit",
  build_url AS buildUrl, workflow, environment, timestamp, tests, passed, failed, skipped, pending, other, flaky, duration,
  artifact_id AS artifactId, artifact_name AS artifactName, adapter, ingested_at AS ingestedAt`;

const TEST_COLS = `t.report_id AS reportId, r.run_id AS runId, t.test_id AS testId, t.name, t.status, t.duration, t.file_path AS filePath,
  t.suite, t.flaky, t.retries, t.message, r.timestamp, r.branch, r.tool`;

const METRIC_COLS = `report_id AS reportId, test_id AS testId, name, value, threshold, comparator, passed`;

const ARTIFACT_COLS = `artifact_id AS artifactId, owner, repo, run_id AS runId, name, size_bytes AS sizeBytes, expires_at AS expiresAt, state, cached_at AS cachedAt`;

const LITE_COLS = `r.report_id AS reportId, r.run_id AS runId, r.owner, r.repo, r.tool, r.branch, r.commit_sha AS "commit",
  r.workflow, r.environment, r.timestamp, r.tests, r.passed, r.failed, r.skipped, r.flaky, r.duration, r.build_url AS buildUrl,
  (SELECT group_concat(tag, char(31)) FROM report_tags t WHERE t.report_id = r.report_id) AS tagList`;

const REF_COLS = `kind, key, owner, repo, commit_sha AS "commit", branch, timestamp, title, url, meta`;

const COLLECTION_COLS = `id, name, description, query, created_at AS createdAt`;

type LiteRow = Omit<ReportLite, "tags"> & { readonly tagList: string | null };
type RefRow = Omit<Ref, "meta"> & { readonly meta: string };

export const reportKeyOf = (owner: string, repo: string, reportId: string) =>
  `reports/${owner}/${repo}/${reportId}.ctrf.json`;

type Params = Record<string, string | number | null>;

export const make = (db: Database, store: ArtifactStore.Interface): Interface => {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(SCHEMA);
  for (const [table, column, ddl] of MIGRATIONS) {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) db.run(ddl);
  }

  const dbError = (operation: string) => (cause: unknown) => new DbError({ operation, cause });
  const trySync = <A>(operation: string, f: () => A) =>
    Effect.try({ try: f, catch: dbError(operation) });

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

  const upsertArtifact = (row: ArtifactRow) =>
    trySync("upsertArtifact", () => {
      db.query<unknown, Params>(
        `INSERT INTO artifacts (artifact_id, owner, repo, run_id, name, size_bytes, expires_at, state, cached_at)
         VALUES ($id, $owner, $repo, $runId, $name, $size, $expiresAt, $state, $cachedAt)
         ON CONFLICT(artifact_id) DO UPDATE SET size_bytes = excluded.size_bytes, expires_at = excluded.expires_at,
           state = CASE WHEN artifacts.state = 'cached' AND excluded.state = 'listed' THEN 'cached' ELSE excluded.state END,
           cached_at = COALESCE(excluded.cached_at, artifacts.cached_at)`,
      ).run({
        $id: row.artifactId,
        $owner: row.owner,
        $repo: row.repo,
        $runId: row.runId,
        $name: row.name,
        $size: row.sizeBytes,
        $expiresAt: row.expiresAt,
        $state: row.state,
        $cachedAt: row.cachedAt,
      });
    });

  const markRunSeen = (owner: string, repo: string, runId: string) =>
    trySync("markRunSeen", () => {
      db.query<unknown, [string, string, string, string]>(
        `INSERT OR REPLACE INTO runs_seen (owner, repo, run_id, seen_at) VALUES (?, ?, ?, ?)`,
      ).run(owner, repo, runId, new Date().toISOString());
    });

  const seenRuns = (owner: string, repo: string) =>
    trySync(
      "seenRuns",
      () =>
        new Set(
          db
            .query<{ runId: string }, [string, string]>(
              `SELECT run_id AS runId FROM runs_seen WHERE owner = ? AND repo = ?`,
            )
            .all(owner, repo)
            .map((r) => r.runId),
        ) as ReadonlySet<string>,
    );

  const REPOSITORY_COLS = `owner, repo, state, backfill_done AS backfillDone, backfill_total AS backfillTotal,
    first_seen_at AS firstSeenAt, updated_at AS updatedAt`;
  const repository = (owner: string, repo: string) =>
    trySync("repository", () =>
      Option.fromNullOr(
        db
          .query<RepositoryRow, [string, string]>(
            `SELECT ${REPOSITORY_COLS} FROM repositories WHERE owner = ? AND repo = ?`,
          )
          .get(owner, repo),
      ),
    );
  const repositories = () =>
    trySync("repositories", () =>
      db
        .query<RepositoryRow, []>(
          `SELECT ${REPOSITORY_COLS} FROM repositories ORDER BY owner, repo`,
        )
        .all(),
    );
  const upsertRepository = (
    row: Pick<RepositoryRow, "owner" | "repo" | "state" | "backfillDone" | "backfillTotal">,
  ) =>
    trySync("upsertRepository", () => {
      const now = new Date().toISOString();
      db.query<unknown, Params>(
        `INSERT INTO repositories (owner, repo, state, backfill_done, backfill_total, first_seen_at, updated_at)
         VALUES ($owner, $repo, $state, $done, $total, $now, $now)
         ON CONFLICT(owner, repo) DO UPDATE SET state = excluded.state, backfill_done = excluded.backfill_done,
           backfill_total = excluded.backfill_total, updated_at = excluded.updated_at`,
      ).run({
        $owner: row.owner,
        $repo: row.repo,
        $state: row.state,
        $done: row.backfillDone,
        $total: row.backfillTotal,
        $now: now,
      });
    });

  const artifactsOfRun = (owner: string, repo: string, runId: string) =>
    trySync("artifactsOfRun", () =>
      db
        .query<ArtifactRow, [string, string, string]>(
          `SELECT ${ARTIFACT_COLS} FROM artifacts WHERE owner = ? AND repo = ? AND run_id = ? ORDER BY name`,
        )
        .all(owner, repo, runId),
    );
  const markArtifactSwept = (artifactId: string, state: "listed" | "expired") =>
    trySync("markArtifactSwept", () => {
      db.query(`UPDATE artifacts SET state = ?, cached_at = NULL WHERE artifact_id = ?`).run(
        state,
        artifactId,
      );
    });
  const cachedArtifactsBefore = (cutoff: string) =>
    trySync("cachedArtifactsBefore", () =>
      db
        .query<ArtifactRow, [string]>(
          `SELECT ${ARTIFACT_COLS} FROM artifacts a
           WHERE a.state = 'cached'
             AND COALESCE((SELECT MAX(r.timestamp) FROM reports r WHERE r.artifact_id = a.artifact_id), a.cached_at, '') < ?
           ORDER BY a.cached_at`,
        )
        .all(cutoff),
    );
  const getArtifact = (artifactId: string) =>
    trySync("getArtifact", () =>
      Option.fromNullOr(
        db
          .query<ArtifactRow, [string]>(
            `SELECT ${ARTIFACT_COLS} FROM artifacts WHERE artifact_id = ?`,
          )
          .get(artifactId),
      ),
    );

  const repos = () =>
    trySync("repos", () =>
      db
        .query<{ owner: string; repo: string; reports: number }, []>(
          `SELECT owner, repo, COUNT(*) AS reports FROM reports GROUP BY owner, repo ORDER BY owner, repo`,
        )
        .all(),
    );

  const reports = (opts: { readonly since?: string | undefined }) =>
    trySync("reports", () => {
      const rows = opts.since
        ? db
            .query<LiteRow, [string]>(
              `SELECT ${LITE_COLS} FROM reports r WHERE r.timestamp >= ? ORDER BY r.timestamp DESC`,
            )
            .all(opts.since)
        : db
            .query<LiteRow, []>(`SELECT ${LITE_COLS} FROM reports r ORDER BY r.timestamp DESC`)
            .all();
      return rows.map(({ tagList, ...r }): ReportLite => ({
        ...r,
        tags: tagList ? tagList.split("\u001f") : [],
      }));
    });

  const upsertRef = (ref: Ref) =>
    trySync("upsertRef", () => {
      db.query<unknown, Params>(
        `INSERT INTO refs (kind, key, owner, repo, commit_sha, branch, timestamp, title, url, meta)
         VALUES ($kind, $key, $owner, $repo, $commit, $branch, $timestamp, $title, $url, $meta)
         ON CONFLICT(owner, repo, kind, key) DO UPDATE SET commit_sha = excluded.commit_sha, branch = excluded.branch,
           timestamp = excluded.timestamp, title = excluded.title, url = excluded.url, meta = excluded.meta`,
      ).run({
        $kind: ref.kind,
        $key: ref.key,
        $owner: ref.owner,
        $repo: ref.repo,
        $commit: ref.commit,
        $branch: ref.branch,
        $timestamp: ref.timestamp,
        $title: ref.title,
        $url: ref.url,
        $meta: JSON.stringify(ref.meta),
      });
    });

  const parseRef = (r: RefRow): Ref => ({
    ...r,
    meta: JSON.parse(r.meta) as Record<string, unknown>,
  });

  const refs = (repo?: { readonly owner: string; readonly repo: string }) =>
    trySync("refs", () =>
      (repo
        ? db
            .query<RefRow, [string, string]>(
              `SELECT ${REF_COLS} FROM refs WHERE owner = ? AND repo = ? ORDER BY timestamp DESC`,
            )
            .all(repo.owner, repo.repo)
        : db.query<RefRow, []>(`SELECT ${REF_COLS} FROM refs ORDER BY timestamp DESC`).all()
      ).map(parseRef),
    );

  const collections = () =>
    trySync("collections", () =>
      db
        .query<Collection, []>(`SELECT ${COLLECTION_COLS} FROM collections ORDER BY created_at`)
        .all(),
    );

  const saveCollection = (c: Collection) =>
    trySync("saveCollection", () => {
      db.query<unknown, Params>(
        `INSERT INTO collections (id, name, description, query, group_by, created_at)
         VALUES ($id, $name, $description, $query, $groupBy, $createdAt)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
           query = excluded.query`,
      ).run({
        $id: c.id,
        $name: c.name,
        $description: c.description,
        $query: c.query,
        // The column predates scopes; every view is on a collection's page now.
        $groupBy: "release",
        $createdAt: c.createdAt,
      });
    });

  const deleteCollection = (id: string) =>
    trySync(
      "deleteCollection",
      () => db.query<unknown, [string]>(`DELETE FROM collections WHERE id = ?`).run(id).changes > 0,
    );

  const getSetting = (key: string) =>
    trySync("getSetting", () =>
      Option.map(
        Option.fromNullOr(
          db
            .query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`)
            .get(key),
        ),
        (row) => row.value,
      ),
    );

  const setSetting = (key: string, value: string) =>
    trySync("setSetting", () => {
      db.query<unknown, Params>(
        `INSERT INTO settings (key, value) VALUES ($key, $value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run({ $key: key, $value: value });
    });

  const rebuild = Effect.fn("ResultStore.rebuild")(function* () {
    yield* trySync("rebuild.clear", () => {
      db.run("DELETE FROM metrics");
      db.run("DELETE FROM tests");
      db.run("DELETE FROM report_tags");
      db.run("DELETE FROM reports");
    });
    const keys = yield* store.list("reports/");
    let count = 0;
    for (const key of keys) {
      if (!key.endsWith(".ctrf.json")) continue;
      const [, owner, repo] = key.split("/");
      const blob = yield* store.get(key);
      if (Option.isNone(blob) || !owner || !repo) continue;
      const v = validateReport(JSON.parse(new TextDecoder().decode(blob.value.bytes)));
      if (!v.ok) {
        yield* Effect.logWarning(`rebuild: skipping invalid report ${key}`);
        continue;
      }
      const inserted = yield* trySync("rebuild.index", () =>
        indexReport(withIdentity(v.report), { owner, repo, adapter: "rebuild" }),
      );
      if (inserted) count++;
    }
    return { reports: count };
  });

  return {
    ingest,
    listRuns,
    getRun,
    getReport,
    testsOf,
    metricsOf: metricsOfReport,
    testHistory,
    upsertArtifact,
    artifactsOfRun,
    getArtifact,
    markRunSeen,
    seenRuns,
    repository,
    repositories,
    upsertRepository,
    cachedArtifactsBefore,
    markArtifactSwept,
    repos,
    reports,
    upsertRef,
    refs,
    collections,
    saveCollection,
    deleteCollection,
    getSetting,
    setSetting,
    rebuild,
  };
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const store = yield* ArtifactStore.Service;
    const db = yield* Effect.tryPromise({
      try: async () => {
        if (cfg.sqlitePath !== ":memory:")
          await mkdir(dirname(cfg.sqlitePath), { recursive: true });
        return new Database(cfg.sqlitePath, { create: true });
      },
      catch: (cause) => new DbError({ operation: "open", cause }),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
    yield* Effect.logInfo(`result store: sqlite at ${cfg.sqlitePath}`);
    return Service.of(make(db, store));
  }),
);

export * as ResultStore from "./result-store.ts";

// The SQLite handle: schema and migrations, and the guard that maps failures to DbError.
import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { DbError } from "./result-store-rows.ts";

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
CREATE TABLE IF NOT EXISTS repo_scan (
  owner TEXT NOT NULL, repo TEXT NOT NULL,
  default_branch TEXT, environments TEXT NOT NULL,
  classification TEXT, reporting TEXT, unread TEXT, runners TEXT, names TEXT, scanned_at TEXT,
  PRIMARY KEY (owner, repo)
);
CREATE TABLE IF NOT EXISTS repo_proposal (
  owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
  state TEXT NOT NULL, branch TEXT NOT NULL, opened_at TEXT NOT NULL, PRIMARY KEY (owner, repo)
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

/** Create the tables and indexes, then add the columns the schema grew since the first boot. */
export const applySchema = (db: Database) => {
  db.run(SCHEMA);
  for (const [table, column, ddl] of MIGRATIONS) {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) db.run(ddl);
  }
};

export type Params = Record<string, string | number | null>;

export const dbError = (operation: string) => (cause: unknown) => new DbError({ operation, cause });

export const trySync = <A>(operation: string, f: () => A) =>
  Effect.try({ try: f, catch: dbError(operation) });

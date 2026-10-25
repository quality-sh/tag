// Repository and scan rows: the backfill state, and what the latest scan of each repository knew.
import type { Database } from "bun:sqlite";
import { Option } from "effect";
import type { RunnerFinding, UnreadArtifact } from "../scan.ts";
import type { Interface, RepositoryRow, ScanRow } from "./result-store-rows.ts";
import { trySync, type Params } from "./result-store-db.ts";

const REPOSITORY_COLS = `owner, repo, state, backfill_done AS backfillDone, backfill_total AS backfillTotal,
  first_seen_at AS firstSeenAt, updated_at AS updatedAt`;

const SCAN_COLS = `owner, repo, default_branch AS defaultBranch, environments, classification, reporting, unread, runners, names, scanned_at AS scannedAt`;

/** JSON list columns decode to arrays; an empty string is the empty list. */
const scanRow = (r: {
  owner: string;
  repo: string;
  defaultBranch: string | null;
  environments: string;
  classification: string | null;
  reporting: string;
  unread: string;
  runners: string;
  names: string;
  scannedAt: string | null;
}): ScanRow => ({
  owner: r.owner,
  repo: r.repo,
  defaultBranch: r.defaultBranch,
  environments: JSON.parse(r.environments || "[]") as ReadonlyArray<string>,
  classification: (r.classification as ScanRow["classification"]) ?? null,
  reporting: JSON.parse(r.reporting || "[]") as ReadonlyArray<string>,
  unread: JSON.parse(r.unread || "[]") as ReadonlyArray<UnreadArtifact>,
  runners: JSON.parse(r.runners || "[]") as ReadonlyArray<RunnerFinding>,
  names: JSON.parse(r.names || "[]") as ReadonlyArray<string>,
  scannedAt: r.scannedAt,
});

export const makeRepositories = (
  db: Database,
): Pick<
  Interface,
  "repository" | "repositories" | "upsertRepository" | "upsertScan" | "scans" | "scanOf"
> => {
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

  const upsertScan = (row: ScanRow) =>
    trySync("upsertScan", () => {
      db.query<unknown, Params>(
        `INSERT INTO repo_scan (owner, repo, default_branch, environments, classification, reporting, unread, runners, names, scanned_at)
         VALUES ($owner, $repo, $defaultBranch, $environments, $classification, $reporting, $unread, $runners, $names, $scannedAt)
         ON CONFLICT(owner, repo) DO UPDATE SET default_branch = excluded.default_branch, environments = excluded.environments,
           classification = excluded.classification, reporting = excluded.reporting, unread = excluded.unread,
           runners = excluded.runners, names = excluded.names, scanned_at = excluded.scanned_at`,
      ).run({
        $owner: row.owner,
        $repo: row.repo,
        $defaultBranch: row.defaultBranch,
        $environments: JSON.stringify(row.environments),
        $classification: row.classification,
        $reporting: JSON.stringify(row.reporting),
        $unread: JSON.stringify(row.unread),
        $runners: JSON.stringify(row.runners),
        $names: JSON.stringify(row.names),
        $scannedAt: row.scannedAt,
      });
    });

  const scans = () =>
    trySync("scans", () =>
      db
        .query<Parameters<typeof scanRow>[0], []>(
          `SELECT ${SCAN_COLS} FROM repo_scan ORDER BY owner, repo`,
        )
        .all()
        .map(scanRow),
    );

  const scanOf = (owner: string, repo: string) =>
    trySync("scanOf", () => {
      const row = db
        .query<Parameters<typeof scanRow>[0], [string, string]>(
          `SELECT ${SCAN_COLS} FROM repo_scan WHERE owner = ? AND repo = ?`,
        )
        .get(owner, repo);
      return row === undefined || row === null ? Option.none<ScanRow>() : Option.some(scanRow(row));
    });

  return { repository, repositories, upsertRepository, upsertScan, scans, scanOf };
};

// The report listing and the refs: what the home page, groups and collections read.
import type { Database } from "bun:sqlite";
import type { Ref, ReportLite } from "../grouping.ts";
import type { Interface } from "./result-store-rows.ts";
import { trySync, type Params } from "./result-store-db.ts";

const LITE_COLS = `r.report_id AS reportId, r.run_id AS runId, r.owner, r.repo, r.tool, r.branch, r.commit_sha AS "commit",
  r.workflow, r.environment, r.timestamp, r.tests, r.passed, r.failed, r.skipped, r.flaky, r.duration, r.build_url AS buildUrl,
  (SELECT group_concat(tag, char(31)) FROM report_tags t WHERE t.report_id = r.report_id) AS tagList`;

const REF_COLS = `kind, key, owner, repo, commit_sha AS "commit", branch, timestamp, title, url, meta`;

type LiteRow = Omit<ReportLite, "tags"> & { readonly tagList: string | null };
type RefRow = Omit<Ref, "meta"> & { readonly meta: string };

export const makeReports = (
  db: Database,
): Pick<Interface, "repos" | "reports" | "upsertRef" | "refs"> => {
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

  return { repos, reports, upsertRef, refs };
};

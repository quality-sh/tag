// The overview: what state each repository is in, before any grouping — the latest
// run on its default branch, the newest release, the open pull requests.
import { computeGroups, defaultBranchOf, pct, type GroupRow } from "./compute.ts";
import type { ReportLite } from "./report.ts";
import { assign, type Ref } from "./refs.ts";
import { runsOf, type RunSummary, type TrendPoint } from "./runs.ts";

export interface RecentRun {
  readonly run: RunSummary;
  readonly reports: ReadonlyArray<ReportLite>;
  readonly release: string | null;
  readonly pullRequest: string | null;
}

export interface RepoOverview {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string | null;
  /** The latest run on the default branch, against the one before it. */
  readonly main: {
    readonly run: RunSummary | null;
    readonly vsPrevious: number | null;
    readonly trend: ReadonlyArray<TrendPoint>;
  };
  /** The newest release or tag with its verdict. */
  readonly release: GroupRow | null;
  readonly pullRequests: {
    readonly open: number;
    readonly failing: number;
    readonly rows: ReadonlyArray<GroupRow>;
  };
  readonly flaky: number;
  readonly runs: number;
  readonly recent: ReadonlyArray<RecentRun>;
}

const isOpen = (r: Ref) => r.kind === "pull_request" && typeof r.meta.closedAt !== "string";

export function computeOverview(input: {
  readonly reports: ReadonlyArray<ReportLite>;
  readonly refs: ReadonlyArray<Ref>;
  readonly since?: string | undefined;
  readonly recent?: number | undefined;
  /** owner/repo → default branch from the repository API; wins per repo over the guess. */
  readonly defaultBranches?: Readonly<Record<string, string>> | undefined;
}): RepoOverview[] {
  const { refs } = input;
  const recentN = input.recent ?? 8;
  const inRange = input.since
    ? input.reports.filter((r) => r.timestamp >= (input.since ?? ""))
    : input.reports;
  const byRepo = new Map<string, ReportLite[]>();
  for (const r of inRange) {
    const k = `${r.owner}/${r.repo}`;
    byRepo.set(k, [...(byRepo.get(k) ?? []), r]);
  }
  const out: RepoOverview[] = [];
  for (const reports of byRepo.values()) {
    const first = reports[0];
    if (!first) continue;
    const { owner, repo } = first;
    const runs = runsOf(reports);
    const defaultBranch =
      input.defaultBranches?.[`${owner}/${repo}`] ?? defaultBranchOf(runs, refs, { owner, repo });
    const mainRuns = runs.filter((r) => r.branch === defaultBranch);
    const mainRun = mainRuns[0] ?? null;
    const before = mainRuns[1];
    const main = {
      run: mainRun,
      vsPrevious: mainRun && before ? pct(mainRun.passRate) - pct(before.passRate) : null,
      trend: [...mainRuns]
        .reverse()
        .slice(-14)
        .map((r) => ({
          runId: r.runId,
          timestamp: r.timestamp,
          passRate: r.passRate,
          failed: r.failed,
        })),
    };
    const releases = computeGroups({ reports, refs, by: "release", filters: [] });
    const release = releases.find((g) => g.ref !== null) ?? null;
    const openKeys = new Set(
      refs.filter((r) => isOpen(r) && r.owner === owner && r.repo === repo).map((r) => r.key),
    );
    const prRows = computeGroups({ reports, refs, by: "pull_request", filters: [] }).filter((g) =>
      openKeys.has(g.key),
    );
    const byRun = new Map<string, ReportLite[]>();
    for (const r of reports) byRun.set(r.runId, [...(byRun.get(r.runId) ?? []), r]);
    const recent = runs.slice(0, recentN).map((run): RecentRun => {
      const a = assign(run, refs);
      return {
        run,
        reports: [...(byRun.get(run.runId) ?? [])].sort((x, y) => x.tool.localeCompare(y.tool)),
        release: a.release === null ? null : a.release === "unreleased" ? null : a.release.key,
        pullRequest: a.pullRequest?.key ?? null,
      };
    });
    out.push({
      owner,
      repo,
      defaultBranch,
      main,
      release,
      pullRequests: {
        open: openKeys.size,
        failing: prRows.filter((g) => g.verdict === "failed").length,
        rows: prRows,
      },
      flaky: mainRun?.flaky ?? 0,
      runs: runs.length,
      recent,
    });
  }
  out.sort((a, b) =>
    (b.recent[0]?.run.timestamp ?? "").localeCompare(a.recent[0]?.run.timestamp ?? ""),
  );
  return out;
}

// The group computation: buckets of reports per group key, and each row's runs,
// verdict, trend and baseline, with the default-branch guess the baselines need.
import type { GroupBy } from "./groupby.ts";
import type { ReportLite } from "./report.ts";
import type { Filter } from "./query.ts";
import { dayOf, matches } from "./match.ts";
import { assign, sameRepo, type Assigned, type Ref } from "./refs.ts";
import { runKey, runsOf, type RunSummary, type TrendPoint } from "./runs.ts";

export type Verdict = "passed" | "failed" | "none";

export interface GroupRow {
  readonly by: GroupBy;
  readonly key: string;
  readonly label: string;
  readonly owner: string;
  readonly repo: string;
  readonly facts: ReadonlyArray<string>;
  readonly verdict: Verdict;
  readonly latest: RunSummary | null;
  readonly runs: number;
  readonly trend: ReadonlyArray<TrendPoint>;
  /** Pass-rate difference against the baseline, in percentage points. */
  readonly vsBaseline: number | null;
  readonly baselineLabel: string | null;
  readonly baselineRun: RunSummary | null;
  readonly lastAt: string;
  readonly ref: Ref | null;
}

export interface GroupInput {
  readonly reports: ReadonlyArray<ReportLite>;
  readonly refs: ReadonlyArray<Ref>;
  readonly by: GroupBy;
  readonly filters: ReadonlyArray<Filter>;
  /** ISO timestamp: only reports at or after it count. */
  readonly since?: string | undefined;
  readonly trendPoints?: number | undefined;
  readonly defaultBranch?: string | undefined;
  /** owner/repo → default branch from the repository API; wins per repo over the guess. */
  readonly defaultBranches?: Readonly<Record<string, string>> | undefined;
}

interface Bucket {
  readonly key: string;
  readonly label: string;
  readonly owner: string;
  readonly repo: string;
  readonly reports: ReportLite[];
  readonly ref: Ref | null;
}

const DEFAULT_BRANCHES = ["main", "master", "trunk", "develop"];

/**
 * A repository's default branch: a conventional name seen in its runs, else the branch its
 * pull requests target most, else the branch with the most runs. The source never says.
 */
export function defaultBranchOf(
  runs: ReadonlyArray<{ readonly branch: string | null }>,
  refs: ReadonlyArray<Ref>,
  repo: { readonly owner: string; readonly repo: string },
): string | null {
  const seen = new Map<string, number>();
  for (const r of runs) if (r.branch) seen.set(r.branch, (seen.get(r.branch) ?? 0) + 1);
  const conventional = DEFAULT_BRANCHES.find((b) => seen.has(b));
  if (conventional) return conventional;
  const bases = new Map<string, number>();
  for (const r of refs)
    if (r.kind === "pull_request" && sameRepo(r, repo) && typeof r.meta.base === "string")
      bases.set(r.meta.base, (bases.get(r.meta.base) ?? 0) + 1);
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top(bases) ?? top(seen) ?? null;
}

export function keysOf(
  r: ReportLite,
  a: Assigned,
  by: GroupBy,
): ReadonlyArray<{ key: string; label: string; ref: Ref | null }> {
  switch (by) {
    case "repo":
      return [{ key: `${r.owner}/${r.repo}`, label: `${r.owner}/${r.repo}`, ref: null }];
    case "branch":
      return r.branch ? [{ key: r.branch, label: r.branch, ref: null }] : [];
    case "tool":
      return [{ key: r.tool, label: r.tool, ref: null }];
    case "workflow":
      return r.workflow ? [{ key: r.workflow, label: r.workflow, ref: null }] : [];
    case "environment":
      return r.environment ? [{ key: r.environment, label: r.environment, ref: null }] : [];
    case "tag":
      return r.tags.map((t) => ({ key: t, label: t, ref: null }));
    case "day":
      return [{ key: dayOf(r.timestamp), label: dayOf(r.timestamp), ref: null }];
    case "run":
      return [{ key: r.runId, label: r.runId, ref: null }];
    case "release":
      if (a.release === null) return [];
      if (a.release === "unreleased")
        return [{ key: "unreleased", label: "unreleased", ref: null }];
      return [{ key: a.release.key, label: a.release.key, ref: a.release }];
    case "pull_request":
      return a.pullRequest
        ? [
            {
              key: a.pullRequest.key,
              label: a.pullRequest.title
                ? `${a.pullRequest.key} · ${a.pullRequest.title}`
                : a.pullRequest.key,
              ref: a.pullRequest,
            },
          ]
        : [];
  }
}

export const pct = (x: number) => Math.round(x * 1000) / 10;

/** The reports in range that pass every filter, with each run's assignment memoised. */
export function matching(input: Omit<GroupInput, "by" | "trendPoints" | "defaultBranch">) {
  const assigned = new Map<string, Assigned>();
  const assignedOf = (r: ReportLite) => {
    const k = runKey(r);
    let a = assigned.get(k);
    if (!a) {
      a = assign(r, input.refs);
      assigned.set(k, a);
    }
    return a;
  };
  const inRange = input.since
    ? input.reports.filter((r) => r.timestamp >= (input.since ?? ""))
    : input.reports;
  const kept = inRange.filter((r) => input.filters.every((f) => matches(r, assignedOf(r), f)));
  return { inRange, kept, assignedOf };
}

export function computeGroups(input: GroupInput): GroupRow[] {
  const { by } = input;
  const trendPoints = input.trendPoints ?? 14;
  const { inRange, kept, assignedOf } = matching(input);

  const buckets = new Map<string, Bucket>();
  for (const r of kept) {
    for (const k of keysOf(r, assignedOf(r), by)) {
      const id =
        by === "repo" || by === "tool" || by === "day" || by === "tag"
          ? k.key
          : `${r.owner}/${r.repo}::${k.key}`;
      const b = buckets.get(id);
      if (b) b.reports.push(r);
      else
        buckets.set(id, {
          key: k.key,
          label: k.label,
          owner: r.owner,
          repo: r.repo,
          reports: [r],
          ref: k.ref,
        });
    }
  }

  // Runs per bucket, and the baseline each bucket compares against.
  const allRunsByRepo = new Map<string, RunSummary[]>();
  for (const run of runsOf(inRange)) {
    const k = `${run.owner}/${run.repo}`;
    allRunsByRepo.set(k, [...(allRunsByRepo.get(k) ?? []), run]);
  }
  const defaultBranchFor = (owner: string, repo: string) =>
    input.defaultBranches?.[`${owner}/${repo}`] ??
    input.defaultBranch ??
    defaultBranchOf(allRunsByRepo.get(`${owner}/${repo}`) ?? [], input.refs, { owner, repo });

  const rows: GroupRow[] = [];
  const bucketRuns = new Map<string, RunSummary[]>();
  for (const [id, b] of buckets) bucketRuns.set(id, runsOf(b.reports));

  for (const [id, b] of buckets) {
    const runs = bucketRuns.get(id) ?? [];
    // For a release, the verdict is the run at the tagged commit when there is one.
    const atTag = b.ref?.commit
      ? runs.find((r) => r.commit && b.ref?.commit?.startsWith(r.commit.slice(0, 7)))
      : undefined;
    const latest = atTag ?? runs[0] ?? null;
    const verdict: Verdict = latest === null ? "none" : latest.failed > 0 ? "failed" : "passed";

    let baselineRun: RunSummary | null = null;
    let baselineLabel: string | null = null;
    const previousRun = latest ? (runs.find((r) => r.timestamp < latest.timestamp) ?? null) : null;
    if (by === "release" && b.ref) {
      const mine = [...buckets.values()]
        .filter((o) => o.ref && sameRepo(o, b) && o.ref.timestamp < (b.ref?.timestamp ?? ""))
        .sort((x, y) => (y.ref?.timestamp ?? "").localeCompare(x.ref?.timestamp ?? ""));
      const prev = mine[0];
      if (prev) {
        const prevRuns = runsOf(prev.reports);
        const prevAtTag = prev.ref?.commit
          ? prevRuns.find((r) => r.commit && prev.ref?.commit?.startsWith(r.commit.slice(0, 7)))
          : undefined;
        baselineRun = prevAtTag ?? prevRuns[0] ?? null;
        baselineLabel = prev.key;
      }
    } else if (by === "release" && b.key === "unreleased") {
      const released = [...buckets.values()]
        .filter((o) => o.ref && sameRepo(o, b))
        .sort((x, y) => (y.ref?.timestamp ?? "").localeCompare(x.ref?.timestamp ?? ""));
      const last = released[0];
      if (last) {
        baselineRun = runsOf(last.reports)[0] ?? null;
        baselineLabel = last.key;
      }
    } else if (by === "branch" || by === "pull_request") {
      const base =
        by === "pull_request"
          ? typeof b.ref?.meta.base === "string"
            ? b.ref.meta.base
            : null
          : defaultBranchFor(b.owner, b.repo);
      if (base && base !== b.key) {
        baselineRun =
          (allRunsByRepo.get(`${b.owner}/${b.repo}`) ?? []).find((r) => r.branch === base) ?? null;
        baselineLabel = base;
      } else {
        baselineRun = previousRun;
        baselineLabel = previousRun ? "previous run" : null;
      }
    } else {
      baselineRun = previousRun;
      baselineLabel = previousRun ? "previous run" : null;
    }

    const trend = [...runs]
      .reverse()
      .slice(-trendPoints)
      .map((r) => ({
        runId: r.runId,
        timestamp: r.timestamp,
        passRate: r.passRate,
        failed: r.failed,
      }));
    const facts: string[] = [];
    if (by !== "repo") facts.push(`${b.owner}/${b.repo}`);
    if (latest?.commit && by !== "run") facts.push(latest.commit.slice(0, 7));
    if (latest?.branch && by !== "branch" && by !== "pull_request") facts.push(latest.branch);
    if (b.ref?.kind === "release" && b.ref.meta.prerelease === true) facts.push("pre-release");
    if (by === "pull_request" && typeof b.ref?.meta.base === "string")
      facts.push(`into ${b.ref.meta.base}`);
    const tools = [...new Set(b.reports.map((r) => r.tool))].sort();
    if (by !== "tool") facts.push(tools.join(" · "));

    rows.push({
      by,
      key: b.key,
      label: b.label,
      owner: b.owner,
      repo: b.repo,
      facts,
      verdict,
      latest,
      runs: runs.length,
      trend,
      vsBaseline: latest && baselineRun ? pct(latest.passRate) - pct(baselineRun.passRate) : null,
      baselineLabel,
      baselineRun,
      lastAt: runs[0]?.timestamp ?? "",
      ref: b.ref,
    });
  }

  rows.sort((a, b2) => {
    if (by === "release" && a.ref && b2.ref) return b2.ref.timestamp.localeCompare(a.ref.timestamp);
    if (by === "release" && (a.key === "unreleased") !== (b2.key === "unreleased"))
      return a.key === "unreleased" ? -1 : 1;
    return b2.lastAt.localeCompare(a.lastAt);
  });
  return rows;
}

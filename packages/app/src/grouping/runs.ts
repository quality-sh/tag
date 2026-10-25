// Runs: the reports of one run folded into a single summary, newest first.
import type { ReportLite } from "./report.ts";

export interface TrendPoint {
  readonly runId: string;
  readonly timestamp: string;
  readonly passRate: number;
  readonly failed: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly timestamp: string;
  readonly tools: ReadonlyArray<string>;
  readonly reportIds: ReadonlyArray<string>;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
  readonly duration: number;
  readonly passRate: number;
  readonly buildUrl: string | null;
}

export function summarizeRun(reports: ReadonlyArray<ReportLite>): RunSummary {
  const first = reports[0];
  if (!first) throw new Error("summarizeRun: no reports");
  const sum = (f: (r: ReportLite) => number) => reports.reduce((a, r) => a + f(r), 0);
  const tests = sum((r) => r.tests);
  const passed = sum((r) => r.passed);
  const failed = sum((r) => r.failed);
  const counted = passed + failed;
  const latestTs =
    reports
      .map((r) => r.timestamp)
      .sort()
      .at(-1) ?? first.timestamp;
  return {
    runId: first.runId,
    owner: first.owner,
    repo: first.repo,
    branch: first.branch,
    commit: first.commit,
    timestamp: latestTs,
    tools: [...new Set(reports.map((r) => r.tool))].sort(),
    reportIds: reports.map((r) => r.reportId),
    tests,
    passed,
    failed,
    skipped: sum((r) => r.skipped),
    flaky: sum((r) => r.flaky),
    duration: sum((r) => r.duration),
    passRate: counted === 0 ? 1 : passed / counted,
    buildUrl: first.buildUrl,
  };
}

export const runKey = (r: { owner: string; repo: string; runId: string }) =>
  `${r.owner}/${r.repo}#${r.runId}`;

/** Reports grouped into runs, newest first. */
export function runsOf(reports: ReadonlyArray<ReportLite>): RunSummary[] {
  const byRun = new Map<string, ReportLite[]>();
  for (const r of reports) {
    const k = runKey(r);
    byRun.set(k, [...(byRun.get(k) ?? []), r]);
  }
  return [...byRun.values()]
    .map(summarizeRun)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

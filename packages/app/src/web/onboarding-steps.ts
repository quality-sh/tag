// What the onboarding page shows for each repository, as pure functions of the session, the
// ingest states, the scans and the report counts. No React here, so it is testable alone.
import type { RepoRow, RepoScan, RepositoryState, RunRow, Session } from "./client.ts";

/** One repository's place on the way to its first report, with what it needs next. */
export type RepositoryStep =
  | {
      readonly kind: "reporting";
      readonly owner: string;
      readonly repo: string;
      /** "backfilling, N of M" while history lands, "reporting" once it is in. */
      readonly note: string;
    }
  | { readonly kind: "needs-change"; readonly owner: string; readonly repo: string; scan: RepoScan }
  | { readonly kind: "unsupported"; readonly owner: string; readonly repo: string; scan: RepoScan }
  | { readonly kind: "no-tests"; readonly owner: string; readonly repo: string };

/** "backfilling, N of M"; "new" is a repository still listing its runs, with no total yet. */
export const progressText = (s: RepositoryState) =>
  s.backfillTotal === null ? "backfilling" : `backfilling, ${s.backfillDone} of ${s.backfillTotal}`;

/**
 * The step for one repository. Reports win, as in the scan: a repository that already sent one
 * is reporting whatever its scan said. The scan runs after the backfill, so until it lands the
 * repository counts as reporting and shows its progress.
 */
export const stepOf = (input: {
  readonly owner: string;
  readonly repo: string;
  readonly state: RepositoryState | undefined;
  readonly scan: RepoScan | undefined;
  readonly reports: number;
}): RepositoryStep => {
  const { owner, repo, state, scan, reports } = input;
  const landing = state !== undefined && state.state !== "current";
  if (reports === 0 && !landing && scan) {
    if (scan.classification === "needs-change") return { kind: "needs-change", owner, repo, scan };
    if (scan.classification === "unsupported") return { kind: "unsupported", owner, repo, scan };
    if (scan.classification === "no-tests") return { kind: "no-tests", owner, repo };
  }
  const note = landing
    ? progressText(state)
    : reports > 0 || scan?.classification === "reporting"
      ? "reporting"
      : "looking for tests";
  return { kind: "reporting", owner, repo, note };
};

/** Every repository TAG knows of, by ingest state, scan or report, in name order. */
export const stepsOf = (input: {
  readonly states: ReadonlyArray<RepositoryState>;
  readonly scans: Readonly<Record<string, RepoScan>>;
  readonly repoList: ReadonlyArray<RepoRow>;
}): ReadonlyArray<RepositoryStep> => {
  const names = new Set<string>([
    ...input.states.map((s) => `${s.owner}/${s.repo}`),
    ...Object.keys(input.scans),
    ...input.repoList.map((r) => `${r.owner}/${r.repo}`),
  ]);
  return [...names].sort().map((name) => {
    const [owner = "", repo = ""] = name.split("/");
    return stepOf({
      owner,
      repo,
      state: input.states.find((s) => s.owner === owner && s.repo === repo),
      scan: input.scans[name],
      reports: input.repoList.find((r) => r.owner === owner && r.repo === repo)?.reports ?? 0,
    });
  });
};

/** The first repository with a report, which the page announces. */
export const firstReporting = (repoList: ReadonlyArray<RepoRow>): RepoRow | undefined =>
  repoList.find((r) => r.reports > 0);

/** The report that landed first: the earliest ingested, then the earliest run. */
export const firstReportOf = (runs: ReadonlyArray<RunRow>): RunRow | undefined =>
  [...runs].sort(
    (a, b) => a.ingestedAt.localeCompare(b.ingestedAt) || a.timestamp.localeCompare(b.timestamp),
  )[0];

/**
 * Whether the page should keep asking: until the first report lands, and while a repository
 * is still waiting on its scan, since the scan decides which action it needs.
 */
export const stillWaiting = (
  steps: ReadonlyArray<RepositoryStep>,
  repoList: ReadonlyArray<RepoRow>,
) =>
  firstReporting(repoList) === undefined ||
  steps.some((s) => s.kind === "reporting" && s.note !== "reporting");

/** First load goes to onboarding while the App is not installed or no report has landed. */
export const needsOnboarding = (session: Session, repoList: ReadonlyArray<RepoRow>) =>
  session.installUrl !== undefined || firstReporting(repoList) === undefined;

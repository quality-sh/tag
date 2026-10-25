// The selectors a view takes: the field to group runs by, and the time range to look back.

export const GROUP_BYS = [
  "release",
  "branch",
  "pull_request",
  "environment",
  "tag",
  "tool",
  "workflow",
  "repo",
  "day",
  "run",
] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const isGroupBy = (s: string): s is GroupBy =>
  (GROUP_BYS as ReadonlyArray<string>).includes(s);

export const GROUP_BY_INFO: Record<
  GroupBy,
  { readonly label: string; readonly one: string; readonly lede: string }
> = {
  release: {
    label: "releases",
    one: "release",
    lede: "One row per GitHub release or tag. The verdict is the run at the tagged commit; the trend is every run since the previous tag.",
  },
  branch: {
    label: "branches",
    one: "branch",
    lede: "One row per branch. Compared with the default branch.",
  },
  pull_request: {
    label: "pull requests",
    one: "pull request",
    lede: "One row per pull request with runs. Compared with its base branch.",
  },
  environment: {
    label: "environments",
    one: "environment",
    lede: "One row per test environment a report names. Compared with the run before.",
  },
  tag: {
    label: "tags",
    one: "tag",
    lede: "One row per tag set at upload. A run can be in several.",
  },
  tool: {
    label: "tools",
    one: "tool",
    lede: "One row per test tool: playwright, pytest, deepeval.",
  },
  workflow: { label: "workflows", one: "workflow", lede: "One row per CI workflow." },
  repo: { label: "repositories", one: "repository", lede: "One row per repository." },
  day: { label: "days", one: "day", lede: "One row per day, newest first." },
  run: { label: "runs", one: "run", lede: "Every run, newest first." },
};

/** The range selector: how far back the home page looks. */
export const RANGES = ["1d", "7d", "30d", "90d", "all"] as const;
export type Range = (typeof RANGES)[number];
export const isRange = (s: string): s is Range => (RANGES as ReadonlyArray<string>).includes(s);
export function sinceOf(range: Range, now = new Date()): string | undefined {
  const days = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, all: 0 }[range];
  if (!days) return undefined;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

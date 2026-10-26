// Release groups: repositories that release in lockstep, saved as one record, and the
// release rows that fold their per-repository versions into one row per tag name.
import { Schema } from "effect";
import type { GroupRow, Verdict } from "./compute.ts";
import type { RunSummary, TrendPoint } from "./runs.ts";

/** The only rule a group has today: its members' tags with the same name are one release. */
export const SAME_TAG_NAME = "same tag name";

export const ReleaseGroupInput = Schema.Struct({
  org: Schema.NonEmptyString,
  repositories: Schema.Array(Schema.NonEmptyString),
  rule: Schema.Literal(SAME_TAG_NAME),
});
export interface ReleaseGroupInput extends Schema.Schema.Type<typeof ReleaseGroupInput> {}

export const ReleaseGroup = Schema.Struct({
  id: Schema.NonEmptyString,
  ...ReleaseGroupInput.fields,
  createdAt: Schema.String,
});
export interface ReleaseGroup extends Schema.Schema.Type<typeof ReleaseGroup> {}

// A member with no run at the tag says nothing about the release, so it only decides the
// verdict when no member has one.
const SEVERITY: Record<Verdict, number> = { failed: 2, passed: 1, none: 0 };

const worst = (verdicts: ReadonlyArray<Verdict>): Verdict =>
  verdicts.reduce<Verdict>((a, v) => (SEVERITY[v] > SEVERITY[a] ? v : a), "none");

/** The members' latest runs added up, so the row's figures cover the whole release. */
function combined(members: ReadonlyArray<GroupRow>, repo: string): RunSummary | null {
  const runs = members.flatMap((m) => (m.latest ? [m.latest] : []));
  const first = runs[0];
  if (!first) return null;
  const sum = (f: (r: RunSummary) => number) => runs.reduce((a, r) => a + f(r), 0);
  const passed = sum((r) => r.passed);
  const failed = sum((r) => r.failed);
  return {
    ...first,
    repo,
    timestamp:
      runs
        .map((r) => r.timestamp)
        .sort()
        .at(-1) ?? first.timestamp,
    tools: [...new Set(runs.flatMap((r) => r.tools))].sort(),
    reportIds: runs.flatMap((r) => r.reportIds),
    tests: sum((r) => r.tests),
    passed,
    failed,
    skipped: sum((r) => r.skipped),
    flaky: sum((r) => r.flaky),
    duration: sum((r) => r.duration),
    passRate: passed + failed === 0 ? 1 : passed / (passed + failed),
  };
}

function versionRow(
  group: ReleaseGroup,
  key: string,
  members: ReadonlyArray<GroupRow>,
  trendPoints: number,
): GroupRow {
  const tagged = members
    .flatMap((m) => (m.ref ? [m.ref] : []))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const trend: TrendPoint[] = members
    .flatMap((m) => m.trend)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-trendPoints);
  // The group stands in for the repository, so the table sections it under the members' names.
  const repo = group.repositories.join(" · ");
  return {
    by: "release",
    key,
    label: key,
    owner: group.org,
    repo,
    facts: [],
    verdict: worst(members.map((m) => m.verdict)),
    latest: combined(members, repo),
    runs: members.reduce((a, m) => a + m.runs, 0),
    trend,
    vsBaseline: null,
    baselineLabel: null,
    baselineRun: null,
    lastAt:
      members
        .map((m) => m.lastAt)
        .sort()
        .at(-1) ?? "",
    ref: tagged[0] ?? null,
    members,
  };
}

/**
 * Release rows with each saved group folded in: one row per tag name its members carry,
 * the members underneath. A group applies only when two or more of its repositories are
 * among the rows, so a repository's own page keeps its own rows. Rows outside every group
 * and the "unreleased" rows pass through.
 */
export function lockRows(
  rows: ReadonlyArray<GroupRow>,
  groups: ReadonlyArray<ReleaseGroup>,
  trendPoints = 14,
): GroupRow[] {
  let out = [...rows];
  for (const group of groups) {
    const memberOf = (r: GroupRow) =>
      r.owner === group.org && group.repositories.includes(r.repo) && r.ref !== null;
    const present = new Set(out.filter(memberOf).map((r) => r.repo));
    if (present.size < 2) continue;
    const byVersion = new Map<string, GroupRow[]>();
    for (const r of out.filter(memberOf))
      byVersion.set(r.key, [...(byVersion.get(r.key) ?? []), r]);
    const folded = [...byVersion.entries()].map(([key, members]) =>
      versionRow(
        group,
        key,
        [...members].sort((a, b) => a.repo.localeCompare(b.repo)),
        trendPoints,
      ),
    );
    out = [...out.filter((r) => !memberOf(r)), ...folded];
  }
  return out;
}

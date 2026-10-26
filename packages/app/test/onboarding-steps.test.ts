import { describe, expect, test } from "bun:test";
import type { RepoScan, RepositoryState, RunRow } from "../src/web/client.ts";
import {
  firstReportOf,
  needsOnboarding,
  progressText,
  stepOf,
  stepsOf,
  stillWaiting,
} from "../src/web/onboarding-steps.ts";

const state = (s: Partial<RepositoryState> = {}): RepositoryState => ({
  owner: "acme",
  repo: "widgets",
  state: "current",
  backfillDone: 3,
  backfillTotal: 3,
  ...s,
});

const scan = (classification: RepoScan["classification"]): RepoScan => ({
  owner: "acme",
  repo: "widgets",
  defaultBranch: "main",
  environments: [],
  classification,
  reporting: classification === "reporting" ? ["playwright-report"] : [],
  unread: classification === "unsupported" ? [{ name: "tap-output", format: "tap" }] : [],
  runners:
    classification === "needs-change" ? [{ runner: "vitest", job: "test", command: null }] : [],
  scannedAt: "2026-10-27T10:00:00Z",
});

describe("stepOf", () => {
  type Input = Omit<Parameters<typeof stepOf>[0], "owner" | "repo">;
  const cases: ReadonlyArray<[string, Input, string, string | null]> = [
    [
      "first sight",
      { state: state({ state: "new", backfillTotal: null }), scan: undefined, reports: 0 },
      "reporting",
      "backfilling",
    ],
    [
      "walking history",
      { state: state({ state: "backfilling", backfillDone: 1 }), scan: undefined, reports: 1 },
      "reporting",
      "backfilling, 1 of 3",
    ],
    [
      "backfilling with an old scan",
      {
        state: state({ state: "backfilling", backfillDone: 0 }),
        scan: scan("no-tests"),
        reports: 0,
      },
      "reporting",
      "backfilling, 0 of 3",
    ],
    [
      "caught up, scan pending",
      { state: state(), scan: undefined, reports: 0 },
      "reporting",
      "looking for tests",
    ],
    [
      "caught up with reports",
      { state: state(), scan: undefined, reports: 3 },
      "reporting",
      "reporting",
    ],
    [
      "scan says reporting",
      { state: state(), scan: scan("reporting"), reports: 0 },
      "reporting",
      "reporting",
    ],
    [
      "unclassified scan",
      { state: state(), scan: scan(null), reports: 0 },
      "reporting",
      "looking for tests",
    ],
    [
      "needs a change",
      { state: state(), scan: scan("needs-change"), reports: 0 },
      "needs-change",
      null,
    ],
    [
      "unsupported output",
      { state: state(), scan: scan("unsupported"), reports: 0 },
      "unsupported",
      null,
    ],
    ["no tests", { state: state(), scan: scan("no-tests"), reports: 0 }, "no-tests", null],
    ["no ingest row", { state: undefined, scan: scan("no-tests"), reports: 0 }, "no-tests", null],
    [
      "reports win over the scan",
      { state: state(), scan: scan("needs-change"), reports: 2 },
      "reporting",
      "reporting",
    ],
  ];
  test.each(cases)("%s", (_name, input, kind, note) => {
    const step = stepOf({ owner: "acme", repo: "widgets", ...input });
    expect<string>(step.kind).toBe(kind);
    expect(step.kind === "reporting" ? step.note : null).toBe(note);
  });
});

test("stepsOf lists every repository known by state, scan or report, in name order", () => {
  const steps = stepsOf({
    states: [state({ repo: "zeta", state: "backfilling", backfillDone: 0 })],
    scans: { "acme/beta": { ...scan("no-tests"), repo: "beta" } },
    repoList: [{ owner: "acme", repo: "alpha", reports: 2 }],
  });
  expect(steps.map((s) => [s.repo, s.kind])).toEqual([
    ["alpha", "reporting"],
    ["beta", "no-tests"],
    ["zeta", "reporting"],
  ]);
});

test("progressText says how far the walk is", () => {
  expect(progressText(state({ backfillTotal: null }))).toBe("backfilling");
  expect(progressText(state({ backfillDone: 2, backfillTotal: 5 }))).toBe("backfilling, 2 of 5");
});

const runRow = (reportId: string, ingestedAt: string, timestamp: string): RunRow => ({
  reportId,
  runId: reportId,
  owner: "acme",
  repo: "widgets",
  tool: "playwright",
  toolVersion: null,
  branch: "main",
  commit: null,
  buildUrl: null,
  timestamp,
  tests: 6,
  passed: 4,
  failed: 1,
  skipped: 1,
  pending: 0,
  other: 0,
  flaky: 0,
  duration: 1000,
  artifactId: null,
  artifactName: null,
  adapter: "ctrf",
  ingestedAt,
});

test("firstReportOf picks the earliest ingested report, then the earliest run", () => {
  expect(firstReportOf([])).toBeUndefined();
  const first = firstReportOf([
    runRow("late", "2026-10-27T10:05:00Z", "2026-10-27T09:00:00Z"),
    runRow("newer-run", "2026-10-27T10:00:00Z", "2026-10-26T09:00:00Z"),
    runRow("older-run", "2026-10-27T10:00:00Z", "2026-10-25T09:00:00Z"),
  ]);
  expect(first?.reportId).toBe("older-run");
});

test("stillWaiting holds until a report lands and every scan is in", () => {
  const reporting = stepOf({ owner: "a", repo: "b", state: state(), scan: undefined, reports: 1 });
  const pending = stepOf({ owner: "a", repo: "c", state: state(), scan: undefined, reports: 0 });
  const quiet = stepOf({
    owner: "a",
    repo: "d",
    state: state(),
    scan: scan("no-tests"),
    reports: 0,
  });
  const one = [{ owner: "a", repo: "b", reports: 1 }];
  expect(stillWaiting([quiet], [])).toBe(true);
  expect(stillWaiting([reporting, pending], one)).toBe(true);
  expect(stillWaiting([reporting, quiet], one)).toBe(false);
});

test("needsOnboarding while the App is not installed or no report has landed", () => {
  const one = [{ owner: "acme", repo: "widgets", reports: 1 }];
  const signedIn = { authenticated: true, authRequired: true };
  expect(needsOnboarding({ ...signedIn, installUrl: "/api/install" }, one)).toBe(true);
  expect(needsOnboarding(signedIn, [])).toBe(true);
  expect(needsOnboarding(signedIn, [{ owner: "acme", repo: "widgets", reports: 0 }])).toBe(true);
  expect(needsOnboarding(signedIn, one)).toBe(false);
});

// The lockstep detector and the release-group rows, on synthetic refs and reports.
import { describe, expect, test } from "bun:test";
import {
  computeGroups,
  suggestFor,
  type Ref,
  type ReleaseGroup,
  type ReportLite,
} from "../src/grouping.ts";

const tag = (repo: string, key: string, timestamp: string, commit: string | null = null): Ref => ({
  kind: "release",
  key,
  owner: "acme",
  repo,
  commit,
  branch: "main",
  timestamp,
  title: null,
  url: null,
  meta: {},
});

const report = (p: Partial<ReportLite> & { reportId: string; repo: string }): ReportLite => ({
  runId: p.reportId,
  owner: "acme",
  tool: "playwright",
  branch: "main",
  commit: null,
  workflow: "tests",
  environment: null,
  tags: [],
  timestamp: "2026-10-20T09:00:00Z",
  tests: 10,
  passed: 10,
  failed: 0,
  skipped: 0,
  flaky: 0,
  duration: 1000,
  buildUrl: null,
  ...p,
});

// api and web cut v1.3.2 and v1.4.0 within hours of each other; cli tags on its own,
// once with a shared name a week after the others.
const refs: Ref[] = [
  tag("api", "v1.3.2", "2026-10-01T10:00:00Z", "aaa1111"),
  tag("web", "v1.3.2", "2026-10-01T18:00:00Z", "bbb1111"),
  tag("api", "v1.4.0", "2026-10-10T10:00:00Z", "aaa2222"),
  tag("web", "v1.4.0", "2026-10-11T09:00:00Z", "bbb2222"),
  tag("cli", "v0.9.0", "2026-10-03T10:00:00Z"),
  tag("cli", "v1.4.0", "2026-10-17T10:00:00Z"),
  tag("cli", "nightly", "2026-10-20T10:00:00Z"),
];

const releaseGroupsOf = (input: Parameters<typeof suggestFor>[0]) =>
  suggestFor(input).filter((s) => s.kind === "release-group");

describe("lockstep release groups", () => {
  test("groups repositories that tag the same names within a day, never one on its own cadence", () => {
    const found = releaseGroupsOf({ org: "acme", refs, reports: [] });
    expect(found).toHaveLength(1);
    expect(found[0]?.save).toEqual({
      _tag: "release-group",
      org: "acme",
      repositories: ["api", "web"],
      rule: "same tag name",
    });
    expect(found[0]?.sentence).toContain("api and web");
  });

  test("the id is a hash of the kind and members, stable until they change", () => {
    const once = releaseGroupsOf({ org: "acme", refs, reports: [] })[0]?.id;
    const again = releaseGroupsOf({ org: "acme", refs: [...refs].reverse(), reports: [] })[0]?.id;
    expect(once).toBe(again);
    expect(once).toStartWith("release-group-");
    // A third lockstep member changes the group, so the id moves too.
    const docs = [
      tag("docs", "v1.3.2", "2026-10-01T12:00:00Z"),
      tag("docs", "v1.4.0", "2026-10-10T12:00:00Z"),
    ];
    const wider = releaseGroupsOf({ org: "acme", refs: [...refs, ...docs], reports: [] });
    expect(wider[0]?.save).toMatchObject({ repositories: ["api", "docs", "web"] });
    expect(wider[0]?.id).not.toBe(once);
  });

  test("a single shared tag, or one far apart, is not lockstep", () => {
    const single = [
      tag("a", "v1.0.0", "2026-10-01T10:00:00Z"),
      tag("b", "v1.0.0", "2026-10-01T11:00:00Z"),
    ];
    expect(releaseGroupsOf({ org: "acme", refs: single, reports: [] })).toEqual([]);
    const apart = [
      tag("a", "v1.0.0", "2026-10-01T10:00:00Z"),
      tag("b", "v1.0.0", "2026-10-03T10:00:00Z"),
      tag("a", "v1.1.0", "2026-10-05T10:00:00Z"),
      tag("b", "v1.1.0", "2026-10-07T10:00:00Z"),
    ];
    expect(releaseGroupsOf({ org: "acme", refs: apart, reports: [] })).toEqual([]);
  });

  test("most recent tags must be shared on both sides", () => {
    // b shares both of a's tags, but four of its six recent tags are its own.
    const solo = ["v2.0.1", "v2.0.2", "v2.0.3", "v2.0.4"].map((k, i) =>
      tag("b", k, `2026-10-2${i}T10:00:00Z`),
    );
    const mixed = [
      tag("a", "v2.0.0", "2026-10-01T10:00:00Z"),
      tag("b", "v2.0.0", "2026-10-01T11:00:00Z"),
      tag("a", "v2.1.0", "2026-10-10T10:00:00Z"),
      tag("b", "v2.1.0", "2026-10-10T11:00:00Z"),
      ...solo,
    ];
    expect(releaseGroupsOf({ org: "acme", refs: mixed, reports: [] })).toEqual([]);
  });

  test("a saved group or another org's refs are not suggested", () => {
    const saved: ReleaseGroup = {
      id: "g",
      org: "acme",
      repositories: ["web", "api"],
      rule: "same tag name",
      createdAt: "2026-10-01T00:00:00Z",
    };
    expect(releaseGroupsOf({ org: "acme", refs, reports: [], releaseGroups: [saved] })).toEqual([]);
    expect(releaseGroupsOf({ org: "other", refs, reports: [] })).toEqual([]);
  });
});

describe("collection suggestions", () => {
  const reports = [
    report({ reportId: "1", repo: "api", environment: "production" }),
    report({ reportId: "2", repo: "web", environment: "prod-eu", failed: 1, passed: 9 }),
    report({ reportId: "3", repo: "web", environment: "preprod" }),
    report({ reportId: "4", repo: "api", tags: ["event:schedule"], workflow: "nightly" }),
    report({ reportId: "5", repo: "cli", branch: "trunk" }),
  ];
  const collections = (extra: Partial<Parameters<typeof suggestFor>[0]> = {}) =>
    Object.fromEntries(
      suggestFor({ org: "acme", refs, reports, ...extra })
        .filter((s) => s.save._tag === "collection")
        .map((s) => [s.kind, s.save._tag === "collection" ? s.save.query : ""]),
    );

  test("production environments, semver tags, scheduled runs and default-branch failures", () => {
    expect(collections()).toEqual({
      production: "org:acme environment:prod-eu,production",
      semver: "org:acme release:v0.9.0,v1.3.2,v1.4.0",
      scheduled: "org:acme tag:event:schedule",
      "failing-default": "org:acme branch:main,trunk failed:>0",
    });
  });

  test("a scan's default branch wins over the guess, and a saved query is not suggested again", () => {
    const found = collections({
      defaultBranches: { "acme/cli": "main" },
      collections: [
        {
          id: "prod",
          name: "prod",
          description: "",
          query: "org:acme environment:prod-eu,production",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
    expect(found["failing-default"]).toBe("org:acme branch:main failed:>0");
    expect(found.production).toBeUndefined();
  });

  test("one repository is not an org-wide view, and nothing matches nothing", () => {
    const one = suggestFor({
      org: "acme",
      refs: [],
      reports: [report({ reportId: "1", repo: "api" })],
    });
    expect(one).toEqual([]);
  });
});

describe("release rows with a saved group", () => {
  const group: ReleaseGroup = {
    id: "g",
    org: "acme",
    repositories: ["api", "web"],
    rule: "same tag name",
    createdAt: "2026-10-01T00:00:00Z",
  };
  const reports = [
    report({ reportId: "a1", repo: "api", commit: "aaa1111", timestamp: "2026-10-01T09:00:00Z" }),
    report({ reportId: "w1", repo: "web", commit: "bbb1111", timestamp: "2026-10-01T17:00:00Z" }),
    report({ reportId: "a2", repo: "api", commit: "aaa2222", timestamp: "2026-10-10T09:00:00Z" }),
    report({
      reportId: "w2",
      repo: "web",
      commit: "bbb2222",
      timestamp: "2026-10-11T08:00:00Z",
      failed: 2,
      passed: 8,
    }),
    report({ reportId: "c1", repo: "cli", timestamp: "2026-10-16T08:00:00Z" }),
  ];

  test("one row per version with each member's verdict underneath, the worst one on top", () => {
    const rows = computeGroups({
      reports,
      refs,
      by: "release",
      filters: [],
      releaseGroups: [group],
    });
    const versions = rows.filter((r) => r.members);
    expect(versions.map((r) => r.key)).toEqual(["v1.4.0", "v1.3.2"]);
    const [v140, v132] = versions;
    expect(v140?.verdict).toBe("failed");
    expect(v140?.members?.map((m) => [m.repo, m.verdict])).toEqual([
      ["api", "passed"],
      ["web", "failed"],
    ]);
    expect(v140?.latest).toMatchObject({ tests: 20, passed: 18, failed: 2 });
    expect(v132?.verdict).toBe("passed");
    expect(v132?.runs).toBe(2);
    // cli is outside the group and keeps its own rows.
    expect(rows.filter((r) => !r.members).every((r) => r.repo === "cli")).toBe(true);
    expect(rows.some((r) => r.repo === "cli" && r.key === "v1.4.0")).toBe(true);
  });

  test("a repository's own page keeps its own rows", () => {
    const rows = computeGroups({
      reports: reports.filter((r) => r.repo === "api"),
      refs,
      by: "release",
      filters: [],
      releaseGroups: [group],
    });
    expect(rows.some((r) => r.members)).toBe(false);
  });

  test("a version only one member ran still gets its row, and no runs means no rows", () => {
    const rows = computeGroups({
      reports: reports.filter((r) => r.reportId !== "w2"),
      refs,
      by: "release",
      filters: [],
      releaseGroups: [group],
    });
    const v140 = rows.find((r) => r.members && r.key === "v1.4.0");
    expect(v140?.members?.map((m) => m.repo)).toEqual(["api"]);
    expect(v140?.verdict).toBe("passed");
    const empty = computeGroups({
      reports: [],
      refs,
      by: "release",
      filters: [],
      releaseGroups: [group],
    });
    expect(empty).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  assign,
  chipOf,
  computeGroups,
  formatQuery,
  indexValues,
  parseQuery,
  suggest,
  type ReportLite,
  type Ref,
} from "../src/grouping.ts";

const report = (p: Partial<ReportLite> & { reportId: string; runId: string }): ReportLite => ({
  owner: "acme",
  repo: "widgets",
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

const ref = (p: Partial<Ref> & { kind: Ref["kind"]; key: string; timestamp: string }): Ref => ({
  owner: "acme",
  repo: "widgets",
  commit: null,
  branch: null,
  title: null,
  url: null,
  meta: {},
  ...p,
});

const reports: ReportLite[] = [
  report({ reportId: "a", runId: "1", commit: "a1b2c3d", timestamp: "2026-10-20T09:00:00Z" }),
  report({ reportId: "b", runId: "1", commit: "a1b2c3d", tool: "pytest", failed: 1, passed: 9 }),
  report({
    reportId: "c",
    runId: "2",
    commit: "e4f5a6b",
    timestamp: "2026-10-22T14:00:00Z",
    tags: ["smoke"],
    environment: "production",
  }),
  report({
    reportId: "d",
    runId: "3",
    commit: "c0ffee1",
    branch: "feat/x",
    timestamp: "2026-10-23T08:00:00Z",
    failed: 2,
    passed: 8,
  }),
  report({ reportId: "e", runId: "4", commit: "f00baa1", timestamp: "2026-10-23T09:00:00Z" }),
];
const refs: Ref[] = [
  ref({
    kind: "release",
    key: "v1",
    commit: "a1b2c3d",
    branch: "main",
    timestamp: "2026-10-20T10:00:00Z",
  }),
  ref({
    kind: "release",
    key: "v2",
    commit: "e4f5a6b",
    branch: "main",
    timestamp: "2026-10-22T15:00:00Z",
  }),
  ref({
    kind: "pull_request",
    key: "#7",
    branch: "feat/x",
    timestamp: "2026-10-23T07:00:00Z",
    meta: { base: "main" },
  }),
];

describe("query grammar", () => {
  test("parses fields, negation, ranges, lists and free text", () => {
    const f = parseQuery(
      'repo:acme/widgets -tag:slow failed:>0 env:staging,production "flaky login"',
    );
    expect(f).toEqual([
      { field: "repo", op: "is", value: "acme/widgets" },
      { field: "tag", op: "not", value: "slow" },
      { field: "failed", op: "gt", value: "0" },
      {
        field: "environment",
        op: "in",
        value: "staging,production",
        values: ["staging", "production"],
      },
      { field: "text", op: "contains", value: "flaky login" },
    ]);
    expect(formatQuery(f)).toBe(
      'repo:acme/widgets -tag:slow failed:>0 environment:staging,production "flaky login"',
    );
    expect(chipOf(f[2]!)).toEqual({ field: "failed", value: "> 0" });
  });
});

describe("assign", () => {
  test("tagged commit -> that release; main after the last tag -> unreleased; a branch -> no release", () => {
    expect(assign(reports[0]!, refs).release).toMatchObject({ key: "v1" });
    expect(assign(reports[2]!, refs).release).toMatchObject({ key: "v2" });
    expect(assign(reports[4]!, refs).release).toBe("unreleased");
    const pr = assign(reports[3]!, refs);
    expect(pr.release).toBeNull();
    expect(pr.pullRequest).toMatchObject({ key: "#7" });
  });
});

describe("computeGroups", () => {
  test("by release: newest first, verdict at the tagged commit, compared with the previous release", () => {
    const rows = computeGroups({ reports, refs, by: "release", filters: [] });
    expect(rows.map((r) => r.key)).toEqual(["unreleased", "v2", "v1"]);
    const v2 = rows[1]!;
    expect(v2.verdict).toBe("passed");
    expect(v2.baselineLabel).toBe("v1");
    expect(v2.vsBaseline).toBeCloseTo(5, 5);
    expect(rows[2]!.verdict).toBe("failed");
    expect(rows[0]!.baselineLabel).toBe("v2");
  });
  test("by branch: a feature branch is compared with main", () => {
    const rows = computeGroups({ reports, refs, by: "branch", filters: [] });
    const feat = rows.find((r) => r.key === "feat/x")!;
    expect(feat.baselineLabel).toBe("main");
    expect(feat.vsBaseline).toBeCloseTo(-20, 5);
  });
  test("filters apply before grouping", () => {
    const rows = computeGroups({ reports, refs, by: "tool", filters: parseQuery("failed:>0") });
    expect(rows.map((r) => r.key).sort()).toEqual(["playwright", "pytest"]);
    expect(rows.find((r) => r.key === "playwright")!.runs).toBe(1);
  });
});

describe("suggest", () => {
  test("offers fields, then values with counts, then text search", () => {
    const idx = indexValues(reports, refs);
    const s = suggest(idx, "env");
    expect(s[0]).toMatchObject({ kind: "field", field: "environment", token: "environment:" });
    expect(s.at(-1)).toMatchObject({ kind: "text", value: "env" });
    const v = suggest(idx, "release:v");
    expect(v.map((x) => x.token)).toEqual(["release:v1", "release:v2"]);
  });
});

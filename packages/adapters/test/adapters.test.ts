import { describe, expect, test } from "bun:test";
import { validateReport, metricsOf, artifactsOf } from "@quality-sh/verdict-schema";
import { runAdapters, deepevalAdapter, junitAdapter, adapters } from "../src/index.ts";
import { filesFromDir, ctx, FIXTURES } from "./helpers.ts";

describe("deepeval adapter", () => {
  test("converts .latest_test_run.json into valid CTRF with metrics", async () => {
    const files = await filesFromDir(`${FIXTURES}acme/widgets/run-1001/deepeval-results`);
    expect(deepevalAdapter.detect(files.map((f) => f.path))).toBe(true);
    const [report] = await deepevalAdapter.parse({ files, context: ctx("deepeval-results") });
    expect(report).toBeDefined();
    const v = validateReport(report);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const r = v.report;
    expect(r.results.tool.name).toBe("deepeval");
    expect(r.results.summary.tests).toBe(6);
    expect(r.results.summary.passed + r.results.summary.failed + r.results.summary.other).toBe(6);
    const failing = r.results.tests.find((t) => t.name === "handles unknown product");
    expect(failing?.status).toBe("failed");
    expect(failing?.message).toContain("Faithfulness");
    const metrics = metricsOf(failing!);
    expect(metrics.map((m) => m.name)).toEqual([
      "Answer Relevancy",
      "Faithfulness",
      "Hallucination",
    ]);
    expect(metrics.find((m) => m.name === "Hallucination")?.comparator).toBe("<=");
    expect(r.results.environment?.repositoryName).toBe("acme/widgets");
    expect(artifactsOf(r)[0]?.kind).toBe("deepeval-json");
  });
});

describe("junit adapter", () => {
  test("converts pytest junit xml", async () => {
    const files = await filesFromDir(`${FIXTURES}acme/widgets/run-1002/junit-results`);
    const [report] = await junitAdapter.parse({ files, context: ctx("junit-results", "run-1002") });
    const v = validateReport(report);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.report.results.tool.name).toBe("pytest");
    expect(v.report.results.summary).toMatchObject({ tests: 6, failed: 1, skipped: 1, passed: 4 });
    const failed = v.report.results.tests.find((t) => t.status === "failed");
    expect(failed?.name).toBe("test_oversell_blocked");
    expect(failed?.suite).toEqual(["pytest", "tests", "test_inventory"]);
    expect(failed?.trace).toContain("AssertionError");
    expect(failed?.filePath).toBe("tests/test_inventory.py");
  });
  test("ignores non-junit xml", async () => {
    const files = [
      {
        path: "results.xml",
        size: 10,
        text: async () => "<pom/>",
        bytes: async () => new Uint8Array(),
      },
    ];
    expect(await junitAdapter.parse({ files, context: ctx("x") })).toEqual([]);
  });
});

describe("runAdapters", () => {
  test("assigns testId and reportId, and is deterministic", async () => {
    const files = await filesFromDir(`${FIXTURES}acme/widgets/run-1001/deepeval-results`);
    const a = await runAdapters({ files, context: ctx("deepeval-results") });
    const b = await runAdapters({ files, context: ctx("deepeval-results") });
    expect(a).toHaveLength(1);
    expect(a[0]!.adapter).toBe("deepeval");
    const ra = a[0]!.reports[0]!;
    const rb = b[0]!.reports[0]!;
    expect(ra.reportId).toBe(rb.reportId);
    expect(ra.results.tests.every((t) => t.testId)).toBe(true);
    expect(ra.results.tests.map((t) => t.testId)).toEqual(rb.results.tests.map((t) => t.testId));
  });
  test("dispatch order is ctrf first", () => {
    expect(adapters[0]!.name).toBe("ctrf");
  });
});

describe("ctrf adapter with a real playwright-ctrf-json-reporter artifact", () => {
  test("validates, keeps reporter testIds, and sweeps in the HTML report reference", async () => {
    const files = await filesFromDir(`${FIXTURES}acme/widgets/run-1001/playwright-report`);
    const runs = await runAdapters({ files, context: ctx("playwright-report") });
    expect(runs.map((r) => r.adapter)).toEqual(["ctrf"]); // playwright JSON fallback must be skipped
    const report = runs[0]!.reports[0]!;
    expect(report.results.summary).toMatchObject({ tests: 6, passed: 4, failed: 1, skipped: 1 });
    expect(report.results.tests.every((t) => t.testId && t.testId.length > 16)).toBe(true);
    expect(report.results.environment?.repositoryName).toBe("acme/widgets");
    const arts = artifactsOf(report);
    expect(arts.find((a) => a.kind === "playwright-html")?.path).toBe("index.html");
  });
});

describe("playwright json fallback adapter", () => {
  test("converts results.json when no CTRF file is present", async () => {
    const all = await filesFromDir(`${FIXTURES}acme/widgets/run-1001/playwright-report`);
    const files = all.filter((f) => !f.path.endsWith("ctrf-report.json"));
    const runs = await runAdapters({ files, context: ctx("playwright-report") });
    expect(runs.map((r) => r.adapter)).toEqual(["playwright"]);
    const report = runs[0]!.reports[0]!;
    const v = validateReport(report);
    expect(v.ok).toBe(true);
    expect(report.results.summary).toMatchObject({ tests: 6, passed: 4, failed: 1, skipped: 1 });
    const failed = report.results.tests.find((t) => t.status === "failed")!;
    expect(failed.name).toBe("applies a discount code");
    expect(failed.retries).toBe(1);
    expect(failed.retryAttempts?.length).toBe(1);
    expect(failed.message).toContain("expect");
    expect(artifactsOf(report).map((a) => a.kind)).toEqual(["playwright-html", "playwright-json"]);
  });
});

describe("cross-check against the official ctrf SDK validator", () => {
  test("every adapter output is valid CTRF per ctrf@0.5", async () => {
    const { validate } = await import("ctrf");
    const cases = [
      ["deepeval-results", "run-1001"],
      ["junit-results", "run-1002"],
      ["playwright-report", "run-1001"],
    ] as const;
    for (const [artifact, runId] of cases) {
      const files = await filesFromDir(`${FIXTURES}acme/widgets/${runId}/${artifact}`);
      const runs = await runAdapters({ files, context: ctx(artifact, runId) });
      for (const { adapter, reports } of runs) {
        for (const report of reports) {
          const r = validate(JSON.parse(JSON.stringify(report)));
          expect({ adapter, valid: r.valid, errors: r.errors }).toEqual({
            adapter,
            valid: true,
            errors: r.valid ? r.errors : [],
          });
        }
      }
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  validateReport,
  testId,
  withIdentity,
  metricsOf,
  withMetrics,
  type CtrfReport,
} from "../src/index.ts";

const minimal: CtrfReport = {
  reportFormat: "CTRF",
  specVersion: "0.2.0",
  runId: "run-1",
  results: {
    tool: { name: "demo" },
    summary: {
      tests: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      pending: 0,
      other: 0,
      start: 1,
      stop: 2,
    },
    tests: [{ name: "a", status: "passed", duration: 1, filePath: "x.spec.ts", suite: ["s"] }],
  },
};

describe("validateReport", () => {
  test("accepts a minimal report", () => {
    expect(validateReport(minimal).ok).toBe(true);
  });
  test("rejects unknown fields outside extra", () => {
    const r = validateReport({ ...minimal, bogus: 1 });
    expect(r.ok).toBe(false);
  });
  test("accepts anything inside extra", () => {
    const r = validateReport({ ...minimal, extra: { "acme.thing": { deep: [1, 2] } } });
    expect(r.ok).toBe(true);
  });
});

describe("identity", () => {
  test("testId is stable and ignores order of parameters", () => {
    const a = testId("t", { name: "n", status: "passed", duration: 0, parameters: { x: 1, y: 2 } });
    const b = testId("t", { name: "n", status: "passed", duration: 0, parameters: { y: 2, x: 1 } });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });
  test("testId changes with suite", () => {
    const a = testId("t", { name: "n", status: "passed", duration: 0, suite: ["a"] });
    const b = testId("t", { name: "n", status: "passed", duration: 0, suite: ["b"] });
    expect(a).not.toBe(b);
  });
  test("withIdentity keeps an adapter-provided testId", () => {
    const r = withIdentity({
      ...minimal,
      results: { ...minimal.results, tests: [{ ...minimal.results.tests[0]!, testId: "keep" }] },
    });
    expect(r.results.tests[0]!.testId).toBe("keep");
    expect(r.reportId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("metrics convention", () => {
  test("round trips", () => {
    const t = withMetrics(minimal.results.tests[0]!, [
      { name: "m", value: 0.5, threshold: 0.4, passed: true },
    ]);
    expect(metricsOf(t)).toEqual([{ name: "m", value: 0.5, threshold: 0.4, passed: true }]);
  });
  test("ignores malformed entries", () => {
    const t = { ...minimal.results.tests[0]!, extra: { "tag.metrics": [{ nope: 1 }] } };
    expect(metricsOf(t)).toEqual([]);
  });
});

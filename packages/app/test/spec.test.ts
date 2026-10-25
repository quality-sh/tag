import { describe, expect, test } from "bun:test";
import { SPEC, deepEvalData, spec } from "../src/web/deepeval-spec.ts";
import { decodeSpec, resolve } from "../src/web/spec.ts";
import type { ReportDetail } from "../src/web/client.ts";

const detail: ReportDetail = {
  run: {
    reportId: "r1",
    runId: "run-1002",
    owner: "acme",
    repo: "widgets",
    tool: "deepeval",
    toolVersion: null,
    branch: "main",
    commit: "e4f5a6b",
    buildUrl: null,
    timestamp: "2026-10-22T10:00:00Z",
    tests: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    pending: 0,
    other: 0,
    flaky: 0,
    duration: 3000,
    artifactId: null,
    artifactName: null,
    adapter: "deepeval",
    ingestedAt: "2026-10-22T10:01:00Z",
  },
  tests: [
    {
      reportId: "r1",
      runId: "run-1002",
      testId: "t-ok",
      name: "answers politely",
      status: "passed",
      duration: 1200,
      filePath: null,
      suite: null,
      flaky: 0,
      retries: 0,
      message: null,
      timestamp: "2026-10-22T10:00:00Z",
      branch: "main",
      tool: "deepeval",
    },
    {
      reportId: "r1",
      runId: "run-1002",
      testId: "t-bad",
      name: "cites the source",
      status: "failed",
      duration: 1800,
      filePath: null,
      suite: null,
      flaky: 0,
      retries: 0,
      message: "below threshold",
      timestamp: "2026-10-22T10:00:00Z",
      branch: "main",
      tool: "deepeval",
    },
  ],
  metrics: [
    {
      reportId: "r1",
      testId: "t-ok",
      name: "Faithfulness",
      value: 0.9,
      threshold: 0.7,
      comparator: ">=",
      passed: 1,
    },
    {
      reportId: "r1",
      testId: "t-bad",
      name: "Faithfulness",
      value: 0.4,
      threshold: 0.7,
      comparator: ">=",
      passed: 0,
    },
  ],
  artifacts: [],
  siblings: [],
  report: {
    results: {
      tests: [
        {
          name: "cites the source",
          status: "failed",
          duration: 1800,
          testId: "t-bad",
          extra: {
            "deepeval.io": { input: "Who wrote it?", actualOutput: "Nobody." },
            "deepeval.metricsData": [
              { name: "Faithfulness", reason: "The answer names no source." },
            ],
          },
        },
      ],
      extra: { deepeval: { hyperparameters: { model: "gpt-x", temperature: 0 } } },
    },
  },
  artifactRefs: [],
};

describe("JSON Render spike", () => {
  test("a spec validates against the catalog", () => {
    const ok = decodeSpec({
      root: "a",
      elements: { a: { type: "message", props: { text: "hi" } } },
    });
    expect(ok._tag).toBe("Success");
    const bad = decodeSpec({ root: "a", elements: { a: { type: "carousel" } } });
    expect(bad._tag).toBe("Failure");
  });

  test("bindings and each resolve against the data, failed cases first", () => {
    const data = deepEvalData(detail, (id) => `#/test/acme/widgets/${id}`);
    expect(data.metricCount).toBe("1 metric");
    expect(data.averages).toEqual([
      {
        key: "Faithfulness",
        label: "Faithfulness",
        value: "0.65",
        unit: "mean",
        note: "1 below threshold",
        tone: "failed",
      },
    ]);
    expect(data.hyperparameters).toEqual(["model gpt-x", "temperature 0"]);
    expect(data.cases.map((c) => c.testId)).toEqual(["t-bad", "t-ok"]);
    expect(data.cases[0]?.metrics[0]?.reason).toBe("The answer names no source.");
    expect(data.cases[0]?.fields).toEqual([
      { label: "Input", value: "Who wrote it?" },
      { label: "Actual output", value: "Nobody." },
    ]);
  });

  test("the DeepEval spec validates and every bound path exists in the data", () => {
    expect(spec).not.toBeNull();
    const data = deepEvalData(detail, (id) => id);
    const scope = { ...data, case: data.cases[0], m: data.cases[0]?.metrics[0] };
    const paths: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v !== "object" || v === null) return;
      if ("$" in v && typeof v.$ === "string") paths.push(v.$);
      else for (const x of Object.values(v)) walk(x);
    };
    walk(SPEC);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) expect(resolve({ $: p }, scope)).not.toBeUndefined();
    expect(data.cases[0]?.href).toBe("t-bad");
  });

  test("bindings resolve nested paths and leave plain values alone", () => {
    const scope = { a: { b: [1, 2] }, s: "x" };
    expect(resolve({ $: "a.b" }, scope)).toEqual([1, 2]);
    expect(resolve({ $: "a.missing.deeper" }, scope)).toBeUndefined();
    expect(resolve({ items: [{ $: "s" }, "lit", 3] }, scope)).toEqual({ items: ["x", "lit", 3] });
  });
});

// DeepEval -> CTRF.
// Input: `.latest_test_run.json` ({ testRunData: TestRun }) or `test_run_*.json` (TestRun).
// Keys are camelCase (pydantic by_alias), None fields omitted.
import {
  CTRF_SPEC_VERSION,
  withMetrics,
  type CtrfReport,
  type CtrfTest,
  type VerdictMetric,
  type Mutable,
} from "@quality-sh/verdict-schema";
import { basename, environmentFrom, type Adapter, type AdapterInput } from "./types.ts";

interface MetricData {
  name: string;
  score?: number | null;
  threshold?: number;
  success?: boolean;
  reason?: string;
  error?: string;
  strictMode?: boolean;
  evaluationModel?: string;
  evaluationCost?: number;
}
interface TestCase {
  name: string;
  success: boolean;
  metricsData?: MetricData[];
  runDuration?: number;
  evaluationCost?: number;
  input?: string;
  actualOutput?: string;
  expectedOutput?: string;
  context?: string[];
  retrievalContext?: string[];
  tags?: string[];
  order?: number;
  metadata?: unknown;
}
interface TestRun {
  testFile?: string;
  testCases?: TestCase[];
  conversationalTestCases?: TestCase[];
  metricsScores?: unknown[];
  identifier?: string;
  hyperparameters?: Record<string, unknown>;
  testPassed?: number;
  testFailed?: number;
  runDuration?: number;
  evaluationCost?: number;
  datasetAlias?: string;
}

const isCandidate = (p: string) => {
  const b = basename(p);
  return (
    b === ".latest_test_run.json" ||
    b === ".latest_run_full.json" ||
    /^test_run_\d{8}_\d{6}\.json$/.test(b)
  );
};

function unwrap(parsed: unknown): TestRun | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.testRunData && typeof o.testRunData === "object") return o.testRunData;
  if (Array.isArray(o.testCases) || Array.isArray(o.conversationalTestCases)) return o;
  return null;
}

/** Metrics named like "hallucination" or "toxicity" pass when the score is at or below the threshold. */
const LOWER_IS_BETTER = /hallucination|toxicity|bias/i;

function toMetric(m: MetricData): VerdictMetric {
  const out: Mutable<VerdictMetric> = {
    name: m.name,
    value: typeof m.score === "number" ? m.score : null,
  };
  if (typeof m.threshold === "number") {
    out.threshold = m.threshold;
    out.comparator = LOWER_IS_BETTER.test(m.name) ? "<=" : ">=";
  }
  if (typeof m.success === "boolean") out.passed = m.success;
  if (m.reason) out.reason = m.reason;
  if (m.error) out.error = m.error;
  return out;
}

export function convertDeepEval(
  run: TestRun,
  ctx: AdapterInput["context"],
  sourcePath: string,
): CtrfReport {
  const cases = [...(run.testCases ?? []), ...(run.conversationalTestCases ?? [])];
  const startMs = ctx.timestamp ? Date.parse(ctx.timestamp) : Date.now();
  let cursor = startMs;
  const tests: CtrfTest[] = cases.map((tc, i) => {
    const durationMs = Math.round((tc.runDuration ?? 0) * 1000);
    const metrics = (tc.metricsData ?? []).map(toMetric);
    const failing = metrics.filter((m) => m.passed === false);
    const errored = (tc.metricsData ?? []).filter((m) => m.error);
    const base: CtrfTest = {
      name: tc.name || `case-${i}`,
      status: errored.length > 0 && !tc.success ? "other" : tc.success ? "passed" : "failed",
      duration: durationMs,
      start: cursor,
      stop: cursor + durationMs,
      // Never put the run identifier here: it is often per-run and would change the stable testId.
      suite: [run.testFile ?? "deepeval"],
      ...(run.testFile ? { filePath: run.testFile } : {}),
      ...(tc.tags && tc.tags.length ? { tags: tc.tags } : {}),
      ...(failing.length
        ? {
            message: failing
              .map(
                (m) =>
                  `${m.name}: ${m.value ?? "n/a"} ${m.comparator ?? ">="} ${m.threshold ?? "?"} failed${m.reason ? ` — ${m.reason}` : ""}`,
              )
              .join("\n"),
          }
        : {}),
      rawStatus: tc.success ? "success" : "failure",
      extra: {
        "deepeval.metricsData": tc.metricsData ?? [],
        "deepeval.io": {
          input: tc.input,
          actualOutput: tc.actualOutput,
          expectedOutput: tc.expectedOutput,
          context: tc.context,
          retrievalContext: tc.retrievalContext,
        },
        ...(typeof tc.evaluationCost === "number"
          ? { "deepeval.evaluationCost": tc.evaluationCost }
          : {}),
      },
    };
    cursor += durationMs;
    return withMetrics(base, metrics);
  });

  const count = (s: CtrfTest["status"]) => tests.filter((t) => t.status === s).length;
  const stop = startMs + Math.round((run.runDuration ?? 0) * 1000);
  return {
    reportFormat: "CTRF",
    specVersion: CTRF_SPEC_VERSION,
    runId: ctx.runId,
    timestamp: new Date(startMs).toISOString(),
    generatedBy: "verdict-adapter-deepeval",
    results: {
      tool: { name: "deepeval" },
      summary: {
        tests: tests.length,
        passed: count("passed"),
        failed: count("failed"),
        skipped: 0,
        pending: 0,
        other: count("other"),
        start: startMs,
        stop: Math.max(stop, cursor),
        duration: Math.max(stop, cursor) - startMs,
      },
      tests,
      environment: { ...environmentFrom(ctx), reportName: run.identifier ?? "deepeval" },
      extra: {
        deepeval: {
          identifier: run.identifier,
          hyperparameters: run.hyperparameters,
          evaluationCost: run.evaluationCost,
          datasetAlias: run.datasetAlias,
          testPassed: run.testPassed,
          testFailed: run.testFailed,
        },
        "deepeval.metricsScores": run.metricsScores ?? [],
        "verdict.artifacts": [
          {
            kind: "deepeval-json",
            name: "DeepEval results",
            path: sourcePath,
            contentType: "application/json",
          },
        ],
      },
    },
  };
}

export const deepevalAdapter: Adapter = {
  name: "deepeval",
  version: "0.1.0",
  detect: (paths) => paths.some(isCandidate),
  async parse({ files, context }) {
    const out: CtrfReport[] = [];
    // Prefer the timestamped exports; fall back to the hidden latest file. Never emit both for the same run.
    const candidates = files.filter((f) => isCandidate(f.path));
    const timestamped = candidates.filter((f) => basename(f.path).startsWith("test_run_"));
    const chosen = timestamped.length
      ? timestamped
      : candidates.filter((f) => basename(f.path) === ".latest_test_run.json");
    const fallback = chosen.length ? chosen : candidates.slice(0, 1);
    for (const f of fallback) {
      const run = unwrap(JSON.parse(await f.text()));
      if (!run) continue;
      out.push(convertDeepEval(run, context, f.path));
    }
    return out;
  },
};

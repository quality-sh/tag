// The DeepEval view of a report as a JSON Render spec: a static spec over the catalog and
// the shaper that turns a report into the data it binds to. Pure, so a test can run it.
import type { MetricRow, ReportDetail } from "./client.ts";
import { decodeSpec, type Spec } from "./spec.ts";

export const SPEC: unknown = {
  root: "page",
  elements: {
    page: { type: "stack", props: { gap: 0 }, children: ["metrics", "cases"] },
    metrics: {
      type: "section",
      props: { eyebrow: "Metrics", count: { $: "metricCount" } },
      children: ["averages", "hyperparameters"],
    },
    averages: { type: "figures", props: { items: { $: "averages" } } },
    hyperparameters: { type: "facts", props: { items: { $: "hyperparameters" } } },
    cases: {
      type: "section",
      props: { eyebrow: "Evaluation cases", count: { $: "caseCount" } },
      children: ["list"],
    },
    list: {
      type: "rows",
      each: { path: "cases", as: "case", key: "case.testId" },
      children: ["case"],
    },
    case: {
      type: "row",
      props: {
        title: { $: "case.name" },
        href: { $: "case.href" },
        status: { $: "case.status" },
        duration: { $: "case.duration" },
      },
      children: ["meters", "io"],
    },
    meters: {
      type: "stack",
      each: { path: "case.metrics", as: "m", key: "m.name" },
      children: ["meter"],
    },
    meter: {
      type: "meter",
      props: {
        name: { $: "m.name" },
        value: { $: "m.value" },
        threshold: { $: "m.threshold" },
        comparator: { $: "m.comparator" },
        passed: { $: "m.passed" },
        reason: { $: "m.reason" },
        error: { $: "m.error" },
      },
    },
    io: {
      type: "fields",
      props: { summary: "input, output and context", items: { $: "case.fields" } },
    },
  },
};

/** The validated spec, or null when the spec above has drifted from the catalog. */
export const spec: Spec | null = (() => {
  const r = decodeSpec(SPEC);
  return r._tag === "Success" ? r.success : null;
})();

interface MetricsData {
  name: string;
  reason?: string;
  evaluationModel?: string;
  error?: string;
}
interface Io {
  input?: string;
  actualOutput?: string;
  expectedOutput?: string;
  retrievalContext?: string[];
}

/** Everything the spec binds to, in plain JSON. */
export function deepEvalData(d: ReportDetail, testHref: (testId: string) => string) {
  const byTest = new Map<string, MetricRow[]>();
  for (const m of d.metrics) byTest.set(m.testId, [...(byTest.get(m.testId) ?? []), m]);
  const ctrf = new Map((d.report?.results.tests ?? []).map((t) => [t.testId ?? "", t]));
  const extra = d.report?.results.extra as
    { deepeval?: { hyperparameters?: Record<string, unknown> } } | undefined;
  const hp = extra?.deepeval?.hyperparameters;
  const names = [...new Set(d.metrics.map((m) => m.name))];
  const averages = names.map((n) => {
    const vals = d.metrics
      .filter((m) => m.name === n && m.value !== null)
      .map((m) => m.value as number);
    const fails = d.metrics.filter((m) => m.name === n && m.passed === 0).length;
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return {
      key: n,
      label: n,
      value: mean === null ? "—" : mean.toFixed(2),
      unit: "mean",
      note: fails > 0 ? `${fails} below threshold` : "all above threshold",
      tone: fails > 0 ? "failed" : "metric",
    };
  });
  const cases = [...d.tests]
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "failed" ? -1 : 1))
    .map((t) => {
      const metrics = byTest.get(t.testId) ?? [];
      const full = ctrf.get(t.testId);
      const io = full?.extra?.["deepeval.io"] as Io | undefined;
      const md = full?.extra?.["deepeval.metricsData"] as MetricsData[] | undefined;
      return {
        testId: t.testId,
        name: t.name,
        href: testHref(t.testId),
        status: t.status,
        duration: t.duration,
        metrics: metrics.map((m) => {
          const detail = md?.find((x) => x.name === m.name);
          const failed = m.passed === 0;
          return {
            name: m.name,
            value: m.value,
            threshold: m.threshold,
            comparator: m.comparator,
            passed: m.passed === null ? null : m.passed === 1,
            // The judge's reasoning matters most when the metric failed; keep short lists verbose.
            reason: detail?.reason && (failed || metrics.length <= 3) ? detail.reason : null,
            error: detail?.error ?? null,
          };
        }),
        fields: io
          ? [
              io.input ? { label: "Input", value: io.input } : null,
              io.actualOutput ? { label: "Actual output", value: io.actualOutput } : null,
              io.expectedOutput ? { label: "Expected output", value: io.expectedOutput } : null,
              io.retrievalContext?.length
                ? { label: "Retrieval context", value: io.retrievalContext.join("\n\n") }
                : null,
            ].filter((f) => f !== null)
          : [],
      };
    });
  return {
    metricCount: `${names.length} ${names.length === 1 ? "metric" : "metrics"}`,
    averages,
    hyperparameters: hp ? Object.entries(hp).map(([k, v]) => `${k} ${String(v)}`) : [],
    caseCount: cases.length,
    cases,
  };
}

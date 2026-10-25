// TAG's two extensions, carried inside CTRF `extra` under namespaced keys.
// Documented in docs/schema.md. Everything else in a report is plain CTRF.
import { Schema } from "effect";
import type { CtrfReport, CtrfTest } from "./ctrf.ts";

export const METRICS_KEY = "tag.metrics";
export const ARTIFACTS_KEY = "tag.artifacts";
/** Free-form labels set at upload (`tag upload --tag smoke --tag env=staging`). */
export const TAGS_KEY = "tag.tags";

const { optionalKey } = Schema;

/** A numeric metric on a test. Framework-agnostic so trends work for any adapter. */
export const TagMetric = Schema.Struct({
  name: Schema.NonEmptyString,
  value: Schema.NullOr(Schema.Number),
  threshold: optionalKey(Schema.Number),
  comparator: optionalKey(Schema.Literals([">=", ">", "<=", "<", "=="])),
  passed: optionalKey(Schema.Boolean),
  unit: optionalKey(Schema.NullOr(Schema.String)),
  reason: optionalKey(Schema.String),
  error: optionalKey(Schema.String),
}).annotate({ identifier: "TagMetric" });
export interface TagMetric extends Schema.Schema.Type<typeof TagMetric> {}

/** A reference to an original artifact the dashboard should link or embed. */
export const TagArtifact = Schema.Struct({
  /** Open string. Known: playwright-html, playwright-json, deepeval-json, junit-xml, ctrf-json, file */
  kind: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  /** Path inside the artifact zip, posix separators. */
  path: Schema.NonEmptyString,
  contentType: optionalKey(Schema.String),
}).annotate({ identifier: "TagArtifact" });
export interface TagArtifact extends Schema.Schema.Type<typeof TagArtifact> {}

const decodeMetric = Schema.decodeUnknownResult(TagMetric);
const decodeArtifact = Schema.decodeUnknownResult(TagArtifact);

export function metricsOf(test: CtrfTest): TagMetric[] {
  const raw = test.extra?.[METRICS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const r = decodeMetric(m);
    return r._tag === "Success" ? [r.success] : [];
  });
}

export function artifactsOf(report: CtrfReport): TagArtifact[] {
  const raw = report.results.extra?.[ARTIFACTS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    const r = decodeArtifact(a);
    return r._tag === "Success" ? [r.success] : [];
  });
}

export function tagsOf(report: CtrfReport): string[] {
  const raw = report.results.extra?.[TAGS_KEY];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((t): t is string => typeof t === "string" && t.length > 0))];
}

export function withTags(report: CtrfReport, tags: readonly string[]): CtrfReport {
  if (tags.length === 0) return report;
  return {
    ...report,
    results: {
      ...report.results,
      extra: { ...(report.results.extra ?? {}), [TAGS_KEY]: [...new Set(tags)] },
    },
  };
}

export function withMetrics(test: CtrfTest, metrics: readonly TagMetric[]): CtrfTest {
  if (metrics.length === 0) return test;
  return { ...test, extra: { ...(test.extra ?? {}), [METRICS_KEY]: metrics } };
}

export function withArtifacts(report: CtrfReport, artifacts: readonly TagArtifact[]): CtrfReport {
  if (artifacts.length === 0) return report;
  return {
    ...report,
    results: {
      ...report.results,
      extra: { ...(report.results.extra ?? {}), [ARTIFACTS_KEY]: artifacts },
    },
  };
}

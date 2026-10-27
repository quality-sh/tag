// The report row as the index holds it: the fields every grouping and view reads.
import { Schema } from "effect";

const NullableString = Schema.NullOr(Schema.String);

/** A report as the index holds it, plus the fields groupings need. */
export const ReportLite = Schema.Struct({
  reportId: Schema.String,
  runId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  tool: Schema.String,
  branch: NullableString,
  commit: NullableString,
  workflow: NullableString,
  environment: NullableString,
  tags: Schema.Array(Schema.String),
  timestamp: Schema.String,
  tests: Schema.Number,
  passed: Schema.Number,
  failed: Schema.Number,
  skipped: Schema.Number,
  flaky: Schema.Number,
  duration: Schema.Number,
  buildUrl: NullableString,
}).annotate({ identifier: "ReportLite" });
export interface ReportLite extends Schema.Schema.Type<typeof ReportLite> {}

// CTRF 0.2.0 (Common Test Report Format) as Effect Schema.
// Spec: https://github.com/ctrf-io/ctrf/blob/main/spec/ctrf.md
// Unknown fields are forbidden outside `extra`; validateReport() decodes with onExcessProperty: "error".
import { Schema } from "effect";

const { optionalKey } = Schema;
const Int0 = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Int = Schema.Number.check(Schema.isInt());
const Str = Schema.String;
const NonEmpty = Schema.NonEmptyString;
const Extra = Schema.Record(Schema.String, Schema.Unknown);
const Strings = Schema.Array(Schema.String);

export const CtrfStatus = Schema.Literals(["passed", "failed", "skipped", "pending", "other"]);
export type CtrfStatus = typeof CtrfStatus.Type;

export const CtrfAttachment = Schema.Struct({
  name: Str,
  contentType: Str,
  path: Str,
  attachmentId: optionalKey(NonEmpty),
  extra: optionalKey(Extra),
});
export interface CtrfAttachment extends Schema.Schema.Type<typeof CtrfAttachment> {}

export const CtrfStep = Schema.Struct({ name: Str, status: CtrfStatus, extra: optionalKey(Extra) });
export interface CtrfStep extends Schema.Schema.Type<typeof CtrfStep> {}

export const CtrfRetryAttempt = Schema.Struct({
  attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  status: CtrfStatus,
  attemptId: optionalKey(NonEmpty),
  duration: optionalKey(Int0),
  message: optionalKey(Str),
  trace: optionalKey(Str),
  line: optionalKey(Int),
  snippet: optionalKey(Str),
  stdout: optionalKey(Strings),
  stderr: optionalKey(Strings),
  start: optionalKey(Int),
  stop: optionalKey(Int),
  attachments: optionalKey(Schema.Array(CtrfAttachment)),
  extra: optionalKey(Extra),
});
export interface CtrfRetryAttempt extends Schema.Schema.Type<typeof CtrfRetryAttempt> {}

const LabelValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

export const CtrfTest = Schema.Struct({
  name: NonEmpty,
  status: CtrfStatus,
  duration: Int0,
  id: optionalKey(Str),
  testId: optionalKey(NonEmpty),
  executionId: optionalKey(NonEmpty),
  attemptId: optionalKey(NonEmpty),
  start: optionalKey(Int),
  stop: optionalKey(Int),
  suite: optionalKey(Schema.NonEmptyArray(Schema.String)),
  message: optionalKey(Str),
  trace: optionalKey(Str),
  snippet: optionalKey(Str),
  ai: optionalKey(Str),
  line: optionalKey(Int),
  rawStatus: optionalKey(Str),
  tags: optionalKey(Strings),
  labels: optionalKey(
    Schema.Record(Schema.String, Schema.Union([LabelValue, Schema.NonEmptyArray(LabelValue)])),
  ),
  type: optionalKey(Str),
  filePath: optionalKey(Str),
  retries: optionalKey(Int0),
  retryAttempts: optionalKey(Schema.NonEmptyArray(CtrfRetryAttempt)),
  flaky: optionalKey(Schema.Boolean),
  stdout: optionalKey(Strings),
  stderr: optionalKey(Strings),
  threadId: optionalKey(Str),
  browser: optionalKey(Str),
  device: optionalKey(Str),
  screenshot: optionalKey(Str),
  attachments: optionalKey(Schema.Array(CtrfAttachment)),
  parameters: optionalKey(Extra),
  steps: optionalKey(Schema.Array(CtrfStep)),
  insights: optionalKey(Extra),
  extra: optionalKey(Extra),
});
export interface CtrfTest extends Schema.Schema.Type<typeof CtrfTest> {}

export const CtrfSummary = Schema.Struct({
  tests: Int0,
  passed: Int0,
  failed: Int0,
  skipped: Int0,
  pending: Int0,
  other: Int0,
  start: Int,
  stop: Int,
  flaky: optionalKey(Int0),
  suites: optionalKey(Int0),
  duration: optionalKey(Int),
  extra: optionalKey(Extra),
});
export interface CtrfSummary extends Schema.Schema.Type<typeof CtrfSummary> {}

export const CtrfTool = Schema.Struct({
  name: NonEmpty,
  version: optionalKey(Str),
  extra: optionalKey(Extra),
});
export interface CtrfTool extends Schema.Schema.Type<typeof CtrfTool> {}

export const CtrfEnvironment = Schema.Struct({
  reportName: optionalKey(Str),
  appName: optionalKey(Str),
  appVersion: optionalKey(Str),
  buildId: optionalKey(Str),
  buildName: optionalKey(Str),
  buildNumber: optionalKey(Int),
  buildUrl: optionalKey(Str),
  repositoryName: optionalKey(Str),
  repositoryUrl: optionalKey(Str),
  commit: optionalKey(Str),
  branchName: optionalKey(Str),
  osPlatform: optionalKey(Str),
  osRelease: optionalKey(Str),
  osVersion: optionalKey(Str),
  testEnvironment: optionalKey(Str),
  shardId: optionalKey(NonEmpty),
  healthy: optionalKey(Schema.Boolean),
  extra: optionalKey(Extra),
});
export interface CtrfEnvironment extends Schema.Schema.Type<typeof CtrfEnvironment> {}

export const CtrfResults = Schema.Struct({
  tool: CtrfTool,
  summary: CtrfSummary,
  tests: Schema.Array(CtrfTest),
  environment: optionalKey(CtrfEnvironment),
  extra: optionalKey(Extra),
});
export interface CtrfResults extends Schema.Schema.Type<typeof CtrfResults> {}

export const CtrfReport = Schema.Struct({
  reportFormat: Schema.Literal("CTRF"),
  specVersion: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
  results: CtrfResults,
  reportId: optionalKey(
    Schema.String.check(
      Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    ),
  ),
  runId: optionalKey(NonEmpty),
  timestamp: optionalKey(Str),
  generatedBy: optionalKey(Str),
  insights: optionalKey(Extra),
  baseline: optionalKey(Extra),
  extra: optionalKey(Extra),
}).annotate({ identifier: "CtrfReport" });
export interface CtrfReport extends Schema.Schema.Type<typeof CtrfReport> {}

export const CTRF_SPEC_VERSION = "0.2.0";

// The read API's inputs and outputs as Effect Schemas: what the HTTP API declares, what
// the OpenAPI document shows, and what the MCP tools take and return. Built from the row
// schemas in grouping.ts and the result store, never copies of them.
import { Schema } from "effect";
import { CtrfReport, TagArtifact } from "@quality-sh/tag-schema";
import {
  Collection,
  GroupBy,
  GroupRow,
  OrgSuggestion,
  Range,
  RepoOverview,
  RunSummary,
} from "../grouping.ts";
import { ArtifactRow, MetricRow, RepoCount, RunRow, ScanRow, TestRow } from "./result-store.ts";

const describe = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

const Text = Schema.optionalKey(Schema.String);

/** The scope every view takes: a time range, a query, and a saved collection. */
export const ViewQuery = {
  range: Schema.optionalKey(
    describe(Range, "How far back to look: 1d, 7d, 30d, 90d or all. Default 30d."),
  ),
  q: Schema.optionalKey(
    describe(
      Schema.String,
      "Filters in the search-bar language, such as `repo:acme/web branch:main failed:>0`.",
    ),
  ),
  c: Schema.optionalKey(describe(Schema.String, "A collection id; its query applies first.")),
  from: Schema.optionalKey(
    describe(Schema.String, "ISO 8601 timestamp; overrides the start of `range`."),
  ),
  to: Schema.optionalKey(
    describe(Schema.String, "ISO 8601 timestamp; only reports at or before it count."),
  ),
};
export const ViewParams = Schema.Struct(ViewQuery);
export type ViewParams = typeof ViewParams.Type;

export const GroupsParams = Schema.Struct({
  by: Schema.optionalKey(describe(GroupBy, "The field to group runs by. Default release.")),
  ...ViewQuery,
});
export type GroupsParams = typeof GroupsParams.Type;

export const GroupKey = {
  by: describe(GroupBy, "The field the group belongs to."),
  key: describe(Schema.String, "The group's key, as `groups` returns it."),
};
export const GroupParams = Schema.Struct({ ...GroupKey, ...ViewQuery });
export type GroupParams = typeof GroupParams.Type;

export const RunsQuery = {
  owner: Text,
  repo: Text,
  branch: Text,
  tool: Text,
  runId: Text,
  limit: Schema.optionalKey(
    describe(Schema.FiniteFromString, "Most rows to return, newest first. Default 100."),
  ),
};
export const RunsParams = Schema.Struct({
  ...RunsQuery,
  limit: Schema.optionalKey(Schema.Finite),
});
export type RunsParams = typeof RunsParams.Type;

/** Runs in a view's scope, folded per CI run, newest first. */
export const ScopedRunsParams = Schema.Struct({
  ...ViewQuery,
  limit: Schema.optionalKey(Schema.Finite),
});
export type ScopedRunsParams = typeof ScopedRunsParams.Type;

export const TestKey = {
  owner: Schema.String,
  repo: Schema.String,
  testId: describe(Schema.String, "The test's deterministic id, as reports and groups show it."),
};
export const HistoryParams = Schema.Struct({
  ...TestKey,
  limit: Schema.optionalKey(Schema.Finite),
});
export type HistoryParams = typeof HistoryParams.Type;

const Counts = describe(
  Schema.Record(Schema.String, Schema.Number),
  "How many groups each group-by has in scope, and how many runs.",
);

/** A collection with what it holds now. */
export const CollectionSummary = Schema.Struct({
  ...Collection.fields,
  runs: Schema.Number,
  failing: Schema.Number,
  repos: Schema.Number,
}).annotate({ identifier: "CollectionSummary" });
export type CollectionSummary = typeof CollectionSummary.Type;

export const Overview = Schema.Struct({
  range: Range,
  query: Schema.String,
  repos: Schema.Array(RepoOverview),
  scans: Schema.Record(Schema.String, ScanRow),
  collections: Schema.Array(CollectionSummary),
  counts: Counts,
  repoList: Schema.Array(RepoCount),
}).annotate({ identifier: "Overview" });
export type Overview = typeof Overview.Type;

export const GroupsView = Schema.Struct({
  by: GroupBy,
  range: Range,
  query: Schema.String,
  groups: Schema.Array(GroupRow),
  totals: Schema.Struct({
    runs: Schema.Number,
    passRate: Schema.NullOr(Schema.Number),
    failingNow: Schema.Number,
    flaky: Schema.Number,
  }),
  counts: Counts,
  repos: Schema.Array(RepoCount),
  collections: Schema.Array(Collection),
}).annotate({ identifier: "GroupsView" });
export type GroupsView = typeof GroupsView.Type;

export const FailingTest = Schema.Struct({
  testId: Schema.String,
  name: Schema.String,
  suite: Schema.NullOr(Schema.String),
  tool: Schema.String,
  reportId: Schema.String,
  message: Schema.NullOr(Schema.String),
  duration: Schema.Number,
}).annotate({ identifier: "FailingTest" });

export const FlakyTest = Schema.Struct({
  testId: Schema.String,
  name: Schema.String,
  tool: Schema.String,
  occurrences: Schema.Number,
}).annotate({ identifier: "FlakyTest" });

export const GroupPage = Schema.Struct({
  group: GroupRow,
  runs: Schema.Array(RunSummary),
  failing: Schema.Array(FailingTest),
  errors: Schema.Array(Schema.Struct({ message: Schema.String, count: Schema.Number })),
  flaky: Schema.Array(FlakyTest),
  previous: Schema.NullOr(Schema.String),
  next: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GroupPage" });
export type GroupPage = typeof GroupPage.Type;

export const ReportPage = Schema.Struct({
  run: RunRow,
  tests: Schema.Array(TestRow),
  metrics: Schema.Array(MetricRow),
  artifacts: Schema.Array(ArtifactRow),
  siblings: Schema.Array(RunRow),
  report: Schema.NullOr(CtrfReport),
  artifactRefs: Schema.Array(TagArtifact),
}).annotate({ identifier: "ReportPage" });
export type ReportPage = typeof ReportPage.Type;

export const Health = Schema.Struct({
  ok: Schema.Boolean,
  source: Schema.Literals(["fixtures", "github"]),
  store: Schema.Literals(["s3", "fs"]),
}).annotate({ identifier: "Health" });

export const Suggestions = Schema.Array(OrgSuggestion);

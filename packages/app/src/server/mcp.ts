// The MCP server: streamable HTTP at POST /mcp on the dashboard port. Every tool is a thin
// call into the Reads service the HTTP API uses; nothing here computes. Read-only for now.
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { OpenApi } from "effect/http-api";
import { GroupBy, Range, RunSummary, Suggestion } from "../grouping.ts";
import { RepositoryRow, ResultStore, TestHistoryRow } from "./result-store.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { Reads } from "./reads.ts";
import { TagApi } from "./http-api.ts";
import { GroupPage, GroupsView, Overview, ReportPage, type ViewParams } from "./read-schemas.ts";

export const MCP_PATH = "/mcp";
export const OPENAPI_RESOURCE = "tag://api/openapi.json";

/** A tool call that could not be answered: a missing report or group, or a failed read. */
export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", {
  message: Schema.String,
}) {}

const field = <S extends Schema.Top>(schema: S, description: string) =>
  Schema.optionalKey(schema.annotate({ description }));

// The scope a view takes, named for an agent: `query` rather than the URL's `q`.
const Scope = {
  query: field(
    Schema.String,
    "Filters in TAG's search language, space separated: `repo:owner/name`, `branch:main`, " +
      "`tool:playwright`, `environment:staging`, `tag:nightly`, `failed:>0`, or free text. " +
      "Call list_fields to see which fields and values exist.",
  ),
  c: field(Schema.String, "A saved collection id; its query applies before `query`."),
  range: field(Range, "How far back to look: 1d, 7d, 30d, 90d or all. Default 30d."),
  from: field(Schema.String, "ISO 8601 timestamp; overrides the start of `range`."),
  to: field(Schema.String, "ISO 8601 timestamp; only reports at or before it count."),
};
type ScopeInput = Schema.Struct.Type<typeof Scope>;

const viewOf = ({ query, ...rest }: ScopeInput): ViewParams =>
  query === undefined ? rest : { ...rest, q: query };

const failure = (e: Reads.NotFound | ResultStore.DbError | ArtifactStore.StoreError) =>
  new ToolFailure({
    message: e._tag === "Reads.NotFound" ? `${e.what} not found` : `read failed: ${e.operation}`,
  });

const tool = <const Name extends string, P extends Schema.Top, S extends Schema.Top>(
  name: Name,
  description: string,
  parameters: P,
  success: S,
) =>
  Tool.make(name, {
    description,
    parameters,
    success,
    failure: ToolFailure,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false);

export const TagTools = Toolkit.make(
  tool(
    "list_repositories",
    "List every repository TAG has indexed, with its backfill state: new, backfilling or " +
      "current, and how many runs of its history have been read. Start here to learn which " +
      "owner/repo names exist before filtering other tools by repository.",
    Tool.EmptyParams,
    Schema.Struct({ repositories: Schema.Array(RepositoryRow) }),
  ),
  tool(
    "overview",
    "Summarise the state of every repository in scope: the latest run on its default branch " +
      "against the one before, the newest release with its verdict, open and failing pull " +
      "requests, flaky test counts and recent runs. Use it first to answer 'what is broken " +
      "right now'. Narrow it with `query`, a collection `c`, or a time window.",
    Schema.Struct(Scope),
    Overview,
  ),
  tool(
    "list_fields",
    "Suggest completions for a word of a TAG query: the fields a query can name (repo, " +
      "branch, tool, environment, tag, release, pull_request, day, workflow) and, after " +
      "`field:`, the values that occur with how many reports carry each. Use it to build a " +
      "valid `query` for the other tools.",
    Schema.Struct({
      q: field(Schema.String, "The word being typed, such as `bra` or `branch:ma`."),
    }),
    Schema.Struct({ suggestions: Schema.Array(Suggestion) }),
  ),
  tool(
    "groups",
    "Group runs by one field (release, branch, pull_request, environment, tag, tool, " +
      "workflow, repo, day or run) and return one row per group with its verdict (passed, " +
      "failed or none), pass rate of the latest run, trend, and change against its baseline, " +
      "plus totals. Use it to compare releases, branches or environments. Pass a row's `by` " +
      "and `key` to the group tool for detail.",
    Schema.Struct({ by: field(GroupBy, "The field to group runs by. Default release."), ...Scope }),
    GroupsView,
  ),
  tool(
    "group",
    "Read one group in detail: its runs, the failing tests of its latest run with their " +
      "error messages, the most common errors, and the tests that were flaky across its runs. " +
      "Take `by` and `key` from a row the groups tool returned. Use it to explain why a " +
      "release, branch or pull request fails.",
    Schema.Struct({
      by: GroupBy.annotate({ description: "The field the group belongs to." }),
      key: Schema.String.annotate({ description: "The group's key, as groups returns it." }),
      ...Scope,
    }),
    GroupPage,
  ),
  tool(
    "runs",
    "List CI runs in scope, newest first, one summary per run across every test tool it " +
      "reported: branch, commit, tests, passed, failed, skipped, flaky, pass rate, the build " +
      "URL and the ids of its reports. Use the report ids with the report tool.",
    Schema.Struct({ ...Scope, limit: field(Schema.Finite, "Most runs to return. Default 50.") }),
    Schema.Struct({ runs: Schema.Array(RunSummary) }),
  ),
  tool(
    "report",
    "Read one test report by its id: the run row, every test with status, duration and " +
      "failure message, recorded metrics, the run's artifacts, sibling reports of the same " +
      "CI run, and the full CTRF document. Use it to inspect a specific failure. The result " +
      "can be large.",
    Schema.Struct({
      reportId: Schema.String.annotate({ description: "A report id from runs or group." }),
    }),
    ReportPage,
  ),
  tool(
    "test_history",
    "Read one test's results across reports, newest first: status, duration, retries, " +
      "flakiness, failure message, branch and recorded metrics per report. Use it to tell a " +
      "new failure from a flaky or long-broken test. Take owner, repo and testId from a " +
      "report or group.",
    Schema.Struct({
      owner: Schema.String,
      repo: Schema.String,
      testId: Schema.String.annotate({ description: "The test's id, as reports show it." }),
      limit: field(Schema.Finite, "Most results to return. Default 50."),
    }),
    Schema.Struct({ history: Schema.Array(TestHistoryRow) }),
  ),
);

const TagToolHandlers = TagTools.toLayer(
  Effect.gen(function* () {
    const reads = yield* Reads.Service;
    return {
      list_repositories: () =>
        reads.repositories().pipe(
          Effect.map((repositories) => ({ repositories })),
          Effect.mapError(failure),
        ),
      overview: (input) => reads.overview(viewOf(input)).pipe(Effect.mapError(failure)),
      list_fields: ({ q }) =>
        reads.fields(q ?? "").pipe(
          Effect.map((suggestions) => ({ suggestions })),
          Effect.mapError(failure),
        ),
      groups: ({ by, ...scope }) =>
        reads.groups({ ...viewOf(scope), ...(by ? { by } : {}) }).pipe(Effect.mapError(failure)),
      group: ({ by, key, ...scope }) =>
        reads.group({ ...viewOf(scope), by, key }).pipe(Effect.mapError(failure)),
      runs: ({ limit, ...scope }) =>
        reads.scopedRuns({ ...viewOf(scope), ...(limit === undefined ? {} : { limit }) }).pipe(
          Effect.map((runs) => ({ runs })),
          Effect.mapError(failure),
        ),
      report: ({ reportId }) => reads.report(reportId).pipe(Effect.mapError(failure)),
      test_history: (input) =>
        reads.testHistory(input).pipe(
          Effect.map((history) => ({ history })),
          Effect.mapError(failure),
        ),
    };
  }),
);

const OpenApiResource = McpServer.resource({
  uri: OPENAPI_RESOURCE,
  name: "TAG OpenAPI document",
  description:
    "The OpenAPI 3.1 document of TAG's read API, the same one served at /api/openapi.json.",
  mimeType: "application/json",
  content: Effect.sync(() => JSON.stringify(OpenApi.fromApi(TagApi))),
});

/** The MCP endpoint; auth sits in front of it in the router (see requireMcpAuth). */
export const McpLayer = Layer.mergeAll(McpServer.toolkit(TagTools), OpenApiResource).pipe(
  Layer.provide(TagToolHandlers),
  Layer.provide(
    McpServer.layerHttp({
      name: "tag",
      version: "1",
      description: "Read verdicts, groups, runs, reports and test history from TAG.",
      path: MCP_PATH,
      protocols: [
        McpProtocol.v2026_07_28,
        McpProtocol.v2025_11_25,
        McpProtocol.v2025_06_18,
        McpProtocol.v2025_03_26,
      ],
    }),
  ),
);

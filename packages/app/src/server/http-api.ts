// The read API as an Effect HttpApi: the one declaration the handlers, the OpenAPI document
// at /api/openapi.json and the Scalar page at /api/docs all come from.
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { Suggestion } from "../grouping.ts";
import { RepoCount, RepositoryRow, RunRow, TestHistoryRow } from "./result-store.ts";
import { SESSION_COOKIE } from "./auth.ts";
import {
  CollectionSummary,
  GroupKey,
  GroupPage,
  GroupsParams,
  GroupsView,
  Health,
  Overview,
  ReportPage,
  RunsQuery,
  Suggestions,
  TestKey,
  ViewQuery,
} from "./read-schemas.ts";

export const OPENAPI_PATH = "/api/openapi.json";
export const DOCS_PATH = "/api/docs";

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { error: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The index or the artifact store failed; `operation` names the step. */
export class ServerError extends Schema.TaggedError<ServerError>()(
  "ServerError",
  { error: Schema.String, operation: Schema.String, detail: Schema.String },
  { httpApiStatus: 500 },
) {}

const Limit = Schema.optionalKey(Schema.FiniteFromString);

const read = HttpApiGroup.make("read")
  .add(
    HttpApiEndpoint.get("health", "/api/health", { success: Health }).annotate(
      OpenApi.Summary,
      "Whether the server is up, and which source and store it uses. Needs no session.",
    ),
  )
  .add(
    HttpApiEndpoint.get("overview", "/api/overview", {
      query: ViewQuery,
      success: Overview,
      error: ServerError,
    }).annotate(
      OpenApi.Summary,
      "Every repository in scope with its default-branch run, newest release and open pull requests.",
    ),
  )
  .add(
    HttpApiEndpoint.get("repos", "/api/repos", {
      success: Schema.Array(RepoCount),
      error: ServerError,
    }).annotate(OpenApi.Summary, "Each repository with how many reports the index holds."),
  )
  .add(
    HttpApiEndpoint.get("repositories", "/api/repositories", {
      success: Schema.Array(RepositoryRow),
      error: ServerError,
    }).annotate(OpenApi.Summary, "Each repository with its backfill state."),
  )
  .add(
    HttpApiEndpoint.get("fields", "/api/fields", {
      query: { q: Schema.optionalKey(Schema.String) },
      success: Schema.Array(Suggestion),
      error: ServerError,
    }).annotate(OpenApi.Summary, "Search-bar suggestions for the word being typed."),
  )
  .add(
    HttpApiEndpoint.get("groups", "/api/groups", {
      query: GroupsParams,
      success: GroupsView,
      error: ServerError,
    }).annotate(OpenApi.Summary, "Runs grouped by a field, with a verdict and trend per group."),
  )
  .add(
    HttpApiEndpoint.get("group", "/api/groups/:by/:key", {
      params: GroupKey,
      query: ViewQuery,
      success: GroupPage,
      error: [NotFound, ServerError],
    }).annotate(
      OpenApi.Summary,
      "One group: its runs, the failing tests of its latest run, common errors and flaky tests.",
    ),
  )
  .add(
    HttpApiEndpoint.get("runs", "/api/runs", {
      query: RunsQuery,
      success: Schema.Array(RunRow),
      error: ServerError,
    }).annotate(OpenApi.Summary, "Reports, newest first, one row per tool per CI run."),
  )
  .add(
    HttpApiEndpoint.get("report", "/api/reports/:reportId", {
      params: { reportId: Schema.String },
      success: ReportPage,
      error: [NotFound, ServerError],
    }).annotate(OpenApi.Summary, "One report: its tests, metrics, artifacts and CTRF document."),
  )
  .add(
    HttpApiEndpoint.get("testHistory", "/api/tests/:owner/:repo/:testId/history", {
      params: TestKey,
      query: { limit: Limit },
      success: Schema.Array(TestHistoryRow),
      error: ServerError,
    }).annotate(OpenApi.Summary, "One test's results across reports, newest first."),
  )
  .add(
    HttpApiEndpoint.get("collections", "/api/collections", {
      success: Schema.Array(CollectionSummary),
      error: ServerError,
    }).annotate(OpenApi.Summary, "The saved collections with what each holds over 30 days."),
  )
  .add(
    HttpApiEndpoint.get("suggestions", "/api/suggestions", {
      query: { org: Schema.String },
      success: Suggestions,
      error: ServerError,
    }).annotate(OpenApi.Summary, "Collections and release groups TAG suggests saving for an org."),
  );

/** Auth sits in the router in front of every route; the document only describes it. */
const describeAuth = (spec: Record<string, unknown>) => ({
  ...spec,
  components: {
    ...(typeof spec.components === "object" ? spec.components : {}),
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: SESSION_COOKIE },
      password: {
        type: "http",
        scheme: "bearer",
        description: "TAG_PASSWORD; accepted on /mcp only. Becomes a per-user token with OIDC.",
      },
    },
  },
  security: [{ session: [] }],
});

export const TagApi = HttpApi.make("tag")
  .add(read)
  .annotateMerge(
    OpenApi.annotations({
      title: "TAG",
      version: "1",
      description:
        "Read API of TAG, the test aggregator: verdicts, groups, runs, reports and test " +
        "history. Every route but /api/health needs a session when TAG_PASSWORD is set.",
      transform: describeAuth,
    }),
  );

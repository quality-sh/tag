// The dashboard API as an Effect service over the Effect HttpClient.
// 401 becomes a typed Unauthorized so the app can fall back to the login page.
import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, type HttpClientResponse } from "effect/http";
import type {
  Collection,
  CollectionInput,
  GroupBy,
  GroupRow,
  Range,
  RepoOverview,
  RunSummary,
  Suggestion,
} from "../grouping.ts";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Number,
  detail: Schema.String,
}) {}

export interface RunRow {
  reportId: string;
  runId: string;
  owner: string;
  repo: string;
  tool: string;
  toolVersion: string | null;
  branch: string | null;
  commit: string | null;
  buildUrl: string | null;
  timestamp: string;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  other: number;
  flaky: number;
  duration: number;
  artifactId: string | null;
  artifactName: string | null;
  adapter: string;
  ingestedAt: string;
}

export interface TestRow {
  reportId: string;
  runId: string;
  testId: string;
  name: string;
  status: string;
  duration: number;
  filePath: string | null;
  suite: string | null;
  flaky: number;
  retries: number;
  message: string | null;
  timestamp: string;
  branch: string | null;
  tool: string;
}

export interface MetricRow {
  reportId: string;
  testId: string;
  name: string;
  value: number | null;
  threshold: number | null;
  comparator: string | null;
  passed: number | null;
}

export interface ArtifactRow {
  artifactId: string;
  owner: string;
  repo: string;
  runId: string;
  name: string;
  sizeBytes: number;
  expiresAt: string | null;
  state: "listed" | "cached" | "expired";
  cachedAt: string | null;
}

export interface ArtifactRef {
  kind: string;
  name: string;
  path: string;
  contentType?: string;
}

/** A CTRF test, loosely typed on the client. */
export interface CtrfTestLite {
  name: string;
  status: string;
  duration: number;
  testId?: string;
  suite?: string[];
  filePath?: string;
  message?: string;
  trace?: string;
  snippet?: string;
  retries?: number;
  flaky?: boolean;
  browser?: string;
  attachments?: Array<{ name: string; contentType: string; path: string }>;
  extra?: Record<string, unknown>;
}

export interface ReportDetail {
  run: RunRow;
  tests: TestRow[];
  metrics: MetricRow[];
  artifacts: ArtifactRow[];
  siblings: RunRow[];
  report: {
    results: {
      tests: CtrfTestLite[];
      extra?: Record<string, unknown>;
      environment?: Record<string, unknown>;
    };
  } | null;
  artifactRefs: ArtifactRef[];
}

export type HistoryRow = TestRow & { metrics: MetricRow[] };
export interface Session {
  authenticated: boolean;
  authRequired: boolean;
  /** The App's "Install on GitHub" link, when App credentials and a slug are configured. */
  installUrl?: string;
}
export interface RepoRow {
  owner: string;
  repo: string;
  reports: number;
}
export interface RunFilter {
  readonly owner?: string | undefined;
  readonly repo?: string | undefined;
  readonly branch?: string | undefined;
  readonly tool?: string | undefined;
}
export interface IngestSummary {
  runs: number;
  artifacts: number;
  inserted: number;
  errors: string[];
}

export interface CollectionRow extends Collection {
  runs: number;
  failing: number;
  repos: number;
}
export interface OverviewPage {
  range: Range;
  query: string;
  repos: RepoOverview[];
  collections: CollectionRow[];
  counts: Record<string, number>;
  repoList: RepoRow[];
}
export interface GroupsQuery {
  readonly by: GroupBy;
  readonly q: string;
  readonly range: Range;
  /** A collection whose query scopes the view, by id. */
  readonly c?: string | undefined;
}
export interface OverviewQuery {
  readonly range: Range;
  readonly q: string;
  readonly c?: string | undefined;
}
export interface GroupsPage {
  by: GroupBy;
  range: Range;
  query: string;
  groups: GroupRow[];
  totals: { runs: number; passRate: number | null; failingNow: number; flaky: number };
  counts: Record<string, number>;
  repos: RepoRow[];
  collections: Collection[];
}
export interface FailingTest {
  testId: string;
  name: string;
  suite: string | null;
  tool: string;
  reportId: string;
  message: string | null;
  duration: number;
}
export interface GroupDetail {
  group: GroupRow;
  runs: RunSummary[];
  failing: FailingTest[];
  errors: Array<{ message: string; count: number }>;
  flaky: Array<{ testId: string; name: string; tool: string; occurrences: number }>;
  previous: string | null;
  next: string | null;
}

export interface Interface {
  readonly session: () => Effect.Effect<Session, ApiError>;
  readonly login: (password: string) => Effect.Effect<boolean, ApiError>;
  readonly logout: () => Effect.Effect<void, ApiError>;
  readonly repos: () => Effect.Effect<ReadonlyArray<RepoRow>, ApiError | Unauthorized>;
  readonly runs: (
    filter: RunFilter,
  ) => Effect.Effect<ReadonlyArray<RunRow>, ApiError | Unauthorized>;
  readonly report: (reportId: string) => Effect.Effect<ReportDetail, ApiError | Unauthorized>;
  readonly history: (
    owner: string,
    repo: string,
    testId: string,
  ) => Effect.Effect<ReadonlyArray<HistoryRow>, ApiError | Unauthorized>;
  readonly artifactLink: (
    artifactId: string,
    path: string,
  ) => Effect.Effect<{ url: string; cached: boolean }, ApiError | Unauthorized>;
  readonly ingest: () => Effect.Effect<IngestSummary, ApiError | Unauthorized>;
  readonly overview: (q: OverviewQuery) => Effect.Effect<OverviewPage, ApiError | Unauthorized>;
  readonly groups: (q: GroupsQuery) => Effect.Effect<GroupsPage, ApiError | Unauthorized>;
  readonly group: (
    q: GroupsQuery & { readonly key: string },
  ) => Effect.Effect<GroupDetail, ApiError | Unauthorized>;
  readonly fields: (
    typed: string,
  ) => Effect.Effect<ReadonlyArray<Suggestion>, ApiError | Unauthorized>;
  readonly collections: () => Effect.Effect<ReadonlyArray<CollectionRow>, ApiError | Unauthorized>;
  readonly createCollection: (
    input: typeof CollectionInput.Type,
  ) => Effect.Effect<Collection, ApiError | Unauthorized>;
  readonly deleteCollection: (id: string) => Effect.Effect<void, ApiError | Unauthorized>;
}

export class TagApi extends Context.Service<TagApi, Interface>()("@tag/web/Api") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const read = <T>(
    res: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<T, ApiError | Unauthorized> =>
    Effect.gen(function* () {
      if (res.status === 401) return yield* new Unauthorized();
      if (res.status >= 400)
        return yield* new ApiError({
          status: res.status,
          detail: `request failed with ${res.status}`,
        });
      const body = yield* res.json.pipe(
        Effect.mapError((e) => new ApiError({ status: res.status, detail: String(e) })),
      );
      return body as T;
    });

  const get = <T>(url: string) =>
    HttpClient.get(url).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.mapError((e) => new ApiError({ status: 0, detail: String(e) })),
      Effect.flatMap((res) => read<T>(res)),
    );

  const post = <T>(url: string, body: unknown) =>
    HttpClient.post(url, { body: HttpBody.jsonUnsafe(body) }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.mapError((e) => new ApiError({ status: 0, detail: String(e) })),
      Effect.flatMap((res) => read<T>(res)),
    );

  const query = (q: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return TagApi.of({
    session: () =>
      get<Session>("/api/session").pipe(
        Effect.catchTag("Unauthorized", () =>
          Effect.succeed({ authenticated: false, authRequired: true }),
        ),
      ),
    login: (password) =>
      HttpClient.post("/api/login", { body: HttpBody.jsonUnsafe({ password }) }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.mapError((e) => new ApiError({ status: 0, detail: String(e) })),
        Effect.map((res) => res.status < 400),
      ),
    logout: () =>
      HttpClient.post("/api/logout").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.mapError((e) => new ApiError({ status: 0, detail: String(e) })),
        Effect.asVoid,
      ),
    repos: () => get<ReadonlyArray<RepoRow>>("/api/repos"),
    runs: (f) =>
      get<ReadonlyArray<RunRow>>(
        `/api/runs${query({ owner: f.owner, repo: f.repo, branch: f.branch, tool: f.tool, limit: "300" })}`,
      ),
    report: (id) => get<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`),
    history: (owner, repo, testId) =>
      get<ReadonlyArray<HistoryRow>>(
        `/api/tests/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(testId)}/history?limit=50`,
      ),
    artifactLink: (artifactId, path) =>
      get<{ url: string; cached: boolean }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}/link?path=${encodeURIComponent(path)}`,
      ),
    ingest: () => post<IngestSummary>("/api/ingest", {}),
    overview: (o) => get<OverviewPage>(`/api/overview${query({ range: o.range, q: o.q, c: o.c })}`),
    groups: (g) =>
      get<GroupsPage>(`/api/groups${query({ by: g.by, q: g.q, range: g.range, c: g.c })}`),
    group: (g) =>
      get<GroupDetail>(
        `/api/groups/${encodeURIComponent(g.by)}/${encodeURIComponent(g.key)}${query({ q: g.q, range: g.range, c: g.c })}`,
      ),
    fields: (typed) => get<ReadonlyArray<Suggestion>>(`/api/fields${query({ q: typed })}`),
    collections: () => get<ReadonlyArray<CollectionRow>>("/api/collections"),
    createCollection: (input) => post<Collection>("/api/collections", input),
    deleteCollection: (id) =>
      HttpClient.del(`/api/collections/${encodeURIComponent(id)}`).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.mapError((e) => new ApiError({ status: 0, detail: String(e) })),
        Effect.flatMap((res) => read<{ ok: boolean }>(res)),
        Effect.asVoid,
      ),
  });
});

export const layer = Layer.effect(TagApi, make).pipe(Layer.provide(FetchHttpClient.layer));

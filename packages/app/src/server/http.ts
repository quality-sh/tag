// The dashboard API and static web app. One Bun server on PORT.
import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http";
import { artifactsOf } from "@quality-sh/tag-schema";
import {
  CollectionInput,
  computeGroups,
  computeOverview,
  indexValues,
  isGroupBy,
  matching,
  isRange,
  parseQuery,
  runsOf,
  sinceOf,
  suggest,
  type Collection,
  type GroupBy,
  type Range,
  type Ref,
  type ReportLite,
} from "../grouping.ts";
import { AppConfig } from "./config.ts";
import { Auth, SESSION_COOKIE } from "./auth.ts";
import { ResultStore } from "./result-store.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { Ingest } from "./ingest.ts";
import { Retention } from "./retention.ts";

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const notFound = (what: string) => json({ error: `${what} not found` }, 404);

const query = (req: HttpServerRequest.HttpServerRequest) =>
  new URL(req.url, "http://local").searchParams;
const optional = (v: string | null): string | undefined => (v && v.length > 0 ? v : undefined);

const PUBLIC_PATHS = new Set(["/api/health", "/api/login", "/api/session"]);

/** Reject unauthenticated API calls. The static app is public; it shows the login screen itself. */
const requireSession = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* Auth.Service;
      const path = new URL(req.url, "http://local").pathname;
      if (!path.startsWith("/api/") || PUBLIC_PATHS.has(path)) return yield* httpEffect;
      if (auth.verifySession(req.cookies[SESSION_COOKIE])) return yield* httpEffect;
      return json({ error: "unauthorized" }, 401);
    }),
  { global: true },
);

class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  detail: Schema.String,
}) {}

const LoginBody = Schema.Struct({ password: Schema.String });
const IngestBody = Schema.Struct({
  owner: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
});

const groupByOf = (s: string | null, fallback: GroupBy = "release"): GroupBy =>
  s && isGroupBy(s) ? s : fallback;
const rangeOf = (s: string | null, fallback: Range = "30d"): Range =>
  s && isRange(s) ? s : fallback;
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "collection";

/** Each collection with what it holds now: groups, runs and failing groups. */
const collectionRows = (
  list: ReadonlyArray<Collection>,
  reports: ReadonlyArray<ReportLite>,
  refs: ReadonlyArray<Ref>,
  since: string | undefined,
) =>
  list.map((c) => {
    const filters = parseQuery(c.query);
    const runs = runsOf(matching({ reports, refs, filters, since }).kept);
    return {
      ...c,
      runs: runs.length,
      failing: runs.filter((r) => r.failed > 0).length,
      repos: new Set(runs.map((r) => `${r.owner}/${r.repo}`)).size,
    };
  });

/** The filters a request means: a collection's query (by `c`), then the request's own. */
const filtersOf = (collections: ReadonlyArray<Collection>, c: string | null, q: string | null) => {
  const scope = c ? collections.find((x) => x.id === c) : undefined;
  return [...parseQuery(scope?.query ?? ""), ...parseQuery(q ?? "")];
};

const VIEW_COUNTS = [
  "release",
  "branch",
  "pull_request",
  "environment",
  "tag",
  "tool",
  "workflow",
] as const;

const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: `${maxAgeSeconds} seconds` as const,
});

export const ApiRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const results = yield* ResultStore.Service;
    const ingest = yield* Ingest.Service;
    const retention = yield* Retention.Service;
    const auth = yield* Auth.Service;
    const cfg = yield* AppConfig.Service;

    yield* router.add(
      "GET",
      "/api/health",
      json({ ok: true, source: cfg.source, store: Option.isSome(cfg.s3) ? "s3" : "fs" }),
    );

    yield* router.add("GET", "/api/session", (req) =>
      Effect.succeed(
        json({
          authenticated: auth.verifySession(req.cookies[SESSION_COOKIE]),
          authRequired: auth.enabled,
        }),
      ),
    );

    yield* router.add("POST", "/api/login", () =>
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(LoginBody).pipe(
          Effect.orElseSucceed(() => ({ password: "" })),
        );
        if (!auth.enabled) return json({ ok: true, authRequired: false });
        if (!auth.checkPassword(body.password)) return json({ error: "wrong password" }, 401);
        return yield* HttpServerResponse.setCookie(
          SESSION_COOKIE,
          auth.issueSession(),
          cookieOptions(7 * 24 * 3600),
        )(json({ ok: true })).pipe(Effect.orDie);
      }),
    );

    yield* router.add(
      "POST",
      "/api/logout",
      HttpServerResponse.setCookie(
        SESSION_COOKIE,
        "",
        cookieOptions(0),
      )(json({ ok: true })).pipe(Effect.orDie),
    );

    yield* router.add(
      "GET",
      "/api/repos",
      Effect.map(results.repos(), (r) => json(r)),
    );

    yield* router.add("GET", "/api/runs", (req) => {
      const q = query(req);
      const limitRaw = Number(q.get("limit") ?? "100");
      const owner = optional(q.get("owner"));
      const repo = optional(q.get("repo"));
      const branch = optional(q.get("branch"));
      const tool = optional(q.get("tool"));
      const runId = optional(q.get("runId"));
      return Effect.map(
        results.listRuns({
          ...(owner ? { owner } : {}),
          ...(repo ? { repo } : {}),
          ...(branch ? { branch } : {}),
          ...(tool ? { tool } : {}),
          ...(runId ? { runId } : {}),
          limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        }),
        (rows) => json(rows),
      );
    });

    /** The home page: what state each repository is in, then the collections. */
    /** The overview, or a scope of it: every repository the filters leave, with its state. */
    yield* router.add("GET", "/api/overview", (req) =>
      Effect.gen(function* () {
        const q = query(req);
        const range = rangeOf(q.get("range"));
        const since = sinceOf(range);
        const all = yield* results.reports({ since });
        const refs = yield* results.refs();
        const collections = yield* results.collections();
        const filters = filtersOf(collections, q.get("c"), q.get("q"));
        const reports = filters.length
          ? matching({ reports: all, refs, filters, since }).kept
          : all;
        const counts = Object.fromEntries(
          VIEW_COUNTS.map((g) => [
            g,
            computeGroups({ reports, refs, by: g, filters: [], since }).length,
          ]),
        );
        return json({
          range,
          query: q.get("q") ?? "",
          repos: computeOverview({ reports, refs, since }),
          collections: collectionRows(collections, all, refs, since),
          counts: { ...counts, run: runsOf(reports).length },
          repoList: yield* results.repos(),
        });
      }),
    );

    /** A view: runs grouped by a field, filtered by a query, inside a time range. */
    yield* router.add("GET", "/api/groups", (req) =>
      Effect.gen(function* () {
        const q = query(req);
        const by = groupByOf(q.get("by"));
        const range = rangeOf(q.get("range"));
        const since = sinceOf(range);
        const reports = yield* results.reports({ since });
        const refs = yield* results.refs();
        const collections = yield* results.collections();
        const filters = filtersOf(collections, q.get("c"), q.get("q"));
        const rows = computeGroups({ reports, refs, by, filters, since });
        const latest = rows.flatMap((g) => (g.latest ? [g.latest] : []));
        const counts = Object.fromEntries(
          VIEW_COUNTS.map((g) => [
            g,
            computeGroups({ reports, refs, by: g, filters: [], since }).length,
          ]),
        );
        return json({
          by,
          range,
          query: q.get("q") ?? "",
          groups: rows,
          totals: {
            runs: runsOf(matching({ reports, refs, filters, since }).kept).length,
            passRate:
              latest.length === 0
                ? null
                : latest.reduce((a, r) => a + r.passRate, 0) / latest.length,
            failingNow: rows.filter((g) => g.verdict === "failed").length,
            flaky: latest.reduce((a, r) => a + r.flaky, 0),
          },
          counts: { ...counts, run: runsOf(reports).length },
          repos: yield* results.repos(),
          collections,
        });
      }),
    );

    /** One group: its runs, the failing tests of the latest run, the common errors. */
    yield* router.add("GET", "/api/groups/:by/:key", (req) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const by = groupByOf(params.by ?? null);
        const key = params.key ?? "";
        const q = query(req);
        const range = rangeOf(q.get("range"), "90d");
        const since = sinceOf(range);
        const reports = yield* results.reports({ since });
        const refs = yield* results.refs();
        const filters = filtersOf(yield* results.collections(), q.get("c"), q.get("q"));
        const rows = computeGroups({ reports, refs, by, filters, since, trendPoints: 60 });
        const group = rows.find((g) => g.key === key);
        if (!group) return notFound("group");
        const mine = reports.filter((r) => r.owner === group.owner && r.repo === group.repo);
        const runIds = new Set(group.trend.map((t) => t.runId));
        const runs = runsOf(mine.filter((r) => runIds.has(r.runId)));
        const latestIds = group.latest?.reportIds ?? [];
        const failing: Array<{
          testId: string;
          name: string;
          suite: string | null;
          tool: string;
          reportId: string;
          message: string | null;
          duration: number;
        }> = [];
        const errors = new Map<string, number>();
        for (const id of latestIds) {
          const tests = yield* results.testsOf(id);
          for (const t of tests) {
            if (t.status !== "failed") continue;
            failing.push({
              testId: t.testId,
              name: t.name,
              suite: t.suite,
              tool: t.tool,
              reportId: id,
              message: t.message,
              duration: t.duration,
            });
            const head = (t.message ?? "unknown error").split("\n")[0]?.slice(0, 120) ?? "";
            errors.set(head, (errors.get(head) ?? 0) + 1);
          }
        }
        const flaky: Array<{ testId: string; name: string; tool: string; occurrences: number }> =
          [];
        const flakyCount = new Map<string, { name: string; tool: string; n: number }>();
        for (const run of runs) {
          for (const id of run.reportIds) {
            const tests = yield* results.testsOf(id);
            for (const t of tests) {
              if (!t.flaky) continue;
              const cur = flakyCount.get(t.testId) ?? { name: t.name, tool: t.tool, n: 0 };
              cur.n++;
              flakyCount.set(t.testId, cur);
            }
          }
        }
        for (const [testId, v] of flakyCount)
          flaky.push({ testId, name: v.name, tool: v.tool, occurrences: v.n });
        flaky.sort((a, b) => b.occurrences - a.occurrences);
        const neighbours = rows.map((g) => g.key);
        const at = neighbours.indexOf(key);
        return json({
          group,
          runs,
          failing,
          errors: [...errors.entries()]
            .map(([message, count]) => ({ message, count }))
            .sort((a, b) => b.count - a.count),
          flaky,
          previous: neighbours[at + 1] ?? null,
          next: at > 0 ? (neighbours[at - 1] ?? null) : null,
        });
      }),
    );

    /** Suggestions for the search bar: fields, then values with counts. */
    yield* router.add("GET", "/api/fields", (req) =>
      Effect.gen(function* () {
        const typed = query(req).get("q") ?? "";
        const reports = yield* results.reports({});
        const refs = yield* results.refs();
        return json(suggest(indexValues(reports, refs), typed));
      }),
    );

    /** Every collection with what it holds now: groups, runs and failing groups over 30 days. */
    yield* router.add("GET", "/api/collections", () =>
      Effect.gen(function* () {
        const list = yield* results.collections();
        const since = sinceOf("30d");
        const reports = yield* results.reports({ since });
        const refs = yield* results.refs();
        return json(collectionRows(list, reports, refs, since));
      }),
    );

    yield* router.add("POST", "/api/collections", () =>
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(CollectionInput).pipe(
          Effect.mapError(() => new BadRequest({ detail: "name and query are required" })),
        );
        const existing = yield* results.collections();
        let id = slug(body.name);
        for (let n = 2; existing.some((c) => c.id === id); n++) id = `${slug(body.name)}-${n}`;
        const c: Collection = {
          id,
          name: body.name,
          description: body.description ?? "",
          query: body.query,
          createdAt: new Date().toISOString(),
        };
        yield* results.saveCollection(c);
        return json(c, 201);
      }),
    );

    yield* router.add("DELETE", "/api/collections/:id", () =>
      Effect.gen(function* () {
        const { id = "" } = yield* HttpRouter.params;
        const removed = yield* results.deleteCollection(id);
        return removed ? json({ ok: true }) : notFound("collection");
      }),
    );

    yield* router.add("GET", "/api/reports/:reportId", () =>
      Effect.gen(function* () {
        const { reportId = "" } = yield* HttpRouter.params;
        const run = yield* results.getRun(reportId);
        if (Option.isNone(run)) return notFound("report");
        const report = yield* results.getReport(reportId);
        const tests = yield* results.testsOf(reportId);
        const metrics = yield* results.metricsOf(reportId);
        const artifacts = yield* results.artifactsOfRun(
          run.value.owner,
          run.value.repo,
          run.value.runId,
        );
        const siblings = yield* results.listRuns({
          owner: run.value.owner,
          repo: run.value.repo,
          runId: run.value.runId,
          limit: 50,
        });
        return json({
          run: run.value,
          tests,
          metrics,
          artifacts,
          siblings: siblings.filter((s) => s.reportId !== reportId),
          report: Option.getOrNull(report),
          artifactRefs: Option.isSome(report) ? artifactsOf(report.value) : [],
        });
      }),
    );

    yield* router.add("GET", "/api/tests/:owner/:repo/:testId/history", (req) =>
      Effect.gen(function* () {
        const { owner = "", repo = "", testId = "" } = yield* HttpRouter.params;
        const limitRaw = Number(query(req).get("limit") ?? "50");
        const rows = yield* results.testHistory(
          owner,
          repo,
          testId,
          Number.isFinite(limitRaw) ? limitRaw : 50,
        );
        return json(rows);
      }),
    );

    /** A short-lived link onto the artifact origin, which sets its own cookie and redirects. */
    yield* router.add("GET", "/api/artifacts/:artifactId/link", (req) =>
      Effect.gen(function* () {
        const { artifactId = "" } = yield* HttpRouter.params;
        const art = yield* results.getArtifact(artifactId);
        if (Option.isNone(art)) return notFound("artifact");
        const path = query(req).get("path") ?? "index.html";
        const origin = artifactOriginFor(req, cfg.artifactPort);
        const target = `${origin}/a/${art.value.owner}/${art.value.repo}/${artifactId}/${path}`;
        return json({
          url: auth.enabled ? `${target}?t=${encodeURIComponent(auth.issueHandoff())}` : target,
          cached: art.value.state === "cached",
        });
      }),
    );

    yield* router.add("POST", "/api/retention/sweep", () => Effect.map(retention.sweep(), json));

    yield* router.add("POST", "/api/ingest", () =>
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(IngestBody).pipe(
          Effect.orElseSucceed((): typeof IngestBody.Type => ({})),
        );
        const opts = body.limit !== undefined ? { limit: body.limit } : {};
        const summary =
          body.owner && body.repo
            ? yield* ingest.ingestRepo({ owner: body.owner, repo: body.repo }, opts)
            : yield* ingest.ingestAll(opts);
        return json(summary);
      }),
    );

    yield* router.add(
      "POST",
      "/api/rebuild",
      Effect.map(results.rebuild(), (r) => json(r)),
    );
  }),
);

/** Same host as the request, on the artifact port. ARTIFACT_ORIGIN overrides this in production. */
function artifactOriginFor(req: HttpServerRequest.HttpServerRequest, artifactPort: number): string {
  const override = process.env.ARTIFACT_ORIGIN;
  if (override) return override.replace(/\/$/, "");
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(":")[0];
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${host}:${artifactPort}`;
}

/** Map typed failures to responses so one bad request never takes the server down. */
const errorsToResponses = HttpRouter.middleware<{
  handles: ResultStore.DbError | ArtifactStore.StoreError | BadRequest;
}>()(
  (httpEffect) =>
    httpEffect.pipe(
      Effect.catchTags({
        BadRequest: (e) => Effect.succeed(json({ error: e.detail }, 400)),
        "ResultStore.DbError": (e) =>
          Effect.succeed(
            json({ error: "database error", operation: e.operation, detail: String(e.cause) }, 500),
          ),
        "ArtifactStore.StoreError": (e) =>
          Effect.succeed(
            json(
              { error: "store error", operation: e.operation, key: e.key, detail: String(e.cause) },
              500,
            ),
          ),
      }),
    ),
  { global: true },
);

export const WebApp = (root: string) =>
  HttpStaticServer.layer({ root, index: "index.html", spa: true, cacheControl: "no-cache" });

export const App = (webRoot: string) =>
  Layer.mergeAll(ApiRoutes, WebApp(webRoot), requireSession).pipe(
    Layer.provideMerge(errorsToResponses),
  );

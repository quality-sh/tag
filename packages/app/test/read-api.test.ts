// The read API's OpenAPI document and its routes over the real app, on the fixtures.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenApi } from "effect/http-api";
import { TagApi } from "../src/server/http-api.ts";
import { serveApp, signInAndIngest } from "./helpers.ts";

/** Every read route the dashboard and agents use, in OpenAPI path syntax. */
const READ_ROUTES = [
  "/api/health",
  "/api/overview",
  "/api/repos",
  "/api/repositories",
  "/api/fields",
  "/api/groups",
  "/api/groups/{by}/{key}",
  "/api/runs",
  "/api/reports/{reportId}",
  "/api/tests/{owner}/{repo}/{testId}/history",
  "/api/collections",
  "/api/suggestions",
];

describe("the OpenAPI document", () => {
  test("parses as JSON and names every read route, each a GET, and nothing else", () => {
    const spec = JSON.parse(JSON.stringify(OpenApi.fromApi(TagApi))) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(spec.openapi).toStartWith("3.1");
    expect(spec.info.title).toBe("TAG");
    expect(Object.keys(spec.paths).sort()).toEqual([...READ_ROUTES].sort());
    for (const path of READ_ROUTES) expect(Object.keys(spec.paths[path] ?? {})).toEqual(["get"]);
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(["password", "session"]);
  });
});

describe("the read API over the app", () => {
  let app: Awaited<ReturnType<typeof serveApp>>;
  let call: Awaited<ReturnType<typeof signInAndIngest>>;
  beforeAll(async () => {
    app = await serveApp();
    call = await signInAndIngest(app.base);
  });
  afterAll(() => app.stop());

  test("serves the document and the docs page without a session, and nothing else", async () => {
    const served = await fetch(`${app.base}/api/openapi.json`);
    expect(served.status).toBe(200);
    const spec = (await served.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths).sort()).toEqual([...READ_ROUTES].sort());
    const docs = await fetch(`${app.base}/api/docs`);
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${app.base}/api/groups`)).status).toBe(401);
  });

  test("answers each read route with the declared shapes", async () => {
    const health = (await (await call("/api/health")).json()) as Record<string, unknown>;
    expect(health).toEqual({ ok: true, source: "fixtures", store: "fs" });

    const runs = (await (await call("/api/runs?limit=2")).json()) as Array<{ reportId: string }>;
    expect(runs).toHaveLength(2);
    const reportId = runs[0]?.reportId ?? "";
    const report = (await (await call(`/api/reports/${reportId}`)).json()) as {
      run: { reportId: string };
      tests: Array<{ testId: string; repo: string }>;
    };
    expect(report.run.reportId).toBe(reportId);
    expect(report.tests.length).toBeGreaterThan(0);

    const groups = (await (await call("/api/groups?by=tool&range=all")).json()) as {
      by: string;
      groups: Array<{ key: string; owner: string; repo: string }>;
    };
    expect(groups.by).toBe("tool");
    const first = groups.groups[0];
    if (!first) throw new Error("no tool groups in the fixtures");
    const page = (await (
      await call(`/api/groups/tool/${encodeURIComponent(first.key)}?range=all`)
    ).json()) as { group: { key: string } };
    expect(page.group.key).toBe(first.key);

    // A window that ends before any fixture run leaves nothing to group.
    const empty = (await (
      await call("/api/groups?by=tool&range=all&to=2000-01-01T00:00:00Z")
    ).json()) as { groups: unknown[] };
    expect(empty.groups).toEqual([]);

    const test0 = report.tests[0];
    if (!test0) throw new Error("the report has no tests");
    const [owner, repo] = [first.owner, first.repo];
    const history = (await (
      await call(`/api/tests/${owner}/${repo}/${encodeURIComponent(test0.testId)}/history`)
    ).json()) as Array<{ testId: string; metrics: unknown[] }>;
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.testId).toBe(test0.testId);

    const fields = (await (await call("/api/fields?q=bra")).json()) as Array<{ field: string }>;
    expect(fields.map((f) => f.field)).toContain("branch");
    expect(await (await call("/api/collections")).json()).toEqual([]);
  });

  test("a missing group or report is 404, a bad group-by or a missing org 400", async () => {
    const group = await call("/api/groups/tool/no-such-tool");
    expect(group.status).toBe(404);
    expect(await group.json()).toEqual({ _tag: "NotFound", error: "group not found" });
    expect((await call("/api/reports/no-such-report")).status).toBe(404);
    expect((await call("/api/groups/colour/red")).status).toBe(400);
    expect((await call("/api/suggestions")).status).toBe(400);
  });
});

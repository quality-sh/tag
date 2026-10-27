// The MCP endpoint over the real app: an Effect MCP client initializes, lists the tools and
// calls them against the fixtures; /mcp keeps out callers without a session or the password.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { MCP_PATH, OPENAPI_RESOURCE } from "../src/server/mcp.ts";
import { serveApp, signInAndIngest } from "./helpers.ts";

const TOOLS = [
  "group",
  "groups",
  "list_fields",
  "list_repositories",
  "overview",
  "report",
  "runs",
  "test_history",
];

const withClient = <A, E>(
  base: string,
  headers: Record<string, string>,
  use: (client: McpClient.McpClient) => Effect.Effect<A, E>,
  protocol:
    typeof McpProtocol.v2025_11_25 | typeof McpProtocol.v2026_07_28 = McpProtocol.v2025_11_25,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* McpClient.McpClient);
    }).pipe(
      Effect.provide(
        McpClient.layerHttp({
          name: "tag-test",
          version: "1",
          url: `${base}${MCP_PATH}`,
          protocol,
          headers,
        }).pipe(Layer.provide(FetchHttpClient.layer)),
      ),
    ),
  );

const initialize = (base: string, headers: Record<string, string>) =>
  fetch(`${base}${MCP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "curl", version: "1" },
      },
    }),
  });

describe("the MCP endpoint with a password", () => {
  let app: Awaited<ReturnType<typeof serveApp>>;
  let cookie: string;
  beforeAll(async () => {
    app = await serveApp();
    await signInAndIngest(app.base);
    const login = await fetch(`${app.base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test" }),
    });
    cookie = login.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  });
  afterAll(() => app.stop());

  test("is 401 without a session or with the wrong bearer", async () => {
    const none = await initialize(app.base, {});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toStartWith("Bearer");
    expect((await initialize(app.base, { authorization: "Bearer wrong" })).status).toBe(401);
  });

  test("initializes, lists the tools and calls them with the password as bearer", async () => {
    const result = await withClient(app.base, { authorization: "Bearer test" }, (client) =>
      Effect.gen(function* () {
        const tools = yield* client.listTools();
        const byName = new Map(tools.map((t) => [t.name, t]));
        const call = (name: string, args: Record<string, unknown> = {}) => {
          const tool = byName.get(name);
          if (!tool) return Effect.die(`no tool ${name}`);
          return client.callTool({ tool, arguments: args });
        };
        const repositories = yield* call("list_repositories");
        const groups = yield* call("groups", { by: "tool", range: "all" });
        const missing = yield* call("report", { reportId: "no-such-report" });
        const resources = yield* client.listResources();
        const openapi = yield* client.readResource({ uri: OPENAPI_RESOURCE });
        return { tools, repositories, groups, missing, resources, openapi };
      }),
    );
    expect(result.tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const tool of result.tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(80);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }

    const repositories = result.repositories.structuredContent as {
      repositories: Array<{ owner: string; repo: string }>;
    };
    expect(repositories.repositories.map((r) => `${r.owner}/${r.repo}`)).toContain("acme/widgets");

    const groups = result.groups.structuredContent as {
      by: string;
      groups: Array<{ key: string }>;
    };
    expect(groups.by).toBe("tool");
    // The tool and the HTTP route call the same service, so they answer alike.
    const http = (await (
      await fetch(`${app.base}/api/groups?by=tool&range=all`, { headers: { cookie } })
    ).json()) as typeof groups;
    expect(groups.groups.length).toBeGreaterThan(0);
    expect(groups.groups.map((g) => g.key)).toEqual(http.groups.map((g) => g.key));

    expect(result.missing.isError).toBe(true);
    expect(JSON.stringify(result.missing.content)).toContain("report not found");

    expect(result.resources.map((r) => r.uri)).toEqual([OPENAPI_RESOURCE]);
    const text = result.openapi.contents[0];
    const spec = JSON.parse(text && "text" in text ? text.text : "{}") as { paths: object };
    expect(Object.keys(spec.paths)).toContain("/api/groups/{by}/{key}");
  });

  test("takes the dashboard session cookie too, over the stateless protocol", async () => {
    const tools = await withClient(
      app.base,
      { cookie },
      (client) => client.listTools(),
      McpProtocol.v2026_07_28,
    );
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
  });
});

describe("the MCP endpoint with auth off", () => {
  let app: Awaited<ReturnType<typeof serveApp>>;
  beforeAll(async () => {
    app = await serveApp({ overrides: { password: Redacted.make("") } });
  });
  afterAll(() => app.stop());

  test("is open", async () => {
    expect((await initialize(app.base, {})).status).toBe(200);
    const tools = await withClient(app.base, {}, (client) => client.listTools());
    expect(tools).toHaveLength(TOOLS.length);
  });
});

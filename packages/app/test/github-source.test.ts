import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AppConfig, type GithubConfig } from "../src/server/config.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { GitHubSource } from "../src/server/github-source.ts";
import { testConfig } from "./helpers.ts";

type Hit = { method: string; url: URL; auth: string | undefined };

/** A GitHub that answers from a table of path -> body, remembering every request. */
const fakeGithub = (routes: Record<string, (url: URL) => unknown>) => {
  const hits: Hit[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      hits.push({ method: request.method, url, auth: request.headers["authorization"] });
      const route = routes[url.pathname];
      if (!route)
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
        );
      const out = route(url);
      return HttpClientResponse.fromWeb(
        request,
        out instanceof Response
          ? out
          : new Response(JSON.stringify(out), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      );
    }),
  );
  return { hits, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const cfg = (over: Partial<GithubConfig> = {}): GithubConfig => ({
  auth: { _tag: "token", token: Redacted.make("ghp_test") },
  apiUrl: "https://api.github.test",
  repos: [{ owner: "acme", repo: "widgets" }],
  ...over,
});

const sourceWith = (g: GithubConfig, http: Layer.Layer<HttpClient.HttpClient>) =>
  GitHubSource.layer.pipe(
    Layer.provide(http),
    Layer.provide(Layer.succeed(AppConfig.Service, testConfig({ github: Option.some(g) }))),
  );

const using = <A, E>(
  layer: Layer.Layer<ArtifactSource.Service>,
  f: (s: ArtifactSource.Interface) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* ArtifactSource.Service;
      return yield* f(s);
    }).pipe(Effect.provide(layer)),
  );

const run = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  run_number: id - 1000,
  name: "ci",
  head_branch: "main",
  head_sha: "e4f5a6b".padEnd(40, "0"),
  html_url: `https://github.com/acme/widgets/actions/runs/${id}`,
  status: "completed",
  conclusion: "success",
  run_started_at: `2026-10-2${id % 10}T10:00:00Z`,
  created_at: `2026-10-2${id % 10}T09:59:00Z`,
  event: "push",
  ...extra,
});

describe("GitHubSource", () => {
  test("lists runs with the token, mapping GitHub's fields to RunMeta", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/runs": () => ({ workflow_runs: [run(1001), run(1002)] }),
    });
    const runs = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.listRuns({ owner: "acme", repo: "widgets" }, { limit: 20, branch: "main" }),
    );
    expect(runs.map((r) => r.runId)).toEqual(["1001", "1002"]);
    expect(runs[0]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      runNumber: 1,
      workflow: "ci",
      branch: "main",
      buildUrl: "https://github.com/acme/widgets/actions/runs/1001",
      timestamp: "2026-10-21T10:00:00Z",
      status: "success",
      tags: ["event:push"],
    });
    const hit = gh.hits[0];
    expect(hit?.auth).toBe("Bearer ghp_test");
    expect(hit?.url.searchParams.get("branch")).toBe("main");
    expect(hit?.url.searchParams.get("status")).toBe("completed");
    expect(hit?.url.searchParams.get("per_page")).toBe("20");
  });

  test("pages until a short page and stops at the limit", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/runs": (url) => ({
        workflow_runs: Array.from({ length: 100 }, (_, i) =>
          run(1000 + Number(url.searchParams.get("page")) * 1000 + i),
        ),
      }),
    });
    const runs = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.listRuns({ owner: "acme", repo: "widgets" }, { limit: 150 }),
    );
    expect(runs.length).toBe(150);
    expect(gh.hits.length).toBe(2);
  });

  test("lists artifacts with expiry", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/runs/1001/artifacts": () => ({
        artifacts: [
          {
            id: 77,
            name: "playwright-report",
            size_in_bytes: 1234,
            expired: false,
            expires_at: "2027-01-01T00:00:00Z",
          },
          { id: 78, name: "old", size_in_bytes: 1, expired: true, expires_at: null },
        ],
      }),
    });
    const arts = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.listArtifacts({ owner: "acme", repo: "widgets", runId: "1001" }),
    );
    expect(arts).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        runId: "1001",
        artifactId: "77",
        name: "playwright-report",
        sizeBytes: 1234,
        expired: false,
        expiresAt: "2027-01-01T00:00:00Z",
      },
      {
        owner: "acme",
        repo: "widgets",
        runId: "1001",
        artifactId: "78",
        name: "old",
        sizeBytes: 1,
        expired: true,
      },
    ]);
  });

  test("lists repository artifacts across pages with run, branch and commit metadata", async () => {
    const artifact = (id: number, runId = 1001) => ({
      id,
      name: "report",
      size_in_bytes: 123,
      expired: false,
      expires_at: "2027-01-01T00:00:00Z",
      workflow_run: { id: runId, head_branch: "main", head_sha: "abc123" },
    });
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts": (url) => ({
        artifacts:
          url.searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, (_, i) => artifact(200 - i, i === 0 ? 1002 : 1001))
            : [artifact(100)],
      }),
    });
    const arts = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.listRepoArtifacts({ owner: "acme", repo: "widgets" }, new Set(["1001"])),
    );
    expect(arts).toHaveLength(100);
    expect(arts[99]).toEqual({
      owner: "acme",
      repo: "widgets",
      artifactId: "100",
      runId: "1001",
      name: "report",
      sizeBytes: 123,
      expired: false,
      expiresAt: "2027-01-01T00:00:00Z",
      branch: "main",
      commit: "abc123",
    });
    expect(
      gh.hits.map((h) => [
        h.url.pathname,
        h.url.searchParams.get("per_page"),
        h.url.searchParams.get("page"),
      ]),
    ).toEqual([
      ["/repos/acme/widgets/actions/artifacts", "100", "1"],
      ["/repos/acme/widgets/actions/artifacts", "100", "2"],
    ]);
    expect(gh.hits[0]?.auth).toBe("Bearer ghp_test");
  });

  test("checks only one full artifact page when no runs need indexing", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts": () => ({
        artifacts: Array.from({ length: 100 }, (_, id) => ({
          id,
          name: "report",
          size_in_bytes: 1,
          expired: false,
          workflow_run: { id: 1001, head_branch: null, head_sha: "abc123" },
        })),
      }),
    });
    const arts = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.listRepoArtifacts({ owner: "acme", repo: "widgets" }, new Set()),
    );
    expect(arts).toEqual([]);
    expect(gh.hits).toHaveLength(1);
  });

  test("builds refs from releases, tags, pull requests and deployments", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/releases": () => [
        {
          tag_name: "v2.4.0",
          name: "Payments v2",
          html_url: "https://github.com/acme/widgets/releases/tag/v2.4.0",
          draft: false,
          prerelease: false,
          target_commitish: "main",
          published_at: "2026-10-22T15:00:00Z",
          created_at: "2026-10-22T14:00:00Z",
        },
        {
          tag_name: "v3.0.0-draft",
          name: null,
          html_url: "x",
          draft: true,
          prerelease: true,
          target_commitish: null,
          published_at: null,
          created_at: "2026-10-23T00:00:00Z",
        },
      ],
      "/repos/acme/widgets/tags": () => [
        { name: "v2.4.0", commit: { sha: "e4f5a6b".padEnd(40, "0") } },
        { name: "v2.3.0", commit: { sha: "a1b2c3d".padEnd(40, "0") } },
      ],
      "/repos/acme/widgets/pulls": () => [
        {
          number: 42,
          title: "Retry checkout on 5xx",
          html_url: "https://github.com/acme/widgets/pull/42",
          draft: false,
          created_at: "2026-10-23T07:50:00Z",
          closed_at: null,
          merged_at: null,
          head: { ref: "feat/checkout-retry", sha: "c0ffee1".padEnd(40, "0") },
          base: { ref: "main" },
          user: { login: "jo" },
        },
        {
          number: 41,
          title: "Old",
          html_url: "https://github.com/acme/widgets/pull/41",
          draft: null,
          created_at: "2026-10-01T00:00:00Z",
          closed_at: "2026-10-02T00:00:00Z",
          merged_at: "2026-10-02T00:00:00Z",
          head: { ref: "fix/old", sha: "deadbeef".padEnd(40, "0") },
          base: { ref: "main" },
          user: null,
        },
      ],
      "/repos/acme/widgets/deployments": () => [
        {
          id: 1,
          sha: "a1b2c3d".padEnd(40, "0"),
          ref: "main",
          environment: "production",
          created_at: "2026-10-20T11:00:00Z",
        },
        {
          id: 2,
          sha: "e4f5a6b".padEnd(40, "0"),
          ref: "main",
          environment: "production",
          created_at: "2026-10-22T15:30:00Z",
        },
      ],
    });
    const refs = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.listRefs({ owner: "acme", repo: "widgets" }),
    );
    const byKind = (k: string) => refs.filter((r) => r.kind === k);
    expect(byKind("release")).toEqual([
      {
        kind: "release",
        key: "v2.4.0",
        owner: "acme",
        repo: "widgets",
        commit: "e4f5a6b".padEnd(40, "0"),
        branch: "main",
        timestamp: "2026-10-22T15:00:00Z",
        title: "Payments v2",
        url: "https://github.com/acme/widgets/releases/tag/v2.4.0",
        meta: { prerelease: false },
      },
    ]);
    expect(byKind("tag").map((r) => r.key)).toEqual(["v2.3.0"]);
    expect(byKind("pull_request").map((r) => [r.key, r.branch, r.meta])).toEqual([
      ["#42", "feat/checkout-retry", { base: "main", author: "jo" }],
      [
        "#41",
        "fix/old",
        { base: "main", closedAt: "2026-10-02T00:00:00Z", mergedAt: "2026-10-02T00:00:00Z" },
      ],
    ]);
    expect(byKind("deployment")).toMatchObject([
      { key: "production", commit: "e4f5a6b".padEnd(40, "0"), timestamp: "2026-10-22T15:30:00Z" },
    ]);
  });

  test("downloads an artifact through the signed redirect without the token", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts/77/zip": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://blob.test/signed?sig=1" },
        }),
      "/signed": () => new Response(zip, { status: 200 }),
    });
    const bytes = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.openArtifact({
        owner: "acme",
        repo: "widgets",
        runId: "1001",
        artifactId: "77",
        name: "playwright-report",
        sizeBytes: 8,
      }),
    );
    expect([...bytes]).toEqual([...zip]);
    expect(gh.hits.map((h) => [h.url.host, h.auth])).toEqual([
      ["api.github.test", "Bearer ghp_test"],
      ["blob.test", undefined],
    ]);
  });

  test("an expired artifact is a typed source error", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts/78/zip": () => new Response(null, { status: 410 }),
    });
    const r = await using(sourceWith(cfg(), gh.layer), (s) =>
      s
        .openArtifact({
          owner: "acme",
          repo: "widgets",
          runId: "1001",
          artifactId: "78",
          name: "old",
          sizeBytes: 1,
        })
        .pipe(Effect.flip),
    );
    expect(r._tag).toBe("ArtifactSource.SourceError");
    expect(r.detail).toContain("expired");
  });

  test("a token needs GITHUB_REPOS; an App lists its installation's repositories", async () => {
    const bare = fakeGithub({});
    const err = await using(sourceWith(cfg({ repos: [] }), bare.layer), (s) =>
      s.repos().pipe(Effect.flip),
    );
    expect(err.detail).toContain("GITHUB_REPOS");

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const gh = fakeGithub({
      "/app/installations/555/access_tokens": () => ({
        token: "ghs_installation",
        expires_at: "2026-10-24T12:00:00Z",
      }),
      "/installation/repositories": () => ({
        repositories: [
          { name: "widgets", owner: { login: "acme" } },
          { name: "gadgets", owner: { login: "acme" } },
        ],
      }),
    });
    const app = cfg({
      repos: [],
      auth: {
        _tag: "app",
        appId: "12345",
        privateKey: Redacted.make(pem),
        installationId: "555",
      },
    });
    const repos = await using(sourceWith(app, gh.layer), (s) =>
      Effect.andThen(s.repos(), s.repos()),
    );
    expect(repos).toEqual([
      { owner: "acme", repo: "widgets" },
      { owner: "acme", repo: "gadgets" },
    ]);
    // One mint with the App JWT, then installation-token calls; the second repos() reuses the token.
    expect(gh.hits.map((h) => [h.method, h.url.pathname])).toEqual([
      ["POST", "/app/installations/555/access_tokens"],
      ["GET", "/installation/repositories"],
      ["GET", "/installation/repositories"],
    ]);
    expect(gh.hits[0]?.auth?.split(".").length).toBe(3);
    expect(gh.hits[1]?.auth).toBe("Bearer ghs_installation");
  });
});

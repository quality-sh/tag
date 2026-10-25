// GitHubSource listings: run pages revalidated by ETag, pagination and the
// 1000-run cap, artifact listings and downloads, and the refs of a repository.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { fakeGithub } from "./helpers.ts";
import { cfg, run, sourceWith, using } from "./github-fixtures.ts";

describe("GitHubSource", () => {
  test("revalidates run pages with their ETags and keeps metadata on 304 for failed downloads", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/runs": (_url, headers) =>
        headers["if-none-match"] === '"runs-v1"'
          ? new Response(null, { status: 304 })
          : Response.json({ workflow_runs: [run(1001)] }, { headers: { etag: '"runs-v1"' } }),
    });
    await using(sourceWith(cfg(), gh.layer), (source) =>
      Effect.gen(function* () {
        const repo = { owner: "acme", repo: "widgets" };
        const first = yield* source.listRuns(repo, { limit: 20 });
        expect(yield* source.listRuns(repo, { limit: 20 })).toEqual(first);
        expect(gh.hits.map((hit) => hit.etag)).toEqual([undefined, '"runs-v1"']);
        yield* source.listRuns(repo, { limit: 20, branch: "main" });
        yield* source.listRuns(repo, { limit: 100 });
        expect(gh.hits.slice(2).map((hit) => hit.etag)).toEqual([undefined, undefined]);
      }),
    );
  });

  test("walks past GitHub's 1000-run page cap by narrowing the created window", async () => {
    const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
    const down = (from: number, to: number) =>
      Array.from({ length: from - to + 1 }, (_, i) => from - i);
    const batch = (ids: number[], dayOf: (i: number) => string) =>
      ids.map((id, i) => run(id, { created_at: `${dayOf(i)}T09:59:00Z`, run_started_at: null }));
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/runs": (url) => {
        const created = url.searchParams.get("created");
        const page = Number(url.searchParams.get("page"));
        const slice = <T>(xs: T[]) => xs.slice((page - 1) * 100, page * 100);
        // The open window stops at 1000 results, 100 a day, the oldest on the 11th.
        if (created === ">=2026-09-25")
          return {
            workflow_runs: slice(batch(down(5000, 4001), (i) => day(20 - Math.floor(i / 100)))),
          };
        // Closed at the 11th: that day again, then 50 older runs.
        if (created === "2026-09-25..2026-10-11")
          return {
            workflow_runs: slice(batch(down(4100, 3951), (i) => (i < 100 ? day(11) : day(9)))),
          };
        throw new Error(`unexpected created filter ${created}`);
      },
    });
    await using(sourceWith(cfg(), gh.layer), (source) =>
      Effect.gen(function* () {
        const runs = yield* source.listRuns(
          { owner: "acme", repo: "widgets" },
          { limit: Infinity, since: "2026-09-25T00:00:00Z" },
        );
        expect(runs).toHaveLength(1050);
        expect(new Set(runs.map((r) => r.runId)).size).toBe(1050);
        expect(runs.at(-1)?.runId).toBe("3951");
        expect(gh.hits).toHaveLength(12);
      }),
    );
  });

  test("checks HTTP errors on signed artifact downloads", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts/77/zip": () =>
        new Response(null, { status: 302, headers: { location: "https://blob.test/signed" } }),
      "/signed": () => Response.json({ message: "signature expired" }, { status: 401 }),
    });
    const error = await using(sourceWith(cfg(), gh.layer), (source) =>
      source
        .openArtifact({
          owner: "acme",
          repo: "widgets",
          runId: "1001",
          artifactId: "77",
          name: "report",
          sizeBytes: 1,
        })
        .pipe(Effect.flip),
    );
    expect(error).toMatchObject({
      status: 401,
      detail: "77: GitHub answered 401 signature expired",
    });
  });

  test("revalidates every run page and replaces changed ETags", async () => {
    let version = 1;
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/runs": (url, headers) => {
        const page = Number(url.searchParams.get("page"));
        const etag = `"page-${page}-v${page === 1 ? 1 : version}"`;
        if (headers["if-none-match"] === etag) return new Response(null, { status: 304 });
        const runs =
          page === 1 ? Array.from({ length: 100 }, (_, i) => run(1000 + i)) : [run(2000 + version)];
        return Response.json({ workflow_runs: runs }, { headers: { etag } });
      },
    });
    await using(sourceWith(cfg(), gh.layer), (source) =>
      Effect.gen(function* () {
        const repo = { owner: "acme", repo: "widgets" };
        expect((yield* source.listRuns(repo, { limit: 150 })).at(-1)?.runId).toBe("2001");
        version = 2;
        expect((yield* source.listRuns(repo, { limit: 150 })).at(-1)?.runId).toBe("2002");
        expect((yield* source.listRuns(repo, { limit: 150 })).at(-1)?.runId).toBe("2002");
        expect(gh.hits.map((hit) => hit.etag)).toEqual([
          undefined,
          undefined,
          '"page-1-v1"',
          '"page-2-v1"',
          '"page-1-v1"',
          '"page-2-v2"',
        ]);
      }),
    );
  });

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
      "/repos/acme/widgets/actions/artifacts/78/zip": () =>
        Response.json({ message: "Artifact has expired" }, { status: 410 }),
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
    expect(r.detail).toContain("Artifact has expired");
    expect(r.status).toBe(410);
  });
});

// Fixtures only the GitHubSource tests share: the token config, the run body,
// and the layer wiring that puts the real Installation service under the
// source. Everything else comes from helpers.ts.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient } from "effect/http";
import { AppConfig, type GithubConfig } from "../src/server/config.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { GitHubSource } from "../src/server/github-source.ts";
import { Installation } from "../src/server/installation.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { validateReport } from "@quality-sh/tag-schema";
import { buildZip } from "../src/server/zip.ts";
import { FIXTURES, fakeGithub, testConfig } from "./helpers.ts";

export const cfg = (over: Partial<GithubConfig> = {}): GithubConfig => ({
  auth: { _tag: "token", token: Redacted.make("ghp_test") },
  apiUrl: "https://api.github.test",
  slug: Option.none(),
  repos: [{ owner: "acme", repo: "widgets" }],
  ...over,
});

/** The source over the fake GitHub, with the real Installation service underneath. */
export const installationLayer = (config: Layer.Layer<AppConfig.Service>) =>
  Installation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        config,
        ResultStore.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              config,
              ArtifactStore.layerFs(join(mkdtempSync(join(tmpdir(), "tag-")), "store")),
            ),
          ),
        ),
      ),
    ),
    Layer.orDie,
  );

export const sourceWith = (g: GithubConfig, http: Layer.Layer<HttpClient.HttpClient>) => {
  const config = Layer.succeed(AppConfig.Service, testConfig({ github: Option.some(g) }));
  return GitHubSource.layer.pipe(
    Layer.provide(http),
    Layer.provideMerge(installationLayer(config)),
    Layer.provide(config),
  );
};

export const using = <A, E>(
  layer: Layer.Layer<ArtifactSource.Service>,
  f: (s: ArtifactSource.Interface) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* ArtifactSource.Service;
      return yield* f(s);
    }).pipe(Effect.provide(layer)),
  );

export const run = (id: number, extra: Record<string, unknown> = {}) => ({
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

/** The CTRF fixture as one artifact zip; each call is a new report with its own id. */
export const ctrfZip = async () => {
  const fixture = validateReport(
    await Bun.file(
      join(FIXTURES, "acme/widgets/run-1001/playwright-report/ctrf-report.json"),
    ).json(),
  );
  if (!fixture.ok) throw new Error(fixture.errors.join("; "));
  return buildZip([
    {
      path: "ctrf-report.json",
      bytes: new TextEncoder().encode(
        JSON.stringify({ ...fixture.report, reportId: randomUUID() }),
      ),
    },
  ]);
};

/**
 * The fake GitHub routes for acme/widgets: an empty repository, plus each given run with one
 * CTRF artifact, reachable by id, by run listing and by the repository's artifact listing.
 */
export const repoRoutes = async (
  runs: ReadonlyArray<ReturnType<typeof run>>,
  opts: { readonly onListRuns?: () => void } = {},
) => {
  const uploads = await Promise.all(
    runs.map(async (r) => {
      const zip = await ctrfZip();
      const artifact = {
        id: r.id + 50_000,
        name: "playwright-report",
        size_in_bytes: zip.length,
        expired: false,
        workflow_run: { id: r.id, head_branch: r.head_branch, head_sha: r.head_sha },
      };
      return { run: r, zip, artifact };
    }),
  );
  const routes: Parameters<typeof fakeGithub>[0] = {
    "/repos/acme/widgets": () => ({ default_branch: "main" }),
    "/repos/acme/widgets/environments": () => ({ environments: [] }),
    "/repos/acme/widgets/git/trees/main": () => ({ tree: [], truncated: false }),
    "/repos/acme/widgets/actions/runs": () => {
      opts.onListRuns?.();
      return { workflow_runs: runs };
    },
    "/repos/acme/widgets/actions/artifacts": () => ({
      artifacts: uploads.map((u) => u.artifact),
    }),
    "/repos/acme/widgets/releases": () => [],
    "/repos/acme/widgets/tags": () => [],
    "/repos/acme/widgets/pulls": () => [],
    "/repos/acme/widgets/deployments": () => [],
  };
  for (const { run: r, zip, artifact } of uploads) {
    routes[`/repos/acme/widgets/actions/runs/${r.id}`] = () => r;
    routes[`/repos/acme/widgets/actions/runs/${r.id}/artifacts`] = () => ({
      artifacts: [artifact],
    });
    routes[`/repos/acme/widgets/actions/artifacts/${artifact.id}/zip`] = () =>
      new Response(new Uint8Array(zip));
  }
  return routes;
};

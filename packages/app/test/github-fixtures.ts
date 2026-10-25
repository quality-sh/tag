// Fixtures only the GitHubSource tests share: the token config, the run body,
// and the layer wiring that puts the real Installation service under the
// source. Everything else comes from helpers.ts.
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
import { testConfig } from "./helpers.ts";

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

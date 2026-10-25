// GitHubSource with a GitHub App: the repositories an installation lists, the
// typed failure before an installation is recorded, and what a config lacks.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Cause, Effect, Exit, Layer, Option, Redacted } from "effect";
import { AppConfig } from "../src/server/config.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { GitHubSource } from "../src/server/github-source.ts";
import { Installation } from "../src/server/installation.ts";
import { fakeGithub, testConfig } from "./helpers.ts";
import { cfg, installationLayer, sourceWith, using } from "./github-fixtures.ts";

describe("GitHubSource", () => {
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
        installationId: Option.some("555"),
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

  test("an App source fails typed before an installation is recorded, and a live record flips it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const gh = fakeGithub({
      "/app/installations/555/access_tokens": () => ({
        token: "ghs_installation",
        expires_at: "2026-10-24T12:00:00Z",
      }),
      "/installation/repositories": () => ({
        repositories: [{ name: "widgets", owner: { login: "acme" } }],
      }),
    });
    const app = cfg({
      repos: [],
      auth: {
        _tag: "app",
        appId: "12345",
        privateKey: Redacted.make(pem),
        installationId: Option.none(),
      },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const installation = yield* Installation.Service;
        const source = yield* ArtifactSource.Service;
        // Every GitHub call fails typed, and none of them reaches the wire.
        const error = yield* source.repos().pipe(Effect.flip);
        expect(error._tag).toBe("ArtifactSource.SourceError");
        expect(error.detail).toContain("no installation recorded yet");
        expect(gh.hits).toHaveLength(0);
        yield* installation.record("555");
        expect(yield* source.repos()).toEqual([{ owner: "acme", repo: "widgets" }]);
        // The same running source: one mint, then the installation token.
        expect(gh.hits.map((h) => [h.method, h.url.pathname])).toEqual([
          ["POST", "/app/installations/555/access_tokens"],
          ["GET", "/installation/repositories"],
        ]);
        expect(gh.hits[1]?.auth).toBe("Bearer ghs_installation");
      }).pipe(Effect.provide(sourceWith(app, gh.layer))),
    );
  });

  test("a github source without credentials dies naming what the config needs", async () => {
    const gh = fakeGithub({});
    const config = Layer.succeed(AppConfig.Service, testConfig({ github: Option.none() }));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* ArtifactSource.Service;
      }).pipe(
        Effect.provide(
          GitHubSource.layer.pipe(
            Layer.provide(gh.layer),
            Layer.provide(installationLayer(config)),
            Layer.provide(config),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    expect(String(Cause.squash(exit.cause))).toContain("GITHUB_APP_PRIVATE_KEY");
  });
});

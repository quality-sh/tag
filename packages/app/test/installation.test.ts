// The Installation service over the real SQLite store: the ref, the settings row, the
// boot seed, and what survives a reopen.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Layer, Option, Redacted } from "effect";
import { AppConfig, type GithubConfig } from "../src/server/config.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { Installation } from "../src/server/installation.ts";
import { testConfig, tmpDirSync } from "./helpers.ts";

const appGithub = (installationId: Option.Option<string>): GithubConfig => ({
  auth: { _tag: "app", appId: "12345", privateKey: Redacted.make("key"), installationId },
  apiUrl: "https://api.github.test",
  slug: Option.none(),
  repos: [],
});

/** The real Installation layer over a real SQLite file, fresh or reopened on `dir`. */
const stack = (dir: string, github: Option.Option<GithubConfig> = Option.none()) => {
  const config = Layer.succeed(
    AppConfig.Service,
    testConfig({ sqlitePath: join(dir, "index.sqlite"), github }),
  );
  const store = ArtifactStore.layerFs(join(dir, "store"));
  const results = ResultStore.layer.pipe(Layer.provide(Layer.mergeAll(config, store)));
  const installation = Installation.layer.pipe(
    Layer.provide(Layer.mergeAll(config, results)),
    Layer.orDie,
  );
  return Layer.mergeAll(config, results, installation);
};

const newDir = () => tmpDirSync();

describe("Installation", () => {
  test("the env seed applies when nothing is stored", async () => {
    const dir = newDir();
    const seeded = stack(dir, Option.some(appGithub(Option.some("999"))));
    const current = await Effect.runPromise(
      Effect.gen(function* () {
        const installation = yield* Installation.Service;
        return yield* installation.current();
      }).pipe(Effect.provide(seeded)),
    );
    expect(current).toStrictEqual(Option.some("999"));
  });

  test("record shows the id at once and it survives reopening the store", async () => {
    const dir = newDir();
    const first = stack(dir, Option.some(appGithub(Option.some("999"))));
    await Effect.runPromise(
      Effect.gen(function* () {
        const installation = yield* Installation.Service;
        yield* installation.record("555");
        expect(yield* installation.current()).toStrictEqual(Option.some("555"));
      }).pipe(Effect.provide(first)),
    );
    const reopened = stack(dir, Option.some(appGithub(Option.some("999"))));
    const current = await Effect.runPromise(
      Effect.gen(function* () {
        const installation = yield* Installation.Service;
        return yield* installation.current();
      }).pipe(Effect.provide(reopened)),
    );
    // A stored value beats the env seed from the last boot.
    expect(current).toStrictEqual(Option.some("555"));
  });

  test("an instance with no App credentials has no installation", async () => {
    const dir = newDir();
    const current = await Effect.runPromise(
      Effect.gen(function* () {
        const installation = yield* Installation.Service;
        return yield* installation.current();
      }).pipe(Effect.provide(stack(dir))),
    );
    expect(current).toStrictEqual(Option.none());
  });
});

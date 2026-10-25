// The config layer's GitHub auth choice, read from real environment variables.
import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Option } from "effect";
import { AppConfig } from "../src/server/config.ts";

const read = (vars: Record<string, string>) =>
  Effect.gen(function* () {
    return yield* AppConfig.Service;
  }).pipe(
    Effect.provide(AppConfig.layer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: vars }))),
  );

describe("AppConfig", () => {
  test("parses App credentials without an installation id", async () => {
    const cfg = await Effect.runPromise(
      read({
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "key",
        GITHUB_APP_SLUG: "tag-app",
      }),
    );
    const github = Option.getOrNull(cfg.github);
    expect(github?.auth._tag).toBe("app");
    if (github?.auth._tag !== "app") return;
    expect(github.auth.appId).toBe("12345");
    expect(Option.isNone(github.auth.installationId)).toBe(true);
    expect(github.slug).toStrictEqual(Option.some("tag-app"));
    expect(github.repos).toEqual([]);
    expect(cfg.source).toBe("github");
  });

  test("takes the installation id from the environment when it is set", async () => {
    const cfg = await Effect.runPromise(
      read({
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "key",
        GITHUB_INSTALLATION_ID: "555",
      }),
    );
    const github = Option.getOrNull(cfg.github);
    if (github?.auth._tag !== "app") return expect.unreachable();
    expect(github.auth.installationId).toStrictEqual(Option.some("555"));
  });

  test("an installation id alone is not App credentials", async () => {
    const cfg = await Effect.runPromise(read({ GITHUB_INSTALLATION_ID: "555" }));
    expect(Option.isNone(cfg.github)).toBe(true);
    expect(cfg.source).toBe("fixtures");
  });
});

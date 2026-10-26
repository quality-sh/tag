// The config layer's GitHub auth choice, read from real environment variables.
import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
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

  test("the webhook secret is optional and the poll defaults to ten minutes", async () => {
    const bare = await Effect.runPromise(read({}));
    expect(Option.isNone(bare.webhookSecret)).toBe(true);
    expect(bare.ingestPollMinutes).toBe(10);

    const empty = await Effect.runPromise(read({ GITHUB_WEBHOOK_SECRET: "" }));
    expect(Option.isNone(empty.webhookSecret)).toBe(true);

    const set = await Effect.runPromise(
      read({ GITHUB_WEBHOOK_SECRET: "s3cret", INGEST_POLL_MINUTES: "0" }),
    );
    expect(Option.map(set.webhookSecret, Redacted.value)).toStrictEqual(Option.some("s3cret"));
    expect(set.ingestPollMinutes).toBe(0);
    expect((await Effect.runPromise(read({ INGEST_POLL_MINUTES: "-5" }))).ingestPollMinutes).toBe(
      0,
    );
  });
});

import { Config, Context, Effect, Layer, Option, Redacted } from "effect";

export interface S3Config {
  readonly bucket: string;
  readonly endpoint: Option.Option<string>;
  readonly region: string;
  readonly accessKeyId: Redacted.Redacted<string>;
  readonly secretAccessKey: Redacted.Redacted<string>;
}

export interface GithubConfig {
  readonly appId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly installationId: string;
  readonly repos: ReadonlyArray<{ readonly owner: string; readonly repo: string }>;
}

export interface Interface {
  readonly s3: Option.Option<S3Config>;
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly source: "fixtures" | "github";
  readonly fixturesDir: string;
  readonly github: Option.Option<GithubConfig>;
  readonly password: Redacted.Redacted<string>;
  readonly sessionSecret: Redacted.Redacted<string>;
  readonly port: number;
  readonly artifactPort: number;
  /** Default policy for large artifacts: copy into the store at ingest, or only when first viewed. */
  readonly copyPolicy: "copy" | "on-view";
}

export class Service extends Context.Service<Service, Interface>()("@verdict/AppConfig") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bucket = yield* Config.option(Config.String("S3_BUCKET"));
    const s3: Option.Option<S3Config> = Option.isSome(bucket)
      ? Option.some({
          bucket: bucket.value,
          endpoint: yield* Config.option(Config.String("S3_ENDPOINT")),
          region: yield* Config.String("S3_REGION").pipe(Config.withDefault("us-east-1")),
          accessKeyId: yield* Config.Redacted("S3_ACCESS_KEY_ID"),
          secretAccessKey: yield* Config.Redacted("S3_SECRET_ACCESS_KEY"),
        })
      : Option.none();

    const dataDir = yield* Config.String("DATA_DIR").pipe(Config.withDefault(".data"));
    const sqlitePath = yield* Config.String("SQLITE_PATH").pipe(
      Config.withDefault(`${dataDir}/verdict.sqlite`),
    );
    const sourceRaw = yield* Config.String("SOURCE").pipe(Config.withDefault("fixtures"));
    const source = sourceRaw === "github" ? "github" : "fixtures";
    const fixturesDir = yield* Config.String("FIXTURES_DIR").pipe(Config.withDefault("fixtures"));

    const appId = yield* Config.option(Config.String("GITHUB_APP_ID"));
    const github: Option.Option<GithubConfig> = Option.isSome(appId)
      ? Option.some({
          appId: appId.value,
          privateKey: yield* Config.Redacted("GITHUB_APP_PRIVATE_KEY"),
          installationId: yield* Config.String("GITHUB_INSTALLATION_ID"),
          repos: (yield* Config.String("GITHUB_REPOS").pipe(Config.withDefault("")))
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((full) => {
              const [owner = "", repo = ""] = full.split("/");
              return { owner, repo };
            }),
        })
      : Option.none();

    const password = yield* Config.Redacted("VERDICT_PASSWORD").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const sessionSecret = yield* Config.Redacted("SESSION_SECRET").pipe(
      Config.withDefault(Redacted.make("dev-only-secret")),
    );
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));
    const artifactPort = yield* Config.Port("ARTIFACT_PORT").pipe(Config.withDefault(3001));
    const copyPolicyRaw = yield* Config.String("ARTIFACT_COPY_POLICY").pipe(
      Config.withDefault("copy"),
    );

    return Service.of({
      s3,
      dataDir,
      sqlitePath,
      source,
      fixturesDir,
      github,
      password,
      sessionSecret,
      port,
      artifactPort,
      copyPolicy: copyPolicyRaw === "on-view" ? "on-view" : "copy",
    });
  }),
);

export * as AppConfig from "./config.ts";

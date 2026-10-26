import { Config, Context, Effect, Layer, Option, Redacted } from "effect";

export interface S3Config {
  readonly bucket: string;
  readonly endpoint: Option.Option<string>;
  readonly region: string;
  readonly accessKeyId: Redacted.Redacted<string>;
  readonly secretAccessKey: Redacted.Redacted<string>;
}

/** A GitHub App installation, or a plain token (fine-grained PAT or GITHUB_TOKEN) for one-off use. */
export type GithubAuth =
  | { readonly _tag: "token"; readonly token: Redacted.Redacted<string> }
  | {
      readonly _tag: "app";
      readonly appId: string;
      readonly privateKey: Redacted.Redacted<string>;
      /** The seed from the last boot; an installation recorded at runtime takes over. */
      readonly installationId: Option.Option<string>;
    };

export interface GithubConfig {
  readonly auth: GithubAuth;
  readonly apiUrl: string;
  /** The App's URL slug, from GITHUB_APP_SLUG; it builds the "Install on GitHub" link. */
  readonly slug: Option.Option<string>;
  /** Empty means every repository the installation can see. */
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
  /** Cached artifact files older than this leave the store; 0 keeps them forever. Reports stay. */
  readonly artifactRetentionDays: number;
  /** The App's webhook secret; with none set, the webhook endpoint answers 404. */
  readonly webhookSecret: Option.Option<Redacted.Redacted<string>>;
  /** Minutes between backstop passes; 0 turns the poll off. */
  readonly ingestPollMinutes: number;
}

export class Service extends Context.Service<Service, Interface>()("@tag/AppConfig") {}

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
      Config.withDefault(`${dataDir}/tag.sqlite`),
    );
    const fixturesDir = yield* Config.String("FIXTURES_DIR").pipe(Config.withDefault("fixtures"));

    const appId = yield* Config.option(Config.String("GITHUB_APP_ID"));
    const token = yield* Config.option(Config.Redacted("GITHUB_TOKEN"));
    const auth: Option.Option<GithubAuth> = Option.isSome(appId)
      ? Option.some({
          _tag: "app",
          appId: appId.value,
          privateKey: yield* Config.Redacted("GITHUB_APP_PRIVATE_KEY"),
          installationId: yield* Config.option(Config.String("GITHUB_INSTALLATION_ID")),
        })
      : Option.isSome(token)
        ? Option.some({ _tag: "token", token: token.value })
        : Option.none();
    const github: Option.Option<GithubConfig> = Option.isSome(auth)
      ? Option.some({
          auth: auth.value,
          apiUrl: yield* Config.String("GITHUB_API_URL").pipe(
            Config.withDefault("https://api.github.com"),
          ),
          slug: yield* Config.option(Config.String("GITHUB_APP_SLUG")),
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
    // GitHub credentials select the GitHub source unless SOURCE says otherwise.
    const sourceRaw = yield* Config.String("SOURCE").pipe(Config.withDefault(""));
    const source =
      sourceRaw === "github" || sourceRaw === "fixtures"
        ? sourceRaw
        : Option.isSome(github)
          ? "github"
          : "fixtures";

    const password = yield* Config.Redacted("TAG_PASSWORD").pipe(
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

    const artifactRetentionDays = yield* Config.Number("ARTIFACT_RETENTION_DAYS").pipe(
      Config.withDefault(90),
    );

    // An empty value, as .env.example leaves it, means no webhook.
    const webhookSecret = Option.filter(
      yield* Config.option(Config.Redacted("GITHUB_WEBHOOK_SECRET")),
      (secret) => Redacted.value(secret) !== "",
    );
    const ingestPollMinutes = yield* Config.Number("INGEST_POLL_MINUTES").pipe(
      Config.withDefault(10),
    );

    return Service.of({
      artifactRetentionDays,
      webhookSecret,
      ingestPollMinutes: Math.max(0, ingestPollMinutes),
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

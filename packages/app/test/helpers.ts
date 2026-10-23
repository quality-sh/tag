import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Redacted } from "effect";
import { AppConfig } from "../src/server/config.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { Ingest } from "../src/server/ingest.ts";

export const FIXTURES = new URL("../../../fixtures/", import.meta.url).pathname;

export const testConfig = (overrides: Partial<AppConfig.Interface> = {}): AppConfig.Interface => ({
  s3: Option.none(),
  dataDir: ".data-test",
  sqlitePath: ":memory:",
  source: "fixtures",
  fixturesDir: FIXTURES,
  github: Option.none(),
  password: Redacted.make("test"),
  sessionSecret: Redacted.make("test-secret"),
  port: 0,
  artifactPort: 0,
  copyPolicy: "copy",
  ...overrides,
});

export const tmpDir = () => mkdtemp(join(tmpdir(), "verdict-"));

/** Full stack on a temp filesystem store and an in-memory index. */
export const testLayer = async () => {
  const dir = await tmpDir();
  const config = Layer.succeed(AppConfig.Service, testConfig());
  const store = ArtifactStore.layerFs(join(dir, "store"));
  const source = ArtifactSource.layerFixtures(FIXTURES);
  const results = ResultStore.layer.pipe(Layer.provide(Layer.mergeAll(config, store)));
  const ingest = Ingest.layer.pipe(Layer.provide(Layer.mergeAll(config, store, source, results)));
  return { dir, layer: Layer.mergeAll(config, store, source, results, ingest) };
};

export const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

/** S3 config for the local RustFS from docker-compose; undefined when it is not reachable. */
export const localS3 = async (): Promise<AppConfig.S3Config | undefined> => {
  try {
    const res = await fetch("http://localhost:9000/", { signal: AbortSignal.timeout(1500) });
    if (res.status === 0) return undefined;
  } catch {
    return undefined;
  }
  return {
    bucket: "verdict",
    endpoint: Option.some("http://localhost:9000"),
    region: "us-east-1",
    accessKeyId: Redacted.make("verdict"),
    secretAccessKey: Redacted.make("verdictdev"),
  };
};

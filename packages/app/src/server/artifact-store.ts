// Object storage behind one interface. S3-compatible by default (Bun.S3Client); filesystem for tests and dev.
// Keys: artifacts/<owner>/<repo>/<artifactId>/<path...>  reports/<owner>/<repo>/<reportId>.ctrf.json
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { AppConfig, type S3Config } from "./config.ts";

export class StoreError extends Schema.TaggedError<StoreError>()("ArtifactStore.StoreError", {
  operation: Schema.String,
  key: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Blob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly size: number;
}

export interface Interface {
  readonly kind: "fs" | "s3";
  readonly has: (key: string) => Effect.Effect<boolean, StoreError>;
  readonly put: (
    key: string,
    body: Uint8Array,
    contentType: string,
  ) => Effect.Effect<void, StoreError>;
  readonly get: (key: string) => Effect.Effect<Option.Option<Blob>, StoreError>;
  /** All keys under a prefix. */
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, StoreError>;
  readonly remove: (key: string) => Effect.Effect<void, StoreError>;
}

export class Service extends Context.Service<Service, Interface>()("@tag/ArtifactStore") {}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  xml: "application/xml",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  webm: "video/webm",
  mp4: "video/mp4",
  zip: "application/zip",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  map: "application/json",
  wasm: "application/wasm",
};

export function contentTypeFor(path: string): string {
  const i = path.lastIndexOf(".");
  const ext = i === -1 ? "" : path.slice(i + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

function assertKey(key: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\\") ||
    key.includes("\0")
  ) {
    throw new Error(`invalid store key: ${JSON.stringify(key)}`);
  }
}

const storeError = (operation: string, key: string) => (cause: unknown) =>
  new StoreError({ operation, key, cause });

const tryOp = <A>(
  operation: string,
  key: string,
  f: () => Promise<A>,
): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      assertKey(key);
      return await f();
    },
    catch: storeError(operation, key),
  });

// ---------------------------------------------------------------------------
// Filesystem

export const makeFs = (root: string): Interface => {
  const abs = (key: string) => join(root, key);
  const has = (key: string) => tryOp("has", key, () => Bun.file(abs(key)).exists());
  const put = (key: string, body: Uint8Array) =>
    tryOp("put", key, async () => {
      await mkdir(dirname(abs(key)), { recursive: true });
      await Bun.write(abs(key), body);
    });
  const get = (key: string) =>
    tryOp("get", key, async (): Promise<Option.Option<Blob>> => {
      const f = Bun.file(abs(key));
      if (!(await f.exists())) return Option.none();
      const bytes = new Uint8Array(await f.arrayBuffer());
      return Option.some({ bytes, contentType: contentTypeFor(key), size: bytes.byteLength });
    });
  const list = (prefix: string) =>
    tryOp("list", prefix || "/", async () => {
      const out: string[] = [];
      const start = abs(prefix);
      const dir = prefix.endsWith("/") || prefix === "" ? start : dirname(start);
      const walk = async (d: string) => {
        let entries;
        try {
          entries = await readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = join(d, e.name);
          if (e.isDirectory()) await walk(full);
          else out.push(relative(root, full).split("\\").join("/"));
        }
      };
      await walk(dir);
      return out.filter((k) => k.startsWith(prefix)).sort();
    });
  const remove = (key: string) =>
    tryOp("remove", key, async () => {
      const f = Bun.file(abs(key));
      if (await f.exists()) await f.delete();
    });
  return { kind: "fs", has, put, get, list, remove };
};

export const layerFs = (root: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(root, { recursive: true }),
        catch: storeError("init", root),
      });
      yield* Effect.logInfo(`artifact store: filesystem at ${root}`);
      return Service.of(makeFs(root));
    }),
  );

// ---------------------------------------------------------------------------
// S3-compatible

export const makeS3 = (cfg: S3Config): Interface => {
  const client = new Bun.S3Client({
    bucket: cfg.bucket,
    region: cfg.region,
    accessKeyId: Redacted.value(cfg.accessKeyId),
    secretAccessKey: Redacted.value(cfg.secretAccessKey),
    ...(Option.isSome(cfg.endpoint) ? { endpoint: cfg.endpoint.value } : {}),
  });
  const has = (key: string) => tryOp("has", key, () => client.exists(key));
  const put = (key: string, body: Uint8Array, contentType: string) =>
    tryOp("put", key, async () => {
      await client.write(key, body, { type: contentType });
    });
  const get = (key: string) =>
    tryOp("get", key, async (): Promise<Option.Option<Blob>> => {
      const f = client.file(key);
      if (!(await f.exists())) return Option.none();
      const [buf, meta] = await Promise.all([f.arrayBuffer(), f.stat()]);
      const bytes = new Uint8Array(buf);
      const contentType =
        meta.type && meta.type !== "application/octet-stream" ? meta.type : contentTypeFor(key);
      return Option.some({ bytes, contentType, size: bytes.byteLength });
    });
  const list = (prefix: string) =>
    tryOp("list", prefix || "/", async () => {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.list({
          prefix,
          maxKeys: 1000,
          ...(token ? { continuationToken: token } : {}),
        });
        for (const c of page.contents ?? []) if (c.key) keys.push(c.key);
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
      return keys.sort();
    });
  const remove = (key: string) => tryOp("remove", key, () => client.delete(key));
  return { kind: "s3", has, put, get, list, remove };
};

export const layerS3 = (cfg: S3Config) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = makeS3(cfg);
      // Fail fast on bad credentials or a missing bucket.
      yield* store
        .list("reports/")
        .pipe(
          Effect.mapError(
            (e) => new StoreError({ operation: "connect", key: cfg.bucket, cause: e.cause }),
          ),
        );
      yield* Effect.logInfo(
        `artifact store: s3 bucket ${cfg.bucket}${Option.isSome(cfg.endpoint) ? ` at ${cfg.endpoint.value}` : ""}`,
      );
      return Service.of(store);
    }),
  );

/** Picks S3 when S3_BUCKET is set, else the filesystem under DATA_DIR/store. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    return Option.match(cfg.s3, {
      onNone: () => layerFs(join(cfg.dataDir, "store")),
      onSome: (s3) => layerS3(s3),
    });
  }),
);

export * as ArtifactStore from "./artifact-store.ts";

// The result store: the SQLite index over the reports in the artifact store, rebuilt from it.
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AppConfig } from "./config.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { DbError, Service } from "./result-store-rows.ts";
import { applySchema } from "./result-store-db.ts";
import { makeIndex } from "./result-store-index.ts";
import { makeQueries } from "./result-store-queries.ts";
import { makeArtifacts } from "./result-store-artifacts.ts";
import { makeRepositories } from "./result-store-repositories.ts";
import { makeReports } from "./result-store-reports.ts";
import { makeCollections } from "./result-store-collections.ts";
import { makeRebuild } from "./result-store-rebuild.ts";
import type { Interface } from "./result-store-rows.ts";

export * from "./result-store-rows.ts";

export const make = (db: Database, store: ArtifactStore.Interface): Interface => {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  applySchema(db);
  const { ingest, indexReport } = makeIndex(db, store);
  return {
    ingest,
    ...makeQueries(db, store),
    ...makeArtifacts(db),
    ...makeRepositories(db),
    ...makeReports(db),
    ...makeCollections(db),
    ...makeRebuild(db, store, indexReport),
  };
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const store = yield* ArtifactStore.Service;
    const db = yield* Effect.tryPromise({
      try: async () => {
        if (cfg.sqlitePath !== ":memory:")
          await mkdir(dirname(cfg.sqlitePath), { recursive: true });
        return new Database(cfg.sqlitePath, { create: true });
      },
      catch: (cause) => new DbError({ operation: "open", cause }),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
    yield* Effect.logInfo(`result store: sqlite at ${cfg.sqlitePath}`);
    return Service.of(make(db, store));
  }),
);

export * as ResultStore from "./result-store.ts";

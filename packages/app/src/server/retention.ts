// Retention: cached artifact files age out of the store; the normalized reports never do.
// A swept artifact goes back to "listed", so a later view fetches it again if the source
// still has it, or shows "expired at the source" if not.
import { Context, Effect, Layer, Schedule } from "effect";
import { AppConfig } from "./config.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { ResultStore } from "./result-store.ts";
import { artifactPrefix } from "./ingest.ts";

export interface SweepSummary {
  readonly days: number;
  readonly cutoff: string | null;
  readonly artifacts: number;
  readonly files: number;
  readonly errors: ReadonlyArray<string>;
}

export interface Interface {
  readonly days: number;
  /** Remove cached files of every artifact older than the retention window. */
  readonly sweep: (opts?: { readonly now?: Date }) => Effect.Effect<SweepSummary, never>;
}

export class Service extends Context.Service<Service, Interface>()("@tag/Retention") {}

const DAY = 86_400_000;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const store = yield* ArtifactStore.Service;
    const results = yield* ResultStore.Service;
    const days = Math.max(0, cfg.artifactRetentionDays);

    const sweepOne = Effect.fn("Retention.sweepOne")(function* (
      row: ResultStore.ArtifactRow,
      now: Date,
    ) {
      const prefix = artifactPrefix(row);
      const keys = yield* store.list(prefix);
      for (const key of keys) yield* store.remove(key);
      const expired = row.expiresAt !== null && row.expiresAt < now.toISOString();
      yield* results.markArtifactSwept(row.artifactId, expired ? "expired" : "listed");
      return keys.length;
    });

    const sweep = Effect.fn("Retention.sweep")(function* (opts?: { readonly now?: Date }) {
      const now = opts?.now ?? new Date();
      if (days === 0) return { days, cutoff: null, artifacts: 0, files: 0, errors: [] };
      const cutoff = new Date(now.getTime() - days * DAY).toISOString();
      const acc = { days, cutoff, artifacts: 0, files: 0, errors: [] as string[] };
      const rows = yield* results.cachedArtifactsBefore(cutoff).pipe(
        Effect.catchCause((c) => {
          acc.errors.push(`list: ${String(c)}`);
          return Effect.succeed([] as ReadonlyArray<ResultStore.ArtifactRow>);
        }),
      );
      for (const row of rows) {
        yield* sweepOne(row, now).pipe(
          Effect.map((files) => {
            acc.artifacts++;
            acc.files += files;
          }),
          Effect.catchCause((c) => {
            acc.errors.push(`${row.artifactId}: ${String(c)}`);
            return Effect.void;
          }),
        );
      }
      if (acc.artifacts > 0 || acc.errors.length > 0)
        yield* Effect.logInfo(
          `retention: swept ${acc.artifacts} artifacts (${acc.files} files) older than ${days} days${acc.errors.length ? `, ${acc.errors.length} errors` : ""}`,
        );
      return acc;
    });

    return Service.of({ days, sweep });
  }),
);

/** Sweep on boot and then every six hours, in the background. Nothing runs when retention is off. */
export const sweeper = Layer.effectDiscard(
  Effect.gen(function* () {
    const retention = yield* Service;
    if (retention.days === 0) return;
    yield* retention.sweep().pipe(Effect.repeat(Schedule.spaced("6 hours")), Effect.forkScoped);
  }),
);

export * as Retention from "./retention.ts";

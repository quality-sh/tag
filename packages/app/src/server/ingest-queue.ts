// The queue worker: runs named by webhook deliveries, ingested one at a time per repository,
// retried with backoff, and drained again on boot from the durable table.
import { Clock, Deferred, Duration, Effect, Latch, Schema, type Scope } from "effect";
import type { ArtifactSource, RepoRef } from "./artifact-source.ts";
import type { ResultStore } from "./result-store.ts";
import type { RecordError } from "./ingest-contract.ts";
import type { IndexRun, RunTally } from "./ingest-run.ts";

/** A queued run's attempt left artifacts unindexed; the row stays for the next attempt. */
class QueuedRunError extends Schema.TaggedError<QueuedRunError>()("Ingest.QueuedRunError", {
  detail: Schema.String,
}) {}

type RunKey = Pick<ResultStore.QueuedRun, "owner" | "repo" | "runId">;

export const MAX_ATTEMPTS = 5;
/** One minute after the first failure, doubling, so five attempts span about a quarter hour. */
const backoff = (attempts: number) => Duration.minutes(2 ** Math.max(0, attempts - 1));
/** A broken database read waits this long before the worker looks again. */
const READ_RETRY = Duration.minutes(1);

const keyOf = (run: RunKey) => `${run.owner}/${run.repo}/${run.runId}`;

export const makeQueueWorker = (deps: {
  readonly source: ArtifactSource.Interface;
  readonly results: ResultStore.Interface;
  readonly makeIndexRun: (recordError: RecordError) => IndexRun;
  /** Hold the repository against a pass on it, and against another queued run. */
  readonly withRepoLock: (
    repo: RepoRef,
  ) => <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly scope: Scope.Scope;
}) =>
  Effect.gen(function* () {
    const { source, results, withRepoLock, scope } = deps;
    // Errors land on the attempt's own list; a queued run is not part of a pass's progress.
    const { indexRun, indexedArtifacts } = deps.makeIndexRun((errors, message) =>
      Effect.sync(() => {
        errors.push(message);
      }),
    );

    const wake = yield* Latch.make(false);
    // Backoff lives in memory: a restart makes every queued run due at once.
    const dueAt = new Map<string, number>();
    // Bumped on every enqueue, so the worker only reports idle for the rows it actually read.
    let generation = 0;
    let idle = yield* Deferred.make<void>();

    const ingestQueued = Effect.fn("Ingest.ingestQueued")(function* (key: RunKey) {
      const repo = { owner: key.owner, repo: key.repo };
      const run = yield* source.run(repo, key.runId);
      const seen = (yield* results.seenRuns(key.owner, key.repo)).has(key.runId);
      const listed = seen ? yield* indexedArtifacts(run) : yield* source.listArtifacts(run);
      const acc: RunTally = {
        runs: 0,
        artifacts: 0,
        reports: 0,
        inserted: 0,
        cached: 0,
        errors: [],
      };
      yield* indexRun(run, listed, !seen, acc);
      if (acc.errors.length > 0)
        return yield* new QueuedRunError({ detail: acc.errors.join("; ") });
      return acc;
    });

    const attempt = Effect.fn("Ingest.attemptQueued")(function* (row: ResultStore.QueuedRun) {
      const key = keyOf(row);
      const outcome = yield* ingestQueued(row).pipe(
        withRepoLock({ owner: row.owner, repo: row.repo }),
        Effect.result,
      );
      if (outcome._tag === "Success") {
        dueAt.delete(key);
        yield* results.dequeueRun(row);
        yield* Effect.logInfo(
          `queued run ${key}: ${outcome.success.artifacts} artifacts, ${outcome.success.inserted} new reports`,
        );
        return;
      }
      const failure = outcome.failure;
      const detail =
        failure._tag === "ResultStore.DbError"
          ? `${failure.operation}: ${String(failure.cause)}`
          : failure.detail;
      const attempts = yield* results.failQueuedRun(row, detail);
      if (attempts >= MAX_ATTEMPTS) {
        dueAt.delete(key);
        yield* results.dequeueRun(row);
        yield* Effect.logWarning(
          `queued run ${key}: giving up after ${attempts} attempts, the poll will retry it: ${detail}`,
        );
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      dueAt.set(key, now + Duration.toMillis(backoff(attempts)));
      yield* Effect.logInfo(`queued run ${key}: attempt ${attempts} failed, retrying: ${detail}`);
    });

    /** Take every due row, repositories side by side and each repository's runs in turn. */
    const cycle = Effect.gen(function* () {
      const read = generation;
      yield* wake.close;
      const rows = yield* results.queuedRuns();
      const now = yield* Clock.currentTimeMillis;
      const due = rows.filter((row) => (dueAt.get(keyOf(row)) ?? 0) <= now);
      // A retry come due is work too: whoever waits for idle now waits for this cycle.
      if (due.length > 0 && (yield* Deferred.isDone(idle))) idle = yield* Deferred.make<void>();
      const byRepo = new Map<string, ResultStore.QueuedRun[]>();
      for (const row of due) {
        const group = byRepo.get(`${row.owner}/${row.repo}`) ?? [];
        group.push(row);
        byRepo.set(`${row.owner}/${row.repo}`, group);
      }
      yield* Effect.forEach(
        byRepo.values(),
        (group) => Effect.forEach(group, attempt, { discard: true }),
        { concurrency: "unbounded", discard: true },
      );
      if (due.length > 0) return;
      if (read === generation) yield* Deferred.succeed(idle, undefined);
      const next = Math.min(
        ...rows.map((row) => dueAt.get(keyOf(row)) ?? Infinity).filter((t) => t > now),
      );
      yield* Number.isFinite(next)
        ? Effect.raceFirst(wake.await, Effect.sleep(Duration.millis(next - now)))
        : wake.await;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`run queue: ${error.operation} failed: ${String(error.cause)}`).pipe(
          Effect.andThen(Effect.raceFirst(wake.await, Effect.sleep(READ_RETRY))),
        ),
      ),
    );

    yield* Effect.forever(cycle).pipe(Effect.forkIn(scope));

    const queueRun = Effect.fn("Ingest.queueRun")(function* (
      deliveryId: string | undefined,
      run: RunKey,
    ) {
      const result = yield* results.queueRun(deliveryId, run);
      if (result.duplicate) return result;
      generation++;
      if (yield* Deferred.isDone(idle)) idle = yield* Deferred.make<void>();
      yield* wake.open;
      return result;
    });

    /** Resolves once the worker has handled every run that was due when it last looked. */
    const queueIdle = () => Effect.suspend(() => Deferred.await(idle));

    return { queueRun, queueIdle };
  });

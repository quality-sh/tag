// The pass runner: admission of one pass at a time, its progress, and the finished record.
import { Deferred, Effect, Exit, type Scope, Semaphore, Ref as StateRef } from "effect";
import type { ArtifactSource, RepoRef } from "./artifact-source.ts";
import {
  addSummary,
  emptySummary,
  type IngestOptions,
  type IngestPass,
  type IngestStatus,
  type IngestSummary,
  type RecordError,
  type UpdateProgress,
} from "./ingest-contract.ts";

export const makePass = (deps: {
  readonly source: ArtifactSource.Interface;
  readonly status: StateRef.Ref<IngestStatus>;
  readonly updateProgress: UpdateProgress;
  readonly recordError: RecordError;
  readonly ingestRepo: (repo: RepoRef, opts?: IngestOptions) => Effect.Effect<IngestSummary>;
  readonly scope: Scope.Scope;
}) =>
  Effect.gen(function* () {
    const { source, status, updateProgress, recordError, ingestRepo, scope } = deps;

    const runPass = Effect.fn("Ingest.runPass")(function* (repo?: RepoRef, opts?: IngestOptions) {
      const before = yield* source.requestStats();
      const repos = repo
        ? [repo]
        : yield* source
            .repos()
            .pipe(
              Effect.catch((error) =>
                recordError([], `repos: ${error.detail}`).pipe(
                  Effect.as([] as ReadonlyArray<RepoRef>),
                ),
              ),
            );
      let total = emptySummary();
      for (const repository of repos) {
        yield* updateProgress((pass) => ({ ...pass, currentRepository: repository }));
        const summary = yield* ingestRepo(repository, opts);
        total = addSummary(total, summary);
        yield* updateProgress((pass) => ({
          ...pass,
          currentRepository: null,
          repositories: [...pass.repositories, { repository, summary }],
        }));
      }
      const after = yield* source.requestStats();
      return { ...total, waits: after.waits - before.waits, remaining: after.remaining };
    });

    // Admission is short: requests share the active job while its fiber owns the work.
    const admission = yield* Semaphore.make(1);
    let active: {
      readonly passId: string;
      readonly done: Deferred.Deferred<IngestSummary>;
    } | null = null;
    const launch = Effect.fn("Ingest.launch")(
      function* (repo: RepoRef | undefined, opts: IngestOptions | undefined) {
        if (active) return { job: active, started: false };
        const job = { passId: crypto.randomUUID(), done: yield* Deferred.make<IngestSummary>() };
        const pass: IngestPass = {
          passId: job.passId,
          startedAt: new Date().toISOString(),
          repositories: [],
          currentRepository: null,
          errors: [],
        };
        yield* StateRef.update(status, (state) => ({ ...state, running: pass }));
        active = job;
        yield* runPass(repo, opts).pipe(
          Effect.onExit((exit) =>
            admission.withPermits(1)(
              Effect.gen(function* () {
                const state = yield* StateRef.get(status);
                const progress = state.running ?? pass;
                const summary = Exit.isSuccess(exit)
                  ? exit.value
                  : progress.repositories.reduce(
                      (total, entry) => addSummary(total, entry.summary),
                      emptySummary(),
                    );
                const errors = Exit.isFailure(exit)
                  ? [...progress.errors, String(exit.cause)]
                  : progress.errors;
                const finished = { ...summary, errors };
                yield* StateRef.set(status, {
                  running: null,
                  lastFinished: {
                    ...progress,
                    currentRepository: null,
                    errors,
                    finishedAt: new Date().toISOString(),
                    summary: finished,
                  },
                });
                active = null;
                yield* Deferred.succeed(job.done, finished);
              }),
            ),
          ),
          Effect.forkIn(scope),
        );
        return { job, started: true };
      },
      (effect) => effect.pipe(admission.withPermits(1), Effect.uninterruptible),
    );

    // Synchronous callers still request their own pass after any current one ends.
    const ingest = Effect.fn("Ingest.ingest")(function* (repo?: RepoRef, opts?: IngestOptions) {
      let launched = yield* launch(repo, opts);
      while (!launched.started) {
        yield* Deferred.await(launched.job.done);
        launched = yield* launch(repo, opts);
      }
      return yield* Deferred.await(launched.job.done);
    });

    const start = Effect.fn("Ingest.start")(function* (
      repo: RepoRef | undefined,
      opts: IngestOptions | undefined,
    ) {
      const { job } = yield* launch(repo, opts);
      return { passId: job.passId };
    });

    return { start, ingest };
  });

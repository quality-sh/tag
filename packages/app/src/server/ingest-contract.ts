// The ingest service's contract: the pass shapes, the summary tally, and the plumbing types.
import { Context, Effect } from "effect";
import type { ArtifactMeta, ArtifactSource, RepoRef } from "./artifact-source.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import type { ResultStore } from "./result-store.ts";
import type { ZipError } from "./zip.ts";

export interface IngestSummary {
  readonly waits: number;
  readonly remaining: number | null;
  readonly runs: number;
  readonly refs: number;
  readonly artifacts: number;
  readonly cached: number;
  readonly reports: number;
  readonly inserted: number;
  readonly errors: ReadonlyArray<string>;
}

export interface IngestPass {
  readonly passId: string;
  readonly startedAt: string;
  readonly repositories: ReadonlyArray<{
    readonly repository: RepoRef;
    readonly summary: IngestSummary;
  }>;
  readonly currentRepository: RepoRef | null;
  readonly errors: ReadonlyArray<string>;
}

export interface IngestStatus {
  readonly running: IngestPass | null;
  readonly lastFinished:
    (IngestPass & { readonly finishedAt: string; readonly summary: IngestSummary }) | null;
}

export type IngestOptions = { readonly limit?: number; readonly branch?: string };

/** What one failed step contributes: a message on the accumulator, then on the running pass. */
export type RecordError = (errors: string[], message: string) => Effect.Effect<void>;

export type UpdateProgress = (f: (pass: IngestPass) => IngestPass) => Effect.Effect<void>;

/** The failures a pass step can raise, from the source, the store, the zip and the index. */
export type IngestError =
  ArtifactSource.SourceError | ArtifactStore.StoreError | ZipError | ResultStore.DbError;

export const emptySummary = (): IngestSummary => ({
  waits: 0,
  remaining: null,
  runs: 0,
  refs: 0,
  artifacts: 0,
  cached: 0,
  reports: 0,
  inserted: 0,
  errors: [],
});

export const addSummary = (total: IngestSummary, next: IngestSummary): IngestSummary => ({
  waits: total.waits + next.waits,
  remaining: next.remaining,
  runs: total.runs + next.runs,
  refs: total.refs + next.refs,
  artifacts: total.artifacts + next.artifacts,
  cached: total.cached + next.cached,
  reports: total.reports + next.reports,
  inserted: total.inserted + next.inserted,
  errors: [...total.errors, ...next.errors],
});

export interface Interface {
  /** Start a service-owned pass, or return the pass already running. */
  readonly start: (
    repo?: RepoRef,
    opts?: IngestOptions,
  ) => Effect.Effect<{ readonly passId: string }>;
  readonly status: () => Effect.Effect<IngestStatus>;

  /** Discover recent runs for a repository and ingest every artifact. */
  readonly ingestRepo: (
    repo: RepoRef,
    opts?: { readonly limit?: number; readonly branch?: string },
  ) => Effect.Effect<IngestSummary, never>;
  /** Every repository the source knows about. */
  readonly ingestAll: (opts?: { readonly limit?: number }) => Effect.Effect<IngestSummary, never>;
  /**
   * Queue a completed run a webhook delivery named; the worker ingests it in the background.
   * A delivery id seen before changes nothing and comes back `duplicate`.
   */
  readonly queueRun: (
    deliveryId: string | undefined,
    run: RepoRef & { readonly runId: string },
  ) => Effect.Effect<{ readonly duplicate: boolean }, ResultStore.DbError>;
  /** Wait until the queue has nothing due and no pass is running. */
  readonly settled: () => Effect.Effect<void>;
  /** Make sure an artifact's files are in the store; returns the key prefix. */
  readonly cacheArtifact: (
    artifact: ArtifactMeta,
  ) => Effect.Effect<
    { readonly prefix: string; readonly fetched: boolean },
    ArtifactSource.SourceError | ArtifactStore.StoreError | ZipError | ResultStore.DbError
  >;
}

export class Service extends Context.Service<Service, Interface>()("@tag/Ingest") {}

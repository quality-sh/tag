// The result store's contract: the error, the row shapes, and the service interface.
import { Context, Effect, Option, Schema } from "effect";
import type { CtrfReport } from "@quality-sh/tag-schema";
import type { RunnerFinding, ScanClassification, UnreadArtifact } from "../scan.ts";
import type { Collection, Ref, ReportLite } from "../grouping.ts";
import type { ArtifactStore } from "./artifact-store.ts";

export class DbError extends Schema.TaggedError<DbError>()("ResultStore.DbError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface ReportOrigin {
  readonly owner: string;
  readonly repo: string;
  readonly adapter: string;
  readonly artifactId?: string;
  readonly artifactName?: string;
}

export interface RunRow {
  readonly reportId: string;
  readonly runId: string;
  readonly owner: string;
  readonly repo: string;
  readonly tool: string;
  readonly toolVersion: string | null;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly buildUrl: string | null;
  readonly workflow: string | null;
  readonly environment: string | null;
  readonly timestamp: string;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
  readonly other: number;
  readonly flaky: number;
  readonly duration: number;
  readonly artifactId: string | null;
  readonly artifactName: string | null;
  readonly adapter: string;
  readonly ingestedAt: string;
}

export interface TestRow {
  readonly reportId: string;
  readonly runId: string;
  readonly testId: string;
  readonly name: string;
  readonly status: string;
  readonly duration: number;
  readonly filePath: string | null;
  readonly suite: string | null;
  readonly flaky: number;
  readonly retries: number;
  readonly message: string | null;
  readonly timestamp: string;
  readonly branch: string | null;
  readonly tool: string;
}

export interface MetricRow {
  readonly reportId: string;
  readonly testId: string;
  readonly name: string;
  readonly value: number | null;
  readonly threshold: number | null;
  readonly comparator: string | null;
  readonly passed: number | null;
}

export interface ArtifactRow {
  readonly artifactId: string;
  readonly owner: string;
  readonly repo: string;
  readonly runId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly expiresAt: string | null;
  readonly state: "listed" | "cached" | "expired";
  readonly cachedAt: string | null;
}

/** Where a repository stands: first sight, walking its history back, or caught up. */
export interface RepositoryRow {
  readonly owner: string;
  readonly repo: string;
  readonly state: "new" | "backfilling" | "current";
  readonly backfillDone: number;
  readonly backfillTotal: number | null;
  readonly firstSeenAt: string;
  readonly updatedAt: string;
}

/** What a scan knew about a repository: its branch and environments, then what it found. */
export interface ScanRow {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string | null;
  readonly environments: ReadonlyArray<string>;
  readonly classification: ScanClassification | null;
  /** Artifacts whose samples produced a report. */
  readonly reporting: ReadonlyArray<string>;
  /** Artifacts holding test output no adapter reads yet. */
  readonly unread: ReadonlyArray<UnreadArtifact>;
  readonly runners: ReadonlyArray<RunnerFinding>;
  /** The indexed artifact names the scan last saw, so a changed set rescans. */
  readonly names: ReadonlyArray<string>;
  readonly scannedAt: string | null;
}

export interface RunFilter {
  readonly owner?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly tool?: string;
  readonly runId?: string;
  readonly limit?: number;
}

export interface Interface {
  readonly ingest: (
    report: CtrfReport,
    origin: ReportOrigin,
  ) => Effect.Effect<
    { readonly inserted: boolean; readonly reportId: string },
    DbError | ArtifactStore.StoreError
  >;
  readonly listRuns: (filter: RunFilter) => Effect.Effect<ReadonlyArray<RunRow>, DbError>;
  readonly getRun: (reportId: string) => Effect.Effect<Option.Option<RunRow>, DbError>;
  readonly getReport: (
    reportId: string,
  ) => Effect.Effect<Option.Option<CtrfReport>, DbError | ArtifactStore.StoreError>;
  readonly testsOf: (reportId: string) => Effect.Effect<ReadonlyArray<TestRow>, DbError>;
  readonly metricsOf: (reportId: string) => Effect.Effect<ReadonlyArray<MetricRow>, DbError>;
  readonly testHistory: (
    owner: string,
    repo: string,
    testId: string,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<TestRow & { readonly metrics: ReadonlyArray<MetricRow> }>,
    DbError
  >;
  readonly upsertArtifact: (row: ArtifactRow) => Effect.Effect<void, DbError>;
  readonly artifactsOfRun: (
    owner: string,
    repo: string,
    runId: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactRow>, DbError>;
  readonly getArtifact: (artifactId: string) => Effect.Effect<Option.Option<ArtifactRow>, DbError>;
  /** A completed run never changes: once its artifacts are listed, later passes read them from here. */
  readonly markRunSeen: (
    owner: string,
    repo: string,
    runId: string,
  ) => Effect.Effect<void, DbError>;
  readonly seenRuns: (owner: string, repo: string) => Effect.Effect<ReadonlySet<string>, DbError>;
  readonly repository: (
    owner: string,
    repo: string,
  ) => Effect.Effect<Option.Option<RepositoryRow>, DbError>;
  readonly repositories: () => Effect.Effect<ReadonlyArray<RepositoryRow>, DbError>;
  /** Insert on first sight, keeping that time; later calls move the state and progress. */
  readonly upsertRepository: (
    row: Pick<RepositoryRow, "owner" | "repo" | "state" | "backfillDone" | "backfillTotal">,
  ) => Effect.Effect<void, DbError>;
  /** Save what a scan knew about a repository, keyed owner/repo. */
  readonly upsertScan: (row: ScanRow) => Effect.Effect<void, DbError>;
  /** Every scan row, for the routes that prefer a repository's own default branch. */
  readonly scans: () => Effect.Effect<ReadonlyArray<ScanRow>, DbError>;
  readonly scanOf: (owner: string, repo: string) => Effect.Effect<Option.Option<ScanRow>, DbError>;
  /** Every indexed artifact name of a repository, and whether a report came from it. */
  readonly artifactNames: (
    owner: string,
    repo: string,
  ) => Effect.Effect<ReadonlyArray<{ name: string; reported: boolean }>, DbError>;
  /** After a sweep: the files are gone, so the row is "listed" again, or "expired" when the source is too. */
  readonly markArtifactSwept: (
    artifactId: string,
    state: "listed" | "expired",
  ) => Effect.Effect<void, DbError>;
  /** Cached artifacts whose run (or, failing that, cache time) is older than `cutoff`. */
  readonly cachedArtifactsBefore: (
    cutoff: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactRow>, DbError>;
  readonly repos: () => Effect.Effect<
    ReadonlyArray<{ readonly owner: string; readonly repo: string; readonly reports: number }>,
    DbError
  >;
  /** Every report with what groupings need, newest first; `since` is an ISO timestamp. */
  readonly reports: (opts: {
    readonly since?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<ReportLite>, DbError>;
  readonly upsertRef: (ref: Ref) => Effect.Effect<void, DbError>;
  readonly refs: (repo?: {
    readonly owner: string;
    readonly repo: string;
  }) => Effect.Effect<ReadonlyArray<Ref>, DbError>;
  readonly collections: () => Effect.Effect<ReadonlyArray<Collection>, DbError>;
  readonly saveCollection: (c: Collection) => Effect.Effect<void, DbError>;
  readonly deleteCollection: (id: string) => Effect.Effect<boolean, DbError>;
  /** One key/value row; the GitHub App installation id lives here between boots. */
  readonly getSetting: (key: string) => Effect.Effect<Option.Option<string>, DbError>;
  readonly setSetting: (key: string, value: string) => Effect.Effect<void, DbError>;
  /** Drop the index and rebuild it from reports/ in the artifact store. */
  readonly rebuild: () => Effect.Effect<
    { readonly reports: number },
    DbError | ArtifactStore.StoreError
  >;
}

export class Service extends Context.Service<Service, Interface>()("@tag/ResultStore") {}

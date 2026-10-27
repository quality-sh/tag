// The result store's contract: the error, the row shapes, and the service interface.
import { Context, Effect, Option, Schema } from "effect";
import type { CtrfReport } from "@quality-sh/tag-schema";
import { RunnerFinding, ScanClassification, UnreadArtifact } from "../scan.ts";
import type { Collection, Ref, ReleaseGroup, ReportLite } from "../grouping.ts";
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

const NullableString = Schema.NullOr(Schema.String);
const NullableNumber = Schema.NullOr(Schema.Number);

export const RunRow = Schema.Struct({
  reportId: Schema.String,
  runId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  tool: Schema.String,
  toolVersion: NullableString,
  branch: NullableString,
  commit: NullableString,
  buildUrl: NullableString,
  workflow: NullableString,
  environment: NullableString,
  timestamp: Schema.String,
  tests: Schema.Number,
  passed: Schema.Number,
  failed: Schema.Number,
  skipped: Schema.Number,
  pending: Schema.Number,
  other: Schema.Number,
  flaky: Schema.Number,
  duration: Schema.Number,
  artifactId: NullableString,
  artifactName: NullableString,
  adapter: Schema.String,
  ingestedAt: Schema.String,
}).annotate({ identifier: "RunRow" });
export interface RunRow extends Schema.Schema.Type<typeof RunRow> {}

export const TestRow = Schema.Struct({
  reportId: Schema.String,
  runId: Schema.String,
  testId: Schema.String,
  name: Schema.String,
  status: Schema.String,
  duration: Schema.Number,
  filePath: NullableString,
  suite: NullableString,
  flaky: Schema.Number,
  retries: Schema.Number,
  message: NullableString,
  timestamp: Schema.String,
  branch: NullableString,
  tool: Schema.String,
}).annotate({ identifier: "TestRow" });
export interface TestRow extends Schema.Schema.Type<typeof TestRow> {}

export const MetricRow = Schema.Struct({
  reportId: Schema.String,
  testId: Schema.String,
  name: Schema.String,
  value: NullableNumber,
  threshold: NullableNumber,
  comparator: NullableString,
  passed: NullableNumber,
}).annotate({ identifier: "MetricRow" });
export interface MetricRow extends Schema.Schema.Type<typeof MetricRow> {}

/** A test's result in one report, with the metrics it recorded there. */
export const TestHistoryRow = Schema.Struct({
  ...TestRow.fields,
  metrics: Schema.Array(MetricRow),
}).annotate({ identifier: "TestHistoryRow" });
export interface TestHistoryRow extends Schema.Schema.Type<typeof TestHistoryRow> {}

export const ArtifactRow = Schema.Struct({
  artifactId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  runId: Schema.String,
  name: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: NullableString,
  state: Schema.Literals(["listed", "cached", "expired"]),
  cachedAt: NullableString,
}).annotate({ identifier: "ArtifactRow" });
export interface ArtifactRow extends Schema.Schema.Type<typeof ArtifactRow> {}

/** Where a repository stands: first sight, walking its history back, or caught up. */
export const RepositoryRow = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  state: Schema.Literals(["new", "backfilling", "current"]),
  backfillDone: Schema.Number,
  backfillTotal: NullableNumber,
  firstSeenAt: Schema.String,
  updatedAt: Schema.String,
}).annotate({ identifier: "RepositoryRow" });
export interface RepositoryRow extends Schema.Schema.Type<typeof RepositoryRow> {}

/** What a scan knew about a repository: its branch and environments, then what it found. */
export const ScanRow = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  defaultBranch: NullableString,
  environments: Schema.Array(Schema.String),
  classification: Schema.NullOr(ScanClassification),
  /** Artifacts whose samples produced a report. */
  reporting: Schema.Array(Schema.String),
  /** Artifacts holding test output no adapter reads yet. */
  unread: Schema.Array(UnreadArtifact),
  runners: Schema.Array(RunnerFinding),
  /** The indexed artifact names the scan last saw, so a changed set rescans. */
  names: Schema.Array(Schema.String),
  scannedAt: NullableString,
}).annotate({ identifier: "ScanRow" });
export interface ScanRow extends Schema.Schema.Type<typeof ScanRow> {}

/** A repository with how many reports the index holds for it. */
export const RepoCount = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  reports: Schema.Number,
}).annotate({ identifier: "RepoCount" });
export interface RepoCount extends Schema.Schema.Type<typeof RepoCount> {}

/** The pull request TAG opened to propose a repository's CI change. */
export interface ProposalRow {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly branch: string;
  readonly openedAt: string;
}

/** A completed run a webhook delivery named, waiting for the queue worker. */
export interface QueuedRun {
  readonly owner: string;
  readonly repo: string;
  readonly runId: string;
  readonly queuedAt: string;
  readonly attempts: number;
  readonly lastError: string | null;
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
  ) => Effect.Effect<ReadonlyArray<TestHistoryRow>, DbError>;
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
  /** The pull request proposed for a repository's CI change, when TAG opened one. */
  readonly proposalOf: (
    owner: string,
    repo: string,
  ) => Effect.Effect<Option.Option<ProposalRow>, DbError>;
  readonly saveProposal: (row: ProposalRow) => Effect.Effect<void, DbError>;
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
  readonly repos: () => Effect.Effect<ReadonlyArray<RepoCount>, DbError>;
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
  /** The saved release groups: repositories whose same-name tags are one release. */
  readonly releaseGroups: () => Effect.Effect<ReadonlyArray<ReleaseGroup>, DbError>;
  readonly saveReleaseGroup: (group: ReleaseGroup) => Effect.Effect<void, DbError>;
  /** Suggestion ids the person said no to; a suggestion whose data changed gets a new id. */
  readonly dismissedSuggestions: () => Effect.Effect<ReadonlySet<string>, DbError>;
  readonly dismissSuggestion: (id: string) => Effect.Effect<void, DbError>;
  /** One key/value row; the GitHub App installation id lives here between boots. */
  readonly getSetting: (key: string) => Effect.Effect<Option.Option<string>, DbError>;
  readonly setSetting: (key: string, value: string) => Effect.Effect<void, DbError>;
  /**
   * Record a delivery and queue its run, both or neither. A delivery id seen before is a
   * no-op; a run already queued stays queued once.
   */
  readonly queueRun: (
    deliveryId: string | undefined,
    run: Pick<QueuedRun, "owner" | "repo" | "runId">,
  ) => Effect.Effect<{ readonly duplicate: boolean }, DbError>;
  /** Every queued run, oldest first. */
  readonly queuedRuns: () => Effect.Effect<ReadonlyArray<QueuedRun>, DbError>;
  readonly dequeueRun: (
    run: Pick<QueuedRun, "owner" | "repo" | "runId">,
  ) => Effect.Effect<void, DbError>;
  /** Count a failed attempt and keep its reason; returns the attempts so far. */
  readonly failQueuedRun: (
    run: Pick<QueuedRun, "owner" | "repo" | "runId">,
    error: string,
  ) => Effect.Effect<number, DbError>;
  /** Drop the index and rebuild it from reports/ in the artifact store. */
  readonly rebuild: () => Effect.Effect<
    { readonly reports: number },
    DbError | ArtifactStore.StoreError
  >;
}

export class Service extends Context.Service<Service, Interface>()("@tag/ResultStore") {}

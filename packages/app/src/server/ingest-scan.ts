// The repository scan: sample the newest unread artifacts, and store what the repo produces.
import { Effect, Option } from "effect";
import { classifyRepository, detectRunners, sniffSample, type UnreadArtifact } from "../scan.ts";
import {
  type ArtifactMeta,
  type ArtifactSource,
  type RepoRef,
  type RunMeta,
} from "./artifact-source.ts";
import { ResultStore } from "./result-store.ts";
import { type IngestError } from "./ingest-contract.ts";
import type { IngestArtifact } from "./ingest-run.ts";
import { ZipError } from "./zip.ts";

const artifactMetaOf = (row: ResultStore.ArtifactRow): ArtifactMeta => ({
  artifactId: row.artifactId,
  owner: row.owner,
  repo: row.repo,
  runId: row.runId,
  name: row.name,
  sizeBytes: row.sizeBytes,
  ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
});

const isWorkflowPath = (p: string) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p);

/** Scan one repository, counting what its samples produce into the pass accumulator. */
export type ScanRepo = (
  repo: RepoRef,
  info: ArtifactSource.RepoInfo,
  runs: ReadonlyArray<RunMeta>,
  acc: { reports: number; inserted: number; cached: number },
) => Effect.Effect<void, IngestError>;

/**
 * One scan of a repository: sample the newest artifact per name the adapters have not read,
 * read the tree's workflows for runners, and store what the repository produces and needs.
 * Runs come newest first, so the first row seen per name is that name's newest artifact.
 */
export const makeScanRepo = (deps: {
  readonly source: ArtifactSource.Interface;
  readonly results: ResultStore.Interface;
  readonly ingestArtifact: IngestArtifact;
}) => {
  const { source, results, ingestArtifact } = deps;
  const scanRepo = Effect.fn("Ingest.scanRepo")(function* (
    repo: RepoRef,
    info: ArtifactSource.RepoInfo,
    runs: ReadonlyArray<RunMeta>,
    acc: { reports: number; inserted: number; cached: number },
  ) {
    const previous = yield* results.scanOf(repo.owner, repo.repo);
    const names = yield* results.artifactNames(repo.owner, repo.repo);
    const indexed = names.map((n) => n.name).sort();
    if (Option.isSome(previous)) {
      const known = previous.value.names;
      if (known.length === indexed.length && indexed.every((n) => known.includes(n))) return;
    }
    const reporting = new Set(names.filter((n) => n.reported).map((n) => n.name));
    const unread: UnreadArtifact[] = [];
    const pending = new Set(names.filter((n) => !n.reported).map((n) => n.name));
    const samples: Array<{ run: RunMeta; artifact: ArtifactMeta }> = [];
    for (const run of runs) {
      for (const row of yield* results.artifactsOfRun(repo.owner, repo.repo, run.runId)) {
        if (row.state === "expired" || !pending.delete(row.name)) continue;
        samples.push({ run, artifact: artifactMetaOf(row) });
      }
    }
    for (const { run, artifact } of samples.slice(0, 10)) {
      const { files, reports } = yield* ingestArtifact(run, artifact, acc);
      if (reports > 0) {
        reporting.add(artifact.name);
        continue;
      }
      const contents = yield* Effect.forEach(files, (f) =>
        Effect.map(
          Effect.tryPromise({
            try: () => f.text(),
            catch: (cause) => new ZipError({ reason: `read failed: ${String(cause)}` }),
          }),
          (text) => ({ path: f.path, text }),
        ),
      );
      const format = sniffSample(contents);
      if (format !== null && format !== "unknown") unread.push({ name: artifact.name, format });
    }
    const paths = yield* source.repoTree(repo);
    const runners = detectRunners({
      paths,
      files: yield* source.repoFiles(repo, paths.filter(isWorkflowPath)),
    });
    unread.sort((a, b) => a.name.localeCompare(b.name));
    const classification = classifyRepository({
      reporting: [...reporting],
      unread,
      runners,
    });
    yield* results.upsertScan({
      owner: repo.owner,
      repo: repo.repo,
      defaultBranch: info.defaultBranch,
      environments: info.environments,
      classification,
      reporting: [...reporting].sort(),
      unread,
      runners,
      names: indexed,
      scannedAt: new Date().toISOString(),
    });
    yield* Effect.logInfo(
      `scan ${repo.owner}/${repo.repo}: ${classification}, ${reporting.size} reporting, ${unread.length} unread, ${runners.length} runners`,
    );
  });
  return { scanRepo };
};

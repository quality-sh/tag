// Where runs and artifacts come from. Fixtures on disk for local dev; GitHub Actions in production.
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { Ref } from "../grouping.ts";
import { buildZip, type ZipEntry } from "./zip.ts";

/** The reserved per-repository directory holding the file tree the scan reads. */
export const TREE_DIR = "tree";

export class SourceError extends Schema.TaggedError<SourceError>()("ArtifactSource.SourceError", {
  operation: Schema.String,
  detail: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface RunMeta extends RepoRef {
  readonly runId: string;
  readonly runNumber?: number;
  readonly workflow?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly buildUrl?: string;
  /** ISO 8601 */
  readonly timestamp?: string;
  readonly status?: string;
  readonly environment?: string;
  readonly tags?: ReadonlyArray<string>;
}

export interface ArtifactMeta extends RepoRef {
  readonly artifactId: string;
  readonly runId: string;
  readonly name: string;
  readonly sizeBytes: number;
  /** ISO 8601, when the source will delete it. */
  readonly expiresAt?: string;
  readonly expired?: boolean;
  readonly branch?: string;
  readonly commit?: string;
}

export interface RepoInfo {
  readonly defaultBranch: string | null;
  readonly environments: ReadonlyArray<string>;
}

export interface Interface {
  readonly kind: "fixtures" | "github";
  /** Cumulative rate-limit waits and the last reported request allowance. */
  readonly requestStats: () => Effect.Effect<{
    readonly waits: number;
    readonly remaining: number | null;
  }>;
  readonly repos: () => Effect.Effect<ReadonlyArray<RepoRef>, SourceError>;
  /** The repository's default branch and environments from the source's own API. */
  readonly repoInfo: (repo: RepoRef) => Effect.Effect<RepoInfo, SourceError>;
  /** Completed runs, newest first. `since` keeps only runs created at or after that ISO time. */
  readonly listRuns: (
    repo: RepoRef,
    opts: { readonly limit: number; readonly branch?: string; readonly since?: string },
  ) => Effect.Effect<ReadonlyArray<RunMeta>, SourceError>;
  /** One completed run by id, as `listRuns` would describe it. */
  readonly run: (repo: RepoRef, runId: string) => Effect.Effect<RunMeta, SourceError>;
  readonly listArtifacts: (run: RunMeta) => Effect.Effect<ReadonlyArray<ArtifactMeta>, SourceError>;
  /** Repository listing for runs needing an index. An empty set checks only the newest page. */
  readonly listRepoArtifacts: (
    repo: RepoRef,
    runIds: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyArray<ArtifactMeta>, SourceError>;
  /** Releases, tags, pull requests and deployments the source knows for a repository. */
  readonly listRefs: (repo: RepoRef) => Effect.Effect<ReadonlyArray<Ref>, SourceError>;
  /** Blob paths of the repository tree on its default branch. */
  readonly repoTree: (repo: RepoRef) => Effect.Effect<ReadonlyArray<string>, SourceError>;
  /** Text of the requested paths; absent paths come back absent. */
  readonly repoFiles: (
    repo: RepoRef,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<{ path: string; text: string }>, SourceError>;
  /** The artifact as zip bytes. */
  readonly openArtifact: (artifact: ArtifactMeta) => Effect.Effect<Uint8Array, SourceError>;
}

export class Service extends Context.Service<Service, Interface>()("@tag/ArtifactSource") {}

// ---------------------------------------------------------------------------
// Fixtures: <dir>/<owner>/<repo>/<runId>/run.json + one subdirectory per artifact,
// and <dir>/<owner>/<repo>/refs.json for releases, tags and pull requests.

interface RunJson {
  runId?: string;
  workflow?: string;
  branch?: string;
  commit?: string;
  timestamp?: string;
  buildUrl?: string;
  environment?: string;
  tags?: string[];
}

const RefsJson = Schema.Array(
  Schema.Struct({
    kind: Ref.fields.kind,
    key: Schema.NonEmptyString,
    commit: Schema.optionalKey(Schema.NullOr(Schema.String)),
    branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
    timestamp: Schema.String,
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    url: Schema.optionalKey(Schema.NullOr(Schema.String)),
    meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeRefs = Schema.decodeUnknownResult(RefsJson);

/** The repository's own words about itself; everything but the name is optional. */
const RepoJson = Schema.Struct({
  defaultBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  environments: Schema.optionalKey(Schema.Array(Schema.String)),
});
const decodeRepoJson = Schema.decodeUnknownResult(RepoJson);

const srcError = (operation: string, detail: string) => (cause: unknown) =>
  new SourceError({ operation, detail, cause });

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function readTree(root: string): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else
        out.push({
          path: relative(root, full).split("\\").join("/"),
          bytes: new Uint8Array(await Bun.file(full).arrayBuffer()),
        });
    }
  };
  await walk(root);
  return out;
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else total += (await stat(full)).size;
    }
  };
  await walk(root);
  return total;
}

export const makeFixtures = (dir: string): Interface => {
  const repos = () =>
    Effect.tryPromise({
      try: async () => {
        const out: RepoRef[] = [];
        for (const owner of await listDirs(dir))
          for (const repo of await listDirs(join(dir, owner))) out.push({ owner, repo });
        return out;
      },
      catch: srcError("repos", dir),
    });

  const listRuns = (
    repo: RepoRef,
    opts: { readonly limit: number; readonly branch?: string; readonly since?: string },
  ) =>
    Effect.tryPromise({
      try: async () => {
        const base = join(dir, repo.owner, repo.repo);
        const runs: RunMeta[] = [];
        for (const runId of await listDirs(base)) {
          if (runId === TREE_DIR) continue;
          const metaFile = Bun.file(join(base, runId, "run.json"));
          const meta = (await metaFile.exists()) ? ((await metaFile.json()) as RunJson) : {};
          const run: RunMeta = {
            ...repo,
            runId: meta.runId ?? runId,
            ...(meta.workflow ? { workflow: meta.workflow } : {}),
            ...(meta.branch ? { branch: meta.branch } : {}),
            ...(meta.commit ? { commit: meta.commit } : {}),
            ...(meta.buildUrl ? { buildUrl: meta.buildUrl } : {}),
            ...(meta.timestamp ? { timestamp: meta.timestamp } : {}),
            ...(meta.environment ? { environment: meta.environment } : {}),
            ...(meta.tags ? { tags: meta.tags } : {}),
            status: "completed",
          };
          if (opts.branch && run.branch !== opts.branch) continue;
          if (opts.since && run.timestamp && run.timestamp < opts.since) continue;
          runs.push(run);
        }
        runs.sort((a, b) => (b.timestamp ?? b.runId).localeCompare(a.timestamp ?? a.runId));
        return runs.slice(0, opts.limit);
      },
      catch: srcError("listRuns", `${repo.owner}/${repo.repo}`),
    });

  const run = Effect.fn("Fixtures.run")(function* (repo: RepoRef, runId: string) {
    const found = (yield* listRuns(repo, { limit: Infinity })).find((r) => r.runId === runId);
    if (found) return found;
    return yield* new SourceError({
      operation: "run",
      detail: `${repo.owner}/${repo.repo}/${runId}: no such run`,
      status: 404,
    });
  });

  const listArtifacts = (run: RunMeta) =>
    Effect.tryPromise({
      try: async () => {
        const base = join(dir, run.owner, run.repo, run.runId);
        const out: ArtifactMeta[] = [];
        for (const name of await listDirs(base)) {
          out.push({
            owner: run.owner,
            repo: run.repo,
            runId: run.runId,
            artifactId: `${run.runId}__${name}`,
            name,
            sizeBytes: await dirSize(join(base, name)),
          });
        }
        return out;
      },
      catch: srcError("listArtifacts", run.runId),
    });

  const listRepoArtifacts = Effect.fn("Fixtures.listRepoArtifacts")(function* (
    repo: RepoRef,
    runIds: ReadonlySet<string>,
  ) {
    const runs = yield* listRuns(repo, { limit: Infinity });
    const artifacts: ArtifactMeta[] = [];
    for (const run of runs) {
      if (!runIds.has(run.runId)) continue;
      for (const artifact of yield* listArtifacts(run)) {
        artifacts.push({
          ...artifact,
          ...(run.branch ? { branch: run.branch } : {}),
          ...(run.commit ? { commit: run.commit } : {}),
        });
      }
    }
    return artifacts;
  });

  const listRefs = (repo: RepoRef) =>
    Effect.tryPromise({
      try: async () => {
        const file = Bun.file(join(dir, repo.owner, repo.repo, "refs.json"));
        if (!(await file.exists())) return [];
        const r = decodeRefs(await file.json());
        if (r._tag === "Failure") throw new Error(String(r.failure));
        return r.success.map((x): Ref => ({
          kind: x.kind,
          key: x.key,
          owner: repo.owner,
          repo: repo.repo,
          commit: x.commit ?? null,
          branch: x.branch ?? null,
          timestamp: x.timestamp,
          title: x.title ?? null,
          url: x.url ?? null,
          meta: x.meta ?? {},
        }));
      },
      catch: srcError("listRefs", `${repo.owner}/${repo.repo}`),
    });

  const repoInfo = (repo: RepoRef) =>
    Effect.tryPromise({
      try: async () => {
        const file = Bun.file(join(dir, repo.owner, repo.repo, "repo.json"));
        if (!(await file.exists())) return { defaultBranch: null, environments: [] };
        const r = decodeRepoJson(await file.json());
        if (r._tag === "Failure") throw new Error(String(r.failure));
        return {
          defaultBranch: r.success.defaultBranch ?? null,
          environments: r.success.environments ?? [],
        };
      },
      catch: srcError("repoInfo", `${repo.owner}/${repo.repo}`),
    });

  /** Blob paths under the repo's tree/, relative to the repo root; no tree/ means no files. */
  const repoTree = (repo: RepoRef) =>
    Effect.tryPromise({
      try: async () => {
        const root = join(dir, repo.owner, repo.repo, TREE_DIR);
        const rootStat = await stat(root).catch(() => undefined);
        if (!rootStat?.isDirectory()) return [];
        const out: string[] = [];
        const walk = async (d: string, rel: string): Promise<void> => {
          for (const e of await readdir(d, { withFileTypes: true })) {
            if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
            else out.push(rel + e.name);
          }
        };
        await walk(root, "");
        return out.sort();
      },
      catch: srcError("repoTree", `${repo.owner}/${repo.repo}`),
    });

  const repoFiles = (repo: RepoRef, paths: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: async () => {
        const root = join(dir, repo.owner, repo.repo, TREE_DIR);
        const out: Array<{ path: string; text: string }> = [];
        for (const p of paths) {
          const file = Bun.file(join(root, p));
          if (await file.exists()) out.push({ path: p, text: await file.text() });
        }
        return out;
      },
      catch: srcError("repoFiles", `${repo.owner}/${repo.repo}`),
    });

  const openArtifact = (artifact: ArtifactMeta) =>
    Effect.tryPromise({
      try: async () =>
        buildZip(
          await readTree(join(dir, artifact.owner, artifact.repo, artifact.runId, artifact.name)),
        ),
      catch: srcError("openArtifact", artifact.artifactId),
    });

  return {
    kind: "fixtures",
    requestStats: () => Effect.succeed({ waits: 0, remaining: null }),
    repos,
    repoInfo,
    listRuns,
    run,
    listArtifacts,
    listRepoArtifacts,
    listRefs,
    repoTree,
    repoFiles,
    openArtifact,
  };
};

export const layerFixtures = (dir: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      yield* Effect.logInfo(`artifact source: fixtures at ${dir}`);
      return Service.of(makeFixtures(dir));
    }),
  );

export * as ArtifactSource from "./artifact-source.ts";

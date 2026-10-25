// Where runs and artifacts come from. Fixtures on disk for local dev; GitHub Actions in production.
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { Ref } from "../grouping.ts";
import { buildZip, type ZipEntry } from "./zip.ts";

export class SourceError extends Schema.TaggedError<SourceError>()("ArtifactSource.SourceError", {
  operation: Schema.String,
  detail: Schema.String,
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
}

export interface Interface {
  readonly kind: "fixtures" | "github";
  readonly repos: () => Effect.Effect<ReadonlyArray<RepoRef>, SourceError>;
  readonly listRuns: (
    repo: RepoRef,
    opts: { readonly limit: number; readonly branch?: string },
  ) => Effect.Effect<ReadonlyArray<RunMeta>, SourceError>;
  readonly listArtifacts: (run: RunMeta) => Effect.Effect<ReadonlyArray<ArtifactMeta>, SourceError>;
  /** Releases, tags, pull requests and deployments the source knows for a repository. */
  readonly listRefs: (repo: RepoRef) => Effect.Effect<ReadonlyArray<Ref>, SourceError>;
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

  const listRuns = (repo: RepoRef, opts: { readonly limit: number; readonly branch?: string }) =>
    Effect.tryPromise({
      try: async () => {
        const base = join(dir, repo.owner, repo.repo);
        const runs: RunMeta[] = [];
        for (const runId of await listDirs(base)) {
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
          if (!opts.branch || run.branch === opts.branch) runs.push(run);
        }
        runs.sort((a, b) => (b.timestamp ?? b.runId).localeCompare(a.timestamp ?? a.runId));
        return runs.slice(0, opts.limit);
      },
      catch: srcError("listRuns", `${repo.owner}/${repo.repo}`),
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

  const openArtifact = (artifact: ArtifactMeta) =>
    Effect.tryPromise({
      try: async () =>
        buildZip(
          await readTree(join(dir, artifact.owner, artifact.repo, artifact.runId, artifact.name)),
        ),
      catch: srcError("openArtifact", artifact.artifactId),
    });

  return { kind: "fixtures", repos, listRuns, listArtifacts, listRefs, openArtifact };
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

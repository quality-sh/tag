// Runs and artifacts listing: completed workflow runs, their artifacts, and the zip download.
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import type { ArtifactMeta, RepoRef, RunMeta } from "./artifact-source.ts";
import { httpError, srcError, type Client } from "./github-client.ts";
import {
  Artifacts,
  PAGE,
  RepoArtifacts,
  RUN_CAP,
  WorkflowRun,
  WorkflowRuns,
} from "./github-schemas.ts";

export const makeRunListing = (client: Client) => {
  const { base, api, request, token, pages, repoPath } = client;
  // Cache each representation, including page, branch and limit. Revalidate on every pass.
  // Keeping the body lets ingest retry indexed downloads even when the runs have not changed.
  const runPages = new Map<string, { etag: string; body: typeof WorkflowRuns.Type }>();
  return {
    listRuns: Effect.fn("GitHubSource.listRuns")(function* (
      repo: RepoRef,
      opts: { readonly limit: number; readonly branch?: string; readonly since?: string },
    ) {
      const branch = opts.branch ? `&branch=${encodeURIComponent(opts.branch)}` : "";
      // GitHub's `created` filter takes dates; the day boundary rounds the window out, not in.
      const sinceDay = opts.since?.slice(0, 10);
      const created = (upToDay?: string) => {
        const range = sinceDay
          ? upToDay
            ? `${sinceDay}..${upToDay}`
            : `>=${sinceDay}`
          : upToDay
            ? `<=${upToDay}`
            : undefined;
        return range ? `&created=${encodeURIComponent(range)}` : "";
      };
      // GitHub pages no further than RUN_CAP results into one listing. Past it, the window
      // closes at the oldest day seen and the walk goes on from there; the boundary day repeats.
      const runs: Array<typeof WorkflowRun.Type> = [];
      const ids = new Set<number>();
      let upToDay: string | undefined;
      while (runs.length < opts.limit) {
        const chunk = yield* pages(
          (p) =>
            `${repoPath(repo)}/actions/runs?status=completed&per_page=${Math.min(PAGE, opts.limit)}&page=${p}${branch}${created(upToDay)}`,
          WorkflowRuns,
          (x) => x.workflow_runs,
          Math.min(opts.limit - runs.length, RUN_CAP),
          "listRuns",
          `${repo.owner}/${repo.repo}`,
          runPages,
        );
        for (const r of chunk) {
          if (ids.has(r.id)) continue;
          ids.add(r.id);
          runs.push(r);
        }
        const oldest = chunk.at(-1)?.created_at.slice(0, 10);
        if (chunk.length < RUN_CAP || oldest === undefined || oldest === upToDay) break;
        upToDay = oldest;
      }
      return runs.map((r): RunMeta => ({
        ...repo,
        runId: String(r.id),
        runNumber: r.run_number,
        ...(r.name ? { workflow: r.name } : {}),
        ...(r.head_branch ? { branch: r.head_branch } : {}),
        commit: r.head_sha,
        buildUrl: r.html_url,
        timestamp: r.run_started_at ?? r.created_at,
        status: r.conclusion ?? r.status ?? "completed",
        ...(r.event ? { tags: [`event:${r.event}`] } : {}),
      }));
    }),
    listArtifacts: Effect.fn("GitHubSource.listArtifacts")(function* (run: RunMeta) {
      const list = yield* pages(
        (p) => `${repoPath(run)}/actions/runs/${run.runId}/artifacts?per_page=${PAGE}&page=${p}`,
        Artifacts,
        (x) => x.artifacts,
        500,
        "listArtifacts",
        run.runId,
      );
      return list.map((a): ArtifactMeta => ({
        owner: run.owner,
        repo: run.repo,
        runId: run.runId,
        artifactId: String(a.id),
        name: a.name,
        sizeBytes: a.size_in_bytes,
        expired: a.expired,
        ...(a.expires_at ? { expiresAt: a.expires_at } : {}),
      }));
    }),
    listRepoArtifacts: Effect.fn("GitHubSource.listRepoArtifacts")(function* (
      repo: RepoRef,
      runIds: ReadonlySet<string>,
    ) {
      const list = yield* pages(
        (p) => `${repoPath(repo)}/actions/artifacts?per_page=${PAGE}&page=${p}`,
        RepoArtifacts,
        (x) => x.artifacts,
        // With no unseen runs, one page suffices. Otherwise finish the listing before marking
        // any run seen: its artifacts can span pages and interleave with other runs.
        runIds.size === 0 ? PAGE : Infinity,
        "listRepoArtifacts",
        `${repo.owner}/${repo.repo}`,
      );
      return list
        .filter((a) => runIds.has(String(a.workflow_run.id)))
        .map((a): ArtifactMeta => ({
          ...repo,
          runId: String(a.workflow_run.id),
          artifactId: String(a.id),
          name: a.name,
          sizeBytes: a.size_in_bytes,
          expired: a.expired,
          ...(a.expires_at ? { expiresAt: a.expires_at } : {}),
          ...(a.workflow_run.head_branch ? { branch: a.workflow_run.head_branch } : {}),
          commit: a.workflow_run.head_sha,
        }));
    }),
    // The zip endpoint answers 302 to a signed blob URL. Fetch would follow it and may carry
    // the token across origins, so read the redirect by hand and fetch the blob bare.
    openArtifact: Effect.fn("GitHubSource.openArtifact")(function* (artifact: ArtifactMeta) {
      const t = yield* token;
      const path = `${repoPath(artifact)}/actions/artifacts/${artifact.artifactId}/zip`;
      const first = yield* request(
        api.get(path, { headers: { authorization: `Bearer ${t}` } }),
      ).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.mapError(srcError("openArtifact", artifact.artifactId)),
      );
      const location = Option.fromNullishOr(first.headers["location"]);
      if (first.status === 410)
        return yield* httpError(
          first,
          "openArtifact",
          `${artifact.artifactId}: the source has expired this artifact`,
        );
      const fail = srcError("openArtifact", `${artifact.artifactId}: downloading the zip`);
      const response =
        first.status >= 300 && first.status < 400 && Option.isSome(location)
          ? yield* request(base.get(location.value)).pipe(Effect.mapError(fail))
          : first;
      if (response.status < 200 || response.status >= 300)
        return yield* httpError(response, "openArtifact", artifact.artifactId);
      const bytes = yield* response.arrayBuffer.pipe(Effect.mapError(fail));
      return new Uint8Array(bytes);
    }),
  };
};

// Repository reads: the default branch and environments, the git tree, and file texts.
import { Effect, Option } from "effect";
import type { RepoRef } from "./artifact-source.ts";
import { SourceError } from "./artifact-source.ts";
import { httpError, decode, srcError, type Client } from "./github-client.ts";
import { ContentFile, Environments, GitTree, RepoDetail } from "./github-schemas.ts";

export const makeRepoReads = (client: Client) => {
  const { api, request, token, getJson, repoPath } = client;

  const repoInfo = Effect.fn("GitHubSource.repoInfo")(function* (repo: RepoRef) {
    const detail = yield* getJson(
      repoPath(repo),
      RepoDetail,
      "repoInfo",
      `${repo.owner}/${repo.repo}`,
    );
    // Environments are a nicety: an endpoint that will not answer them leaves the list empty.
    const envs = yield* getJson(
      `${repoPath(repo)}/environments`,
      Environments,
      "repoInfo",
      `${repo.owner}/${repo.repo} environments`,
    ).pipe(Effect.option);
    return {
      defaultBranch: detail.default_branch ?? null,
      environments: Option.isSome(envs) ? envs.value.environments.map((e) => e.name) : [],
    };
  });

  // The tree and the file texts come from the default branch the repository named.
  const defaultBranchOfRepo = Effect.fn("GitHubSource.defaultBranchOfRepo")(function* (
    repo: RepoRef,
    operation: string,
  ) {
    const info = yield* repoInfo(repo);
    if (info.defaultBranch !== null) return info.defaultBranch;
    return yield* new SourceError({
      operation,
      detail: `${repo.owner}/${repo.repo}: no default branch to read from`,
    });
  });

  const repoTree = Effect.fn("GitHubSource.repoTree")(function* (repo: RepoRef) {
    const branch = yield* defaultBranchOfRepo(repo, "repoTree");
    const tree = yield* getJson(
      `${repoPath(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      GitTree,
      "repoTree",
      `${repo.owner}/${repo.repo}`,
    );
    return tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
  });

  const repoFiles = Effect.fn("GitHubSource.repoFiles")(function* (
    repo: RepoRef,
    paths: ReadonlyArray<string>,
  ) {
    if (paths.length === 0) return [];
    const branch = yield* defaultBranchOfRepo(repo, "repoFiles");
    const t = yield* token;
    const out: Array<{ path: string; text: string }> = [];
    for (const p of paths) {
      const fail = srcError("repoFiles", `${repo.owner}/${repo.repo}: ${p}`);
      const where = `${repoPath(repo)}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;
      const res = yield* request(
        api.get(where, { headers: { authorization: `Bearer ${t}` } }),
      ).pipe(Effect.mapError(fail));
      // An absent path is an absent file, not a failure.
      if (res.status === 404) continue;
      if (res.status < 200 || res.status >= 300) return yield* httpError(res, "repoFiles", p);
      const body = yield* res.json.pipe(Effect.mapError(fail));
      const file = yield* decode(
        ContentFile,
        "repoFiles",
        `${repo.owner}/${repo.repo}: ${p}`,
      )(body);
      const content = file.content ?? "";
      out.push({
        path: p,
        text:
          file.encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content,
      });
    }
    return out;
  });

  return { repoInfo, repoTree, repoFiles };
};

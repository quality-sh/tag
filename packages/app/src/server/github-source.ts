// GitHub Actions as the artifact source: workflow runs, their artifacts, and the refs that
// group runs (releases, tags, pull requests, deployments). Talks to the REST API through
// the Effect HttpClient with an App installation token or a plain token.
import { Effect, Layer, Option } from "effect";
import { Service, type Interface, type RepoRef } from "./artifact-source.ts";
import { SourceError } from "./artifact-source.ts";
import { AppConfig, type GithubConfig } from "./config.ts";
import { Installation } from "./installation.ts";
import { makeClient } from "./github-client.ts";
import { makeRunListing } from "./github-runs.ts";
import { makeRefs } from "./github-refs.ts";
import { makeRepoReads } from "./github-repo.ts";
import { makeRepoWrites } from "./github-write.ts";
import { InstallationRepos, PAGE } from "./github-schemas.ts";

export const make = Effect.fn("GitHubSource.make")(function* (cfg: GithubConfig) {
  const installation = yield* Installation.Service;
  const client = yield* makeClient(cfg, installation);
  const { listRuns, run, listArtifacts, listRepoArtifacts, openArtifact } = makeRunListing(client);
  const { listRefs } = makeRefs(client);
  const { repoInfo, repoTree, repoFiles } = makeRepoReads(client);
  const { openPullRequest } = makeRepoWrites(client);

  const repos = Effect.fn("GitHubSource.repos")(function* () {
    if (cfg.repos.length) return cfg.repos;
    if (cfg.auth._tag === "token")
      return yield* new SourceError({
        operation: "repos",
        detail: "GITHUB_REPOS is required with GITHUB_TOKEN",
      });
    const list = yield* client.pages(
      (p) => `/installation/repositories?per_page=${PAGE}&page=${p}`,
      InstallationRepos,
      (x) => x.repositories,
      500,
      "repos",
      "installation repositories",
    );
    return list.map((r): RepoRef => ({ owner: r.owner.login, repo: r.name }));
  });

  const source: Interface = {
    kind: "github",
    requestStats: client.requestStats,
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
    openPullRequest,
  };
  return source;
});

/** The GitHub source from AppConfig; needs an HttpClient and the Installation service. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    if (Option.isNone(cfg.github))
      return yield* Effect.die(
        "SOURCE=github needs GITHUB_TOKEN, or GITHUB_APP_ID with GITHUB_APP_PRIVATE_KEY",
      );
    const g = cfg.github.value;
    yield* Effect.logInfo(
      `artifact source: github (${g.auth._tag}) ${g.repos.length ? g.repos.map((r) => `${r.owner}/${r.repo}`).join(", ") : "every installed repository"}`,
    );
    return Service.of(yield* make(g));
  }),
);

export * as GitHubSource from "./github-source.ts";

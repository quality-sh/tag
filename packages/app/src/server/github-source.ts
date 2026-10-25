// GitHub Actions as the artifact source: workflow runs, their artifacts, and the refs that
// group runs (releases, tags, pull requests, deployments). Talks to the REST API through
// the Effect HttpClient with an App installation token or a plain token.
import { createSign } from "node:crypto";
import { Clock, Effect, Layer, Option, Redacted, Schedule, Schema, Semaphore } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import type { Ref } from "../grouping.ts";
import { AppConfig, type GithubConfig } from "./config.ts";
import {
  Service,
  SourceError,
  type ArtifactMeta,
  type Interface,
  type RepoRef,
  type RunMeta,
} from "./artifact-source.ts";

// ---------------------------------------------------------------------------
// What GitHub sends back, decoded at the boundary. Only the fields TAG reads.

const Nullable = <S extends Schema.Top>(s: S) => Schema.optionalKey(Schema.NullOr(s));

const Repository = Schema.Struct({
  name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
});
const InstallationRepos = Schema.Struct({ repositories: Schema.Array(Repository) });

const WorkflowRun = Schema.Struct({
  id: Schema.Number,
  run_number: Schema.Number,
  name: Nullable(Schema.String),
  head_branch: Nullable(Schema.String),
  head_sha: Schema.String,
  html_url: Schema.String,
  status: Nullable(Schema.String),
  conclusion: Nullable(Schema.String),
  run_started_at: Nullable(Schema.String),
  created_at: Schema.String,
  event: Nullable(Schema.String),
});
const WorkflowRuns = Schema.Struct({ workflow_runs: Schema.Array(WorkflowRun) });

const Artifact = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  size_in_bytes: Schema.Number,
  expired: Schema.Boolean,
  expires_at: Nullable(Schema.String),
});
const Artifacts = Schema.Struct({ artifacts: Schema.Array(Artifact) });
const RepoArtifacts = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({
      ...Artifact.fields,
      workflow_run: Schema.Struct({
        id: Schema.Number,
        head_branch: Nullable(Schema.String),
        head_sha: Schema.String,
      }),
    }),
  ),
});

const Release = Schema.Struct({
  tag_name: Schema.String,
  name: Nullable(Schema.String),
  html_url: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  target_commitish: Nullable(Schema.String),
  published_at: Nullable(Schema.String),
  created_at: Schema.String,
});
const Tag = Schema.Struct({ name: Schema.String, commit: Schema.Struct({ sha: Schema.String }) });
const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  draft: Nullable(Schema.Boolean),
  created_at: Schema.String,
  closed_at: Nullable(Schema.String),
  merged_at: Nullable(Schema.String),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  user: Nullable(Schema.Struct({ login: Schema.String })),
});
const Deployment = Schema.Struct({
  id: Schema.Number,
  sha: Schema.String,
  ref: Schema.String,
  environment: Schema.String,
  created_at: Schema.String,
});
const InstallationToken = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

const headerNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

const PAGE = 100;
const SHA = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------

const srcError = (operation: string, detail: string) => (cause: unknown) =>
  new SourceError({ operation, detail, cause });

/** A short-lived JWT that identifies the App itself; it buys installation tokens. */
const appJwt = (appId: string, privateKey: Redacted.Redacted<string>) =>
  Effect.try({
    try: () => {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
      const sig = createSign("RSA-SHA256")
        .update(body)
        .sign(Redacted.value(privateKey), "base64url");
      return `${body}.${sig}`;
    },
    catch: srcError("appJwt", "could not sign the App JWT; check GITHUB_APP_PRIVATE_KEY"),
  });

export const make = Effect.fn("GitHubSource.make")(function* (cfg: GithubConfig) {
  const base = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((req) =>
      req.pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders({
          "x-github-api-version": "2022-11-28",
          "user-agent": "quality-sh-tag",
        }),
      ),
    ),
    // Rate-limit responses belong to request() so each wait is counted once.
    HttpClient.retryTransient({
      retryOn: "errors-only",
      times: 3,
      schedule: Schedule.exponential("500 millis"),
    }),
    HttpClient.transformResponse((response) =>
      response.pipe(
        Effect.repeat({
          times: 3,
          schedule: Schedule.exponential("500 millis"),
          while: (res) => [408, 500, 502, 503, 504].includes(res.status),
        }),
      ),
    ),
  );
  const api = base.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(cfg.apiUrl)));

  const requestGate = yield* Semaphore.make(1);
  let waits = 0;
  let remaining: number | null = null;
  const requestStats = () => Effect.sync(() => ({ waits, remaining }));

  // Hold the gate across the wait and retry: no other run spends requests during a cooldown.
  const request = <E, R>(send: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>) =>
    requestGate.withPermits(1)(
      Effect.gen(function* () {
        const read = send.pipe(
          Effect.tap((res) =>
            Effect.sync(() => {
              const value = res.headers["x-ratelimit-remaining"];
              if (value !== undefined) remaining = headerNumber(value) ?? remaining;
            }),
          ),
        );
        const res = yield* read;
        if (res.status !== 403 && res.status !== 429) return res;
        const now = yield* Clock.currentTimeMillis;
        const retryAfter = res.headers["retry-after"];
        const seconds = headerNumber(retryAfter);
        const date =
          retryAfter !== undefined && /^[A-Za-z]/.test(retryAfter) ? Date.parse(retryAfter) : NaN;
        const reset = headerNumber(res.headers["x-ratelimit-reset"]);
        const until =
          seconds !== undefined
            ? now + seconds * 1000
            : Number.isFinite(date)
              ? date
              : reset !== undefined
                ? reset * 1000
                : undefined;
        if (until === undefined) return res;
        const delay = Math.max(0, until - now);
        waits++;
        yield* Effect.logInfo(`github: ${res.status}, waiting ${delay}ms before retrying`);
        yield* Effect.sleep(delay);
        return yield* read;
      }),
    );

  const httpError = Effect.fn("GitHubSource.httpError")(function* (
    res: HttpClientResponse.HttpClientResponse,
    operation: string,
    detail: string,
  ) {
    const body = yield* res.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const message =
      body !== null &&
      typeof body === "object" &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message
        : "";
    return yield* new SourceError({
      operation,
      status: res.status,
      detail: `${detail}: GitHub answered ${res.status} ${message}`.trim(),
    });
  });

  const decode =
    <S extends Schema.Top>(schema: S, operation: string, detail: string) =>
    (body: unknown) =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(srcError(operation, `${detail}: unexpected response shape`)),
      );

  // The installation token is good for an hour; mint a fresh one a little before that.
  const mintToken: Effect.Effect<string, SourceError> =
    cfg.auth._tag === "token"
      ? Effect.succeed(Redacted.value(cfg.auth.token))
      : Effect.gen(function* () {
          const auth = cfg.auth as Extract<GithubConfig["auth"], { _tag: "app" }>;
          const jwt = yield* appJwt(auth.appId, auth.privateKey);
          const response = yield* request(
            api.post(`/app/installations/${auth.installationId}/access_tokens`, {
              headers: { authorization: `Bearer ${jwt}` },
            }),
          ).pipe(Effect.mapError(srcError("token", "installation token")));
          if (response.status < 200 || response.status >= 300)
            return yield* httpError(response, "token", "installation token");
          const res = yield* response.json.pipe(
            Effect.mapError(srcError("token", "installation token")),
          );
          const t = yield* decode(InstallationToken, "token", "installation token")(res);
          yield* Effect.logInfo(`github: installation token minted, expires ${t.expires_at}`);
          return t.token;
        });
  const token = yield* Effect.cachedWithTTL(mintToken, "50 minutes");

  /** GET a JSON document from the API with the current token. */
  const getJson = <S extends Schema.Top>(
    path: string,
    schema: S,
    operation: string,
    detail: string,
    cache?: Map<string, { etag: string; body: S["Type"] }>,
  ) =>
    Effect.gen(function* () {
      const t = yield* token;
      const fail = srcError(operation, `${detail}: ${path}`);
      const previous = cache?.get(path);
      const res = yield* request(
        api.get(path, {
          headers: {
            authorization: `Bearer ${t}`,
            ...(previous ? { "if-none-match": previous.etag } : {}),
          },
        }),
      ).pipe(Effect.mapError(fail));
      if (res.status === 304 && previous) return previous.body;
      if (res.status < 200 || res.status >= 300) return yield* httpError(res, operation, detail);
      const body = yield* res.json.pipe(Effect.mapError(fail));
      const decoded = yield* decode(schema, operation, detail)(body);
      const etag = res.headers["etag"];
      if (etag) cache?.set(path, { etag, body: decoded });
      else cache?.delete(path);
      return decoded;
    });

  /** Walk `page=` until a short page or `max` items. GitHub caps `per_page` at 100. */
  const pages = <S extends Schema.Top, A>(
    pathFor: (page: number) => string,
    schema: S,
    pick: (body: S["Type"]) => ReadonlyArray<A>,
    max: number,
    operation: string,
    detail: string,
    cache?: Map<string, { etag: string; body: S["Type"] }>,
  ) =>
    Effect.gen(function* () {
      const out: A[] = [];
      for (let page = 1; out.length < max; page++) {
        const chunk = pick(yield* getJson(pathFor(page), schema, operation, detail, cache));
        out.push(...chunk);
        if (chunk.length < PAGE) break;
      }
      return out.slice(0, max);
    });

  const repoPath = (r: RepoRef) =>
    `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;

  const repos = Effect.fn("GitHubSource.repos")(function* () {
    if (cfg.repos.length) return cfg.repos;
    if (cfg.auth._tag === "token")
      return yield* new SourceError({
        operation: "repos",
        detail: "GITHUB_REPOS is required with GITHUB_TOKEN",
      });
    const list = yield* pages(
      (p) => `/installation/repositories?per_page=${PAGE}&page=${p}`,
      InstallationRepos,
      (x) => x.repositories,
      500,
      "repos",
      "installation repositories",
    );
    return list.map((r): RepoRef => ({ owner: r.owner.login, repo: r.name }));
  });

  // Cache each representation, including page, branch and limit. Revalidate on every pass.
  // Keeping the body lets ingest retry indexed downloads even when the runs have not changed.
  const runPages = new Map<string, { etag: string; body: typeof WorkflowRuns.Type }>();
  const listRuns = Effect.fn("GitHubSource.listRuns")(function* (
    repo: RepoRef,
    opts: { readonly limit: number; readonly branch?: string },
  ) {
    const branch = opts.branch ? `&branch=${encodeURIComponent(opts.branch)}` : "";
    const runs = yield* pages(
      (p) =>
        `${repoPath(repo)}/actions/runs?status=completed&per_page=${Math.min(PAGE, opts.limit)}&page=${p}${branch}`,
      WorkflowRuns,
      (x) => x.workflow_runs,
      opts.limit,
      "listRuns",
      `${repo.owner}/${repo.repo}`,
      runPages,
    );
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
  });

  const listArtifacts = Effect.fn("GitHubSource.listArtifacts")(function* (run: RunMeta) {
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
  });

  const listRepoArtifacts = Effect.fn("GitHubSource.listRepoArtifacts")(function* (
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
  });

  const listRefs = Effect.fn("GitHubSource.listRefs")(function* (repo: RepoRef) {
    const detail = `${repo.owner}/${repo.repo}`;
    const [releases, tags, pulls, deployments] = yield* Effect.all(
      [
        pages(
          (p) => `${repoPath(repo)}/releases?per_page=${PAGE}&page=${p}`,
          Schema.Array(Release),
          (x) => x,
          200,
          "listRefs",
          `${detail} releases`,
        ),
        pages(
          (p) => `${repoPath(repo)}/tags?per_page=${PAGE}&page=${p}`,
          Schema.Array(Tag),
          (x) => x,
          300,
          "listRefs",
          `${detail} tags`,
        ),
        pages(
          (p) =>
            `${repoPath(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=${PAGE}&page=${p}`,
          Schema.Array(PullRequest),
          (x) => x,
          200,
          "listRefs",
          `${detail} pull requests`,
        ),
        pages(
          (p) => `${repoPath(repo)}/deployments?per_page=${PAGE}&page=${p}`,
          Schema.Array(Deployment),
          (x) => x,
          100,
          "listRefs",
          `${detail} deployments`,
        ),
      ],
      { concurrency: 4 },
    );
    const shaOfTag = new Map(tags.map((t) => [t.name, t.commit.sha]));
    const out: Ref[] = [];
    for (const r of releases) {
      if (r.draft) continue;
      const onBranch = r.target_commitish && !SHA.test(r.target_commitish);
      out.push({
        kind: "release",
        key: r.tag_name,
        ...repo,
        commit:
          shaOfTag.get(r.tag_name) ??
          (r.target_commitish && SHA.test(r.target_commitish) ? r.target_commitish : null),
        branch: onBranch ? r.target_commitish : null,
        timestamp: r.published_at ?? r.created_at,
        title: r.name ?? null,
        url: r.html_url,
        meta: { prerelease: r.prerelease },
      });
    }
    const released = new Set(out.map((r) => r.key));
    for (const t of tags) {
      if (released.has(t.name)) continue;
      // The tags endpoint has no dates; a tag is placed by its commit alone.
      out.push({
        kind: "tag",
        key: t.name,
        ...repo,
        commit: t.commit.sha,
        branch: null,
        timestamp: "",
        title: null,
        url: `https://github.com/${repo.owner}/${repo.repo}/releases/tag/${encodeURIComponent(t.name)}`,
        meta: {},
      });
    }
    for (const p of pulls)
      out.push({
        kind: "pull_request",
        key: `#${p.number}`,
        ...repo,
        commit: p.head.sha,
        branch: p.head.ref,
        timestamp: p.created_at,
        title: p.title,
        url: p.html_url,
        meta: {
          base: p.base.ref,
          ...(p.user ? { author: p.user.login } : {}),
          ...(p.closed_at ? { closedAt: p.closed_at } : {}),
          ...(p.merged_at ? { mergedAt: p.merged_at } : {}),
          ...(p.draft ? { draft: true } : {}),
        },
      });
    // One deployment per environment: the newest.
    const newest = new Map<string, (typeof deployments)[number]>();
    for (const d of deployments) {
      const have = newest.get(d.environment);
      if (!have || have.created_at < d.created_at) newest.set(d.environment, d);
    }
    for (const d of newest.values())
      out.push({
        kind: "deployment",
        key: d.environment,
        ...repo,
        commit: d.sha,
        branch: SHA.test(d.ref) ? null : d.ref,
        timestamp: d.created_at,
        title: null,
        url: null,
        meta: { environment: d.environment, deploymentId: d.id },
      });
    return out;
  });

  // The zip endpoint answers 302 to a signed blob URL. Fetch would follow it and may carry
  // the token across origins, so read the redirect by hand and fetch the blob bare.
  const openArtifact = Effect.fn("GitHubSource.openArtifact")(function* (artifact: ArtifactMeta) {
    const t = yield* token;
    const path = `${repoPath(artifact)}/actions/artifacts/${artifact.artifactId}/zip`;
    const first = yield* request(api.get(path, { headers: { authorization: `Bearer ${t}` } })).pipe(
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
  });

  const source: Interface = {
    kind: "github",
    requestStats,
    repos,
    listRuns,
    listArtifacts,
    listRepoArtifacts,
    listRefs,
    openArtifact,
  };
  return source;
});

/** The GitHub source from AppConfig; needs an HttpClient. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    if (Option.isNone(cfg.github))
      return yield* Effect.die(
        "SOURCE=github needs GITHUB_TOKEN, or GITHUB_APP_ID with GITHUB_APP_PRIVATE_KEY and GITHUB_INSTALLATION_ID",
      );
    const g = cfg.github.value;
    yield* Effect.logInfo(
      `artifact source: github (${g.auth._tag}) ${g.repos.length ? g.repos.map((r) => `${r.owner}/${r.repo}`).join(", ") : "every installed repository"}`,
    );
    return Service.of(yield* make(g));
  }),
);

export * as GitHubSource from "./github-source.ts";

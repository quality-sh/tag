// The GitHub API client: one request gate, rate-limit waits, token minting, and paged JSON.
import { createSign } from "node:crypto";
import { Clock, Effect, Exit, Option, Redacted, Schedule, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import type { GithubConfig } from "./config.ts";
import { type Interface as InstallationInterface } from "./installation.ts";
import { SourceError } from "./artifact-source.ts";
import { InstallationToken, PAGE } from "./github-schemas.ts";

export const srcError = (operation: string, detail: string) => (cause: unknown) =>
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

export const httpError = Effect.fn("GitHubSource.httpError")(function* (
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

export const decode =
  <S extends Schema.Top>(schema: S, operation: string, detail: string) =>
  (body: unknown) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(srcError(operation, `${detail}: unexpected response shape`)),
    );

const headerNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

/** What the feature modules read from GitHub through: the gate, the token, and the paged reads. */
export interface Client {
  readonly base: HttpClient.HttpClient;
  readonly api: HttpClient.HttpClient;
  readonly request: <E, R>(
    send: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>;
  readonly requestStats: () => Effect.Effect<{
    readonly waits: number;
    readonly remaining: number | null;
  }>;
  readonly token: Effect.Effect<string, SourceError>;
  readonly getJson: <S extends Schema.Top>(
    path: string,
    schema: S,
    operation: string,
    detail: string,
    cache?: Map<string, { etag: string; body: S["Type"] }>,
  ) => Effect.Effect<S["Type"], SourceError, S["DecodingServices"]>;
  readonly pages: <S extends Schema.Top, A>(
    pathFor: (page: number) => string,
    schema: S,
    pick: (body: S["Type"]) => ReadonlyArray<A>,
    max: number,
    operation: string,
    detail: string,
    cache?: Map<string, { etag: string; body: S["Type"] }>,
  ) => Effect.Effect<ReadonlyArray<A>, SourceError, S["DecodingServices"]>;
  readonly repoPath: (r: { readonly owner: string; readonly repo: string }) => string;
}

export const makeClient = (
  cfg: GithubConfig,
  installation: InstallationInterface,
): Effect.Effect<Client, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
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

    // The installation token is good for an hour; mint a fresh one a little before that.
    // A failed mint (no installation recorded yet) expires at once, so a live record flips
    // the source without a restart.
    const mintToken: Effect.Effect<string, SourceError> =
      cfg.auth._tag === "token"
        ? Effect.succeed(Redacted.value(cfg.auth.token))
        : Effect.gen(function* () {
            const auth = cfg.auth as Extract<GithubConfig["auth"], { _tag: "app" }>;
            const id = yield* installation.current();
            if (Option.isNone(id))
              return yield* new SourceError({
                operation: "token",
                detail:
                  "no installation recorded yet; install the App or set GITHUB_INSTALLATION_ID",
              });
            const jwt = yield* appJwt(auth.appId, auth.privateKey);
            const response = yield* request(
              api.post(`/app/installations/${id.value}/access_tokens`, {
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
    const token = yield* Effect.cachedWithTTL(mintToken, (exit) =>
      Exit.isSuccess(exit) ? "50 minutes" : 0,
    );

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

    const repoPath = (r: { readonly owner: string; readonly repo: string }) =>
      `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;

    return { base, api, request, requestStats, token, getJson, pages, repoPath };
  });

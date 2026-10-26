// Repository writes for a proposed CI change: a branch from the default branch, the files on
// it, and the pull request. A refusal for want of an App permission is WriteDenied, and the
// branch this began is deleted again, so a denied proposal leaves nothing behind.
import { Effect, Schema } from "effect";
import { HttpBody } from "effect/http";
import {
  SourceError,
  WriteDenied,
  type PullRequestDraft,
  type PullRequestRef,
  type RepoRef,
} from "./artifact-source.ts";
import { decode, srcError, type Client } from "./github-client.ts";
import {
  ContentSha,
  GitHubMessage,
  GitRef,
  OpenedPull,
  OpenedPulls,
  RepoDetail,
} from "./github-schemas.ts";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What GitHub answered a write: the status, its message, and the body. */
interface Answer {
  readonly status: number;
  readonly message: string;
  readonly body: unknown;
}

const decodeMessage = Schema.decodeUnknownResult(GitHubMessage);

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** A 403, or a 422 that names a permission or a workflow file, is a refusal to write. */
const isDenied = (a: Answer) =>
  a.status === 403 || (a.status === 422 && /permission|not accessible|workflow/i.test(a.message));

const stateOf = (p: typeof OpenedPull.Type): PullRequestRef["state"] =>
  p.merged_at ? "merged" : p.state === "closed" ? "closed" : "open";

export const makeRepoWrites = (client: Client) => {
  const { api, request, token, getJson, repoPath } = client;

  const send = Effect.fn("GitHubSource.send")(function* (
    method: Method,
    path: string,
    body?: unknown,
  ) {
    const t = yield* token;
    const options = {
      headers: { authorization: `Bearer ${t}` },
      ...(body === undefined ? {} : { body: HttpBody.jsonUnsafe(body) }),
    };
    const call =
      method === "GET"
        ? api.get(path, options)
        : method === "POST"
          ? api.post(path, options)
          : method === "PUT"
            ? api.put(path, options)
            : method === "PATCH"
              ? api.patch(path, options)
              : api.del(path, options);
    const fail = srcError("openPullRequest", `${method} ${path}`);
    const res = yield* request(call).pipe(Effect.mapError(fail));
    const json = yield* res.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const decoded = decodeMessage(json);
    const message = decoded._tag === "Success" ? (decoded.success.message ?? "") : "";
    return { status: res.status, message, body: json } satisfies Answer;
  });

  /** The body of a successful answer; a refusal or any other failure as its typed error. */
  const check = (answer: Answer, detail: string) => {
    const what = `${detail}: GitHub answered ${answer.status} ${answer.message}`.trim();
    if (isDenied(answer))
      return Effect.fail(new WriteDenied({ detail: what, status: answer.status }));
    if (answer.status < 200 || answer.status >= 300)
      return Effect.fail(
        new SourceError({ operation: "openPullRequest", status: answer.status, detail: what }),
      );
    return Effect.succeed(answer.body);
  };

  const openPullRequest = Effect.fn("GitHubSource.openPullRequest")(function* (
    repo: RepoRef,
    draft: PullRequestDraft,
  ) {
    const where = `${repo.owner}/${repo.repo}`;
    const root = repoPath(repo);
    const detail = yield* getJson(root, RepoDetail, "openPullRequest", where);
    const base = detail.default_branch;
    if (!base)
      return yield* new SourceError({
        operation: "openPullRequest",
        detail: `${where}: no default branch to branch from`,
      });
    const head = yield* getJson(
      `${root}/git/ref/heads/${encodePath(base)}`,
      GitRef,
      "openPullRequest",
      `${where} ${base}`,
    );
    const branchRef = `${root}/git/refs/heads/${encodePath(draft.branch)}`;
    const created = yield* send("POST", `${root}/git/refs`, {
      ref: `refs/heads/${draft.branch}`,
      sha: head.object.sha,
    });
    // A branch left by an earlier proposal starts again from the default branch.
    if (created.status === 422 && /already exists/i.test(created.message))
      yield* check(
        yield* send("PATCH", branchRef, { sha: head.object.sha, force: true }),
        `${where}: moving ${draft.branch}`,
      );
    else yield* check(created, `${where}: creating ${draft.branch}`);

    const writeAndOpen = Effect.gen(function* () {
      for (const file of draft.files) {
        const at = `${root}/contents/${encodePath(file.path)}`;
        const current = yield* send("GET", `${at}?ref=${encodeURIComponent(draft.branch)}`);
        const sha =
          current.status === 404
            ? undefined
            : (yield* decode(
                ContentSha,
                "openPullRequest",
                `${where}: ${file.path}`,
              )(yield* check(current, `${where}: reading ${file.path}`))).sha;
        yield* check(
          yield* send("PUT", at, {
            message: `${draft.title}: ${file.path}`,
            content: Buffer.from(file.text, "utf8").toString("base64"),
            branch: draft.branch,
            ...(sha === undefined ? {} : { sha }),
          }),
          `${where}: writing ${file.path}`,
        );
      }
      const opened = yield* send("POST", `${root}/pulls`, {
        title: draft.title,
        body: draft.body,
        head: draft.branch,
        base,
      });
      if (opened.status === 422 && /already exists/i.test(opened.message)) {
        const open = yield* getJson(
          `${root}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${draft.branch}`)}`,
          OpenedPulls,
          "openPullRequest",
          `${where}: the open pull request from ${draft.branch}`,
        );
        const first = open[0];
        if (first !== undefined) return first;
      }
      return yield* decode(
        OpenedPull,
        "openPullRequest",
        `${where}: the pull request`,
      )(yield* check(opened, `${where}: opening the pull request`));
    }).pipe(
      Effect.catchTag("ArtifactSource.WriteDenied", (denied) =>
        send("DELETE", branchRef).pipe(Effect.ignore, Effect.andThen(Effect.fail(denied))),
      ),
    );
    const pull = yield* writeAndOpen;
    return {
      number: pull.number,
      url: pull.html_url,
      state: stateOf(pull),
      branch: draft.branch,
    } satisfies PullRequestRef;
  });

  return { openPullRequest };
};

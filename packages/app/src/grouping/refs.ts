// Refs: what GitHub knows about a commit or a branch — releases, tags, pull requests,
// deployments — and which of them a run belongs to.
import { Schema } from "effect";

export const RefKind = Schema.Literals(["release", "tag", "pull_request", "deployment"]);
export type RefKind = typeof RefKind.Type;

/** Something GitHub knows about a commit or a branch: a release, a tag, a pull request, a deployment. */
export const Ref = Schema.Struct({
  kind: RefKind,
  key: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  commit: Schema.NullOr(Schema.String),
  /** The branch the ref points at: a release's target, a pull request's head. */
  branch: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  title: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  /** A pull request's base branch, a deployment's environment, a release's prerelease flag. */
  meta: Schema.Record(Schema.String, Schema.Unknown),
});
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

export interface Assigned {
  readonly release: Ref | "unreleased" | null;
  readonly pullRequest: Ref | null;
}

export const sameRepo = (a: { owner: string; repo: string }, b: { owner: string; repo: string }) =>
  a.owner === b.owner && a.repo === b.repo;

/** Which release and pull request a run belongs to, from the refs of its repository. */
export function assign(
  run: {
    owner: string;
    repo: string;
    branch: string | null;
    commit: string | null;
    timestamp: string;
  },
  refs: ReadonlyArray<Ref>,
): Assigned {
  const mine = refs.filter((r) => sameRepo(r, run));
  const releases = mine
    .filter((r) => r.kind === "release" || r.kind === "tag")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let release: Assigned["release"] = null;
  if (releases.length) {
    const atCommit = releases.find(
      (r) => r.commit && run.commit && r.commit.startsWith(run.commit.slice(0, 7)),
    );
    const onTarget = releases.filter((r) => !r.branch || r.branch === run.branch);
    release =
      atCommit ??
      onTarget.find((r) => r.timestamp >= run.timestamp) ??
      (onTarget.length ? "unreleased" : null);
  }
  const prs = mine.filter((r) => r.kind === "pull_request");
  const pullRequest =
    prs.find(
      (r) =>
        r.branch &&
        r.branch === run.branch &&
        r.timestamp <= run.timestamp &&
        (typeof r.meta.closedAt !== "string" || r.meta.closedAt >= run.timestamp),
    ) ?? null;
  return { release, pullRequest };
}

// The CI proposal for a needs-change repository: the change TAG generates from the scan and
// the workflows, and the pull request TAG opens for it through the App.
import { Effect, Option } from "effect";
import { HttpRouter } from "effect/http";
import type { Ref } from "../grouping.ts";
import { NEXTEST_CONFIG, PROPOSAL_TITLE, proposeChange, type Proposal } from "../propose.ts";
import { ArtifactSource } from "./artifact-source.ts";
import { ResultStore } from "./result-store.ts";
import { json, notFound } from "./http-helpers.ts";

/** The branch every proposal pushes; a later proposal moves it back to the default branch. */
export const PROPOSAL_BRANCH = "tag/upload-test-reports";

const isWorkflow = (p: string) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p);

const PERMISSIONS =
  "Opening it needs the App's contents, pull requests and workflows permissions, each with write access.";

/** The stored pull request with the state the latest ref listing knows. */
const withRefState = (
  row: ResultStore.ProposalRow,
  refs: ReadonlyArray<Ref>,
): ResultStore.ProposalRow => {
  const ref = refs.find((r) => r.kind === "pull_request" && r.key === `#${row.number}`);
  if (ref === undefined) return row;
  const state = ref.meta["mergedAt"] ? "merged" : ref.meta["closedAt"] ? "closed" : "open";
  return { ...row, state };
};

const bodyOf = (
  owner: string,
  repo: string,
  change: Proposal,
  pullRequest: ResultStore.ProposalRow | null,
) => ({
  owner,
  repo,
  title: PROPOSAL_TITLE,
  description: change.description,
  files: change.files.map((f) => ({ path: f.path, diff: f.diff, created: f.before === null })),
  notes: change.notes,
  pullRequest,
});

export const addProposalRoutes = (deps: {
  readonly router: HttpRouter.HttpRouter;
  readonly results: ResultStore.Interface;
  readonly source: ArtifactSource.Interface;
}) =>
  Effect.gen(function* () {
    const { router, results, source } = deps;

    /** The change for a needs-change repository, or one TAG already opened a pull request for. */
    const proposalFor = Effect.fn("Http.proposalFor")(function* (owner: string, repo: string) {
      const scan = yield* results.scanOf(owner, repo);
      const stored = yield* results.proposalOf(owner, repo);
      const pullRequest = Option.isSome(stored)
        ? withRefState(stored.value, yield* results.refs({ owner, repo }))
        : null;
      if (Option.isNone(scan)) return Option.none();
      if (scan.value.classification !== "needs-change" && pullRequest === null)
        return Option.none();
      const ref = { owner, repo };
      const paths = yield* source.repoTree(ref);
      const files = yield* source.repoFiles(
        ref,
        paths.filter((p) => isWorkflow(p) || p === NEXTEST_CONFIG),
      );
      const change = proposeChange({ runners: scan.value.runners, files });
      return Option.some({ change, pullRequest });
    });

    const unreadable = (e: ArtifactSource.SourceError) =>
      Effect.succeed(json({ error: `could not read the repository: ${e.detail}` }, 502));

    yield* router.add("GET", "/api/repositories/:owner/:repo/proposal", () =>
      Effect.gen(function* () {
        const { owner = "", repo = "" } = yield* HttpRouter.params;
        const proposal = yield* proposalFor(owner, repo);
        if (Option.isNone(proposal)) return notFound("proposal");
        const { change, pullRequest } = proposal.value;
        return json(bodyOf(owner, repo, change, pullRequest));
      }).pipe(Effect.catchTag("ArtifactSource.SourceError", unreadable)),
    );

    /** Open the pull request; without write access, answer with the diff to copy instead. */
    yield* router.add("POST", "/api/repositories/:owner/:repo/proposal/pull-request", () =>
      Effect.gen(function* () {
        const { owner = "", repo = "" } = yield* HttpRouter.params;
        const proposal = yield* proposalFor(owner, repo);
        if (Option.isNone(proposal)) return notFound("proposal");
        const { change, pullRequest } = proposal.value;
        const body = bodyOf(owner, repo, change, pullRequest);
        if (pullRequest !== null && pullRequest.state === "open")
          return json({ outcome: "opened", ...body });
        if (change.files.length === 0)
          return json({ outcome: "failed", reason: "The workflows need no change.", ...body }, 409);
        return yield* source
          .openPullRequest(
            { owner, repo },
            {
              branch: PROPOSAL_BRANCH,
              title: PROPOSAL_TITLE,
              body: change.description,
              files: change.files.map((f) => ({ path: f.path, text: f.after })),
            },
          )
          .pipe(
            Effect.flatMap((opened) =>
              Effect.gen(function* () {
                const row: ResultStore.ProposalRow = {
                  owner,
                  repo,
                  ...opened,
                  openedAt: new Date().toISOString(),
                };
                yield* results.saveProposal(row);
                return json({ outcome: "opened", ...body, pullRequest: row }, 201);
              }),
            ),
            Effect.catchTag("ArtifactSource.WriteDenied", (e) =>
              Effect.succeed(
                json({
                  outcome: "denied",
                  reason: `GitHub refused the write: ${e.detail}. ${PERMISSIONS} Copy the diff instead, or grant them and try again.`,
                  ...body,
                }),
              ),
            ),
            Effect.catchTag("ArtifactSource.SourceError", (e) =>
              Effect.succeed(
                json({ outcome: "failed", reason: `GitHub failed: ${e.detail}`, ...body }, 502),
              ),
            ),
          );
      }).pipe(Effect.catchTag("ArtifactSource.SourceError", unreadable)),
    );
  });

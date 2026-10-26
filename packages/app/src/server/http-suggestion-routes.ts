// Suggestion routes: what TAG suggests saving for an org, and the yes or no on each one.
import { Effect } from "effect";
import { HttpRouter } from "effect/http";
import { sinceOf, suggestFor, type OrgSuggestion, type ReleaseGroup } from "../grouping.ts";
import { ResultStore } from "./result-store.ts";
import { createCollection } from "./http-collection-routes.ts";
import { BadRequest, defaultBranchesOf, json, notFound, query } from "./http-helpers.ts";

/** How far back the collection suggestions look at runs; tags are read in full. */
const SUGGESTION_RANGE = "90d";

/** The suggestions for each org (all of them unless one is named), minus the dismissed. */
const suggestionsOf = Effect.fn("Http.suggestionsOf")(function* (
  results: ResultStore.Interface,
  org: string | null,
) {
  const refs = yield* results.refs();
  const reports = yield* results.reports({ since: sinceOf(SUGGESTION_RANGE) });
  const collections = yield* results.collections();
  const releaseGroups = yield* results.releaseGroups();
  const defaultBranches = defaultBranchesOf(yield* results.scans());
  const dismissed = yield* results.dismissedSuggestions();
  const orgs = org === null ? [...new Set([...refs, ...reports].map((r) => r.owner))] : [org];
  return orgs
    .flatMap((o) =>
      suggestFor({ org: o, refs, reports, defaultBranches, collections, releaseGroups }),
    )
    .filter((s) => !dismissed.has(s.id));
});

const accept = Effect.fn("Http.acceptSuggestion")(function* (
  results: ResultStore.Interface,
  suggestion: OrgSuggestion,
) {
  const { save } = suggestion;
  if (save._tag === "collection") {
    const collection = yield* createCollection(results, {
      name: save.name,
      description: save.description ?? "",
      query: save.query,
    });
    return { saved: "collection" as const, collection };
  }
  const releaseGroup: ReleaseGroup = {
    id: suggestion.id,
    org: save.org,
    repositories: save.repositories,
    rule: save.rule,
    createdAt: new Date().toISOString(),
  };
  yield* results.saveReleaseGroup(releaseGroup);
  return { saved: "release-group" as const, releaseGroup };
});

export const addSuggestionRoutes = (deps: {
  readonly router: HttpRouter.HttpRouter;
  readonly results: ResultStore.Interface;
}) =>
  Effect.gen(function* () {
    const { router, results } = deps;

    yield* router.add("GET", "/api/suggestions", (req) =>
      Effect.gen(function* () {
        const org = query(req).get("org");
        if (!org) return yield* new BadRequest({ detail: "org is required" });
        return json(yield* suggestionsOf(results, org));
      }),
    );

    yield* router.add("POST", "/api/suggestions/:id/accept", () =>
      Effect.gen(function* () {
        const { id = "" } = yield* HttpRouter.params;
        const suggestion = (yield* suggestionsOf(results, null)).find((s) => s.id === id);
        if (!suggestion) return notFound("suggestion");
        return json(yield* accept(results, suggestion), 201);
      }),
    );

    yield* router.add("POST", "/api/suggestions/:id/dismiss", () =>
      Effect.gen(function* () {
        const { id = "" } = yield* HttpRouter.params;
        const known = (yield* suggestionsOf(results, null)).some((s) => s.id === id);
        if (!known) return notFound("suggestion");
        yield* results.dismissSuggestion(id);
        return json({ ok: true });
      }),
    );
  });

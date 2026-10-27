// Suggestion routes: the yes or no on each thing TAG suggests saving. The list itself is a
// read route in http-api.ts.
import { Effect } from "effect";
import { HttpRouter } from "effect/http";
import type { OrgSuggestion, ReleaseGroup } from "../grouping.ts";
import { ResultStore } from "./result-store.ts";
import { createCollection } from "./http-collection-routes.ts";
import type { Reads } from "./reads.ts";
import { json, notFound } from "./http-helpers.ts";

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
  readonly reads: Reads.Interface;
}) =>
  Effect.gen(function* () {
    const { router, results, reads } = deps;

    yield* router.add("POST", "/api/suggestions/:id/accept", () =>
      Effect.gen(function* () {
        const { id = "" } = yield* HttpRouter.params;
        const suggestion = (yield* reads.suggestions(null)).find((s) => s.id === id);
        if (!suggestion) return notFound("suggestion");
        return json(yield* accept(results, suggestion), 201);
      }),
    );

    yield* router.add("POST", "/api/suggestions/:id/dismiss", () =>
      Effect.gen(function* () {
        const { id = "" } = yield* HttpRouter.params;
        const known = (yield* reads.suggestions(null)).some((s) => s.id === id);
        if (!known) return notFound("suggestion");
        yield* results.dismissSuggestion(id);
        return json({ ok: true });
      }),
    );
  });

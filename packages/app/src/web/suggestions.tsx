// Suggestion cards on an org's page: what TAG would save, and a yes or a no for each.
import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import { Card, Cmd, Inline, Ink, K, Space, Stack } from "@quality-sh/tag-ui";
import { OrgSuggestion } from "../grouping.ts";
import { ApiError, Unauthorized } from "./client.ts";
import { keys } from "./state.ts";

const decodeSuggestions = Schema.decodeUnknownEffect(Schema.Array(OrgSuggestion));

interface Interface {
  readonly list: (
    org: string,
  ) => Effect.Effect<ReadonlyArray<OrgSuggestion>, ApiError | Unauthorized>;
  readonly answer: (
    id: string,
    answer: "accept" | "dismiss",
  ) => Effect.Effect<void, ApiError | Unauthorized>;
}

class SuggestionApi extends Context.Service<SuggestionApi, Interface>()("@tag/web/SuggestionApi") {}

const statusOf = (status: number) =>
  status === 401
    ? Effect.fail(new Unauthorized())
    : status >= 400
      ? Effect.fail(new ApiError({ status, detail: `request failed with ${status}` }))
      : Effect.void;

const layer = Layer.effect(
  SuggestionApi,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const transportError = (e: unknown) => new ApiError({ status: 0, detail: String(e) });
    return SuggestionApi.of({
      list: Effect.fn("SuggestionApi.list")(function* (org: string) {
        const res = yield* client
          .get(`/api/suggestions?org=${encodeURIComponent(org)}`)
          .pipe(Effect.mapError(transportError));
        yield* statusOf(res.status);
        const body = yield* res.json.pipe(Effect.mapError(transportError));
        return yield* decodeSuggestions(body).pipe(
          Effect.mapError((e) => new ApiError({ status: res.status, detail: String(e) })),
        );
      }),
      answer: Effect.fn("SuggestionApi.answer")(function* (id: string, answer) {
        const res = yield* client
          .post(`/api/suggestions/${encodeURIComponent(id)}/${answer}`)
          .pipe(Effect.mapError(transportError));
        yield* statusOf(res.status);
      }),
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

const runtime = Atom.runtime(layer);
const SUGGESTIONS = ["suggestions"];

const suggestionsAtom = Atom.family((org: string) =>
  runtime
    .atom(SuggestionApi.use((api) => api.list(org)))
    .pipe(Atom.withReactivity([...SUGGESTIONS, ...keys.runs, ...keys.collections])),
);

// A yes saves a collection or a release group, so the views and the rail read again.
const acceptFn = runtime.fn((id: string) => SuggestionApi.use((api) => api.answer(id, "accept")), {
  reactivityKeys: [...SUGGESTIONS, ...keys.collections],
});
const dismissFn = runtime.fn(
  (id: string) => SuggestionApi.use((api) => api.answer(id, "dismiss")),
  { reactivityKeys: SUGGESTIONS },
);

const KIND_LABEL: Record<OrgSuggestion["kind"], string> = {
  "release-group": "Release group",
  production: "Collection · production",
  semver: "Collection · versioned releases",
  scheduled: "Collection · scheduled runs",
  "failing-default": "Collection · failing on the default branch",
};

/** The exact record a yes would save. */
const savedOf = (s: OrgSuggestion) =>
  s.save._tag === "collection"
    ? `saves the collection “${s.save.name}”: ${s.save.query}`
    : `saves the release group ${s.save.org}: ${s.save.repositories.join(", ")} · rule: ${s.save.rule}`;

/** The org's open suggestions as cards; nothing at all when there are none or they fail. */
export function SuggestionCards({ org }: { org: string }) {
  const result = useAtomValue(suggestionsAtom(org));
  if (!AsyncResult.isSuccess(result) || result.value.length === 0) return null;
  return (
    <Space top={28}>
      <Stack gap={14}>
        {result.value.map((s) => (
          <SuggestionCard key={s.id} s={s} />
        ))}
      </Stack>
    </Space>
  );
}

function SuggestionCard({ s }: { s: OrgSuggestion }) {
  const [accepting, accept] = useAtom(acceptFn);
  const [dismissing, dismiss] = useAtom(dismissFn);
  const busy = AsyncResult.isWaiting(accepting) || AsyncResult.isWaiting(dismissing);
  const failed = AsyncResult.isFailure(accepting) || AsyncResult.isFailure(dismissing);
  return (
    <Card head={KIND_LABEL[s.kind]} meta="suggested">
      <Stack gap={10}>
        <Ink>{s.sentence}</Ink>
        <K block>{savedOf(s)}</K>
        <Inline gap={10}>
          <Cmd small primary disabled={busy} onClick={() => accept(s.id)}>
            yes, save it
          </Cmd>
          <Cmd small disabled={busy} onClick={() => dismiss(s.id)}>
            no
          </Cmd>
          {failed && <K tone="bad">That did not save. Try again.</K>}
        </Inline>
      </Stack>
    </Card>
  );
}

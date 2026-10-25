// Application state as Effect atoms. Reads are atoms over the API runtime and
// refresh when a write invalidates their reactivity key; the route and the
// search bar's typed text are plain writable atoms.
import { Effect, Option, Schedule } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as Reactivity from "effect/reactivity/Reactivity";
import { isGroupBy, isRange, type GroupBy, type Range } from "../grouping.ts";
import {
  ApiError,
  TagApi,
  layer as apiLayer,
  type GroupsQuery,
  type OverviewQuery,
} from "./client.ts";

// Routes

export interface View {
  readonly by: GroupBy;
  readonly q: string;
  readonly range: Range;
  /** The collection the view came from, when it did. */
  readonly collection: string | null;
}

/** What a page is about: everything under an org, one repository, or a collection's query. */
export type Scope =
  | { readonly kind: "org"; readonly owner: string }
  | { readonly kind: "repo"; readonly owner: string; readonly repo: string }
  | { readonly kind: "collection"; readonly id: string };

export type Route =
  | { page: "overview"; range: Range }
  | { page: "scope"; scope: Scope; q: string; range: Range }
  | ({ page: "view" } & View)
  | ({ page: "group"; key: string } & View)
  | { page: "collections" }
  | { page: "report"; reportId: string }
  | { page: "test"; owner: string; repo: string; testId: string };

const DEFAULT_VIEW: View = { by: "release", q: "", range: "30d", collection: null };

export function parseRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").map(decodeURIComponent);
  const params = new URLSearchParams(search);
  const view = (by: string | undefined): View => ({
    by: by && isGroupBy(by) ? by : DEFAULT_VIEW.by,
    q: params.get("q") ?? "",
    range: isRange(params.get("range") ?? "") ? (params.get("range") as Range) : DEFAULT_VIEW.range,
    collection: params.get("c"),
  });
  if (parts[0] === "report" && parts[1]) return { page: "report", reportId: parts[1] };
  if (parts[0] === "test" && parts[1] && parts[2] && parts[3])
    return { page: "test", owner: parts[1], repo: parts[2], testId: parts[3] };
  if (parts[0] === "collections") return { page: "collections" };
  const scoped = (scope: Scope): Route => {
    const { q, range } = view(undefined);
    return { page: "scope", scope, q, range };
  };
  if (parts[0] === "org" && parts[1]) return scoped({ kind: "org", owner: parts[1] });
  if (parts[0] === "r" && parts[1] && parts[2])
    return scoped({ kind: "repo", owner: parts[1], repo: parts[2] });
  if (parts[0] === "c" && parts[1]) return scoped({ kind: "collection", id: parts[1] });
  if (parts[0] === "g" && parts[1] && parts[2])
    return { page: "group", key: parts[2], ...view(parts[1]) };
  if (parts[0] === "g") return { page: "view", ...view(parts[1]) };
  return { page: "overview", range: view(undefined).range };
}

const viewSearch = (v: Partial<View>) => {
  const p = new URLSearchParams();
  if (v.q) p.set("q", v.q);
  if (v.range && v.range !== DEFAULT_VIEW.range) p.set("range", v.range);
  if (v.collection) p.set("c", v.collection);
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** The filter a scope stands for; a collection's lives on the server, so it is sent as `c`. */
export const scopeQuery = (s: Scope): { q: string; c: string | null } =>
  s.kind === "org"
    ? { q: `org:${s.owner}`, c: null }
    : s.kind === "repo"
      ? { q: `repo:${s.owner}/${s.repo}`, c: null }
      : { q: "", c: s.id };

export const scopePath = (s: Scope) =>
  s.kind === "org"
    ? `#/org/${encodeURIComponent(s.owner)}`
    : s.kind === "repo"
      ? `#/r/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`
      : `#/c/${encodeURIComponent(s.id)}`;

export const href = {
  overview: (range: Range = DEFAULT_VIEW.range) => `#/${viewSearch({ range })}`,
  scope: (s: Scope, v: { q?: string; range?: Range } = {}) =>
    `${scopePath(s)}${viewSearch({ ...(v.q ? { q: v.q } : {}), ...(v.range ? { range: v.range } : {}) })}`,
  home: (v: Partial<View> = {}) => `#/g/${v.by ?? DEFAULT_VIEW.by}${viewSearch(v)}`,
  group: (by: GroupBy, key: string, v: Partial<View> = {}) =>
    `#/g/${by}/${encodeURIComponent(key)}${viewSearch(v)}`,
  collections: () => "#/collections",
  report: (id: string) => `#/report/${encodeURIComponent(id)}`,
  test: (owner: string, repo: string, testId: string) =>
    `#/test/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(testId)}`,
};

export const routeAtom = Atom.make<Route>(parseRoute(location.hash)).pipe(Atom.keepAlive);

// Runtime and reads

export const runtime = Atom.runtime(apiLayer);

const keys = { session: ["session"], runs: ["runs"], collections: ["collections"] } as const;

const withApi = <A, E>(f: (api: TagApi["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const api = yield* TagApi;
    return yield* f(api);
  });

export const sessionAtom = runtime
  .atom(withApi((api) => api.session()))
  .pipe(Atom.withReactivity(keys.session), Atom.keepAlive);

const SEP = "\u0000";
export const viewKey = (v: GroupsQuery & { key?: string }) =>
  [v.by, v.q, v.range, v.key ?? "", v.c ?? ""].join(SEP);
const parseKey = (k: string) => {
  const [by = "release", q = "", range = "30d", key = "", c = ""] = k.split(SEP);
  return { by: by as GroupBy, q, range: range as Range, key, c: c || undefined };
};

export const overviewKey = (o: OverviewQuery) => [o.range, o.q, o.c ?? ""].join(SEP);
export const overviewAtom = Atom.family((key: string) => {
  const [range = "30d", q = "", c = ""] = key.split(SEP);
  return runtime
    .atom(withApi((api) => api.overview({ range: range as Range, q, c: c || undefined })))
    .pipe(Atom.withReactivity([...keys.runs, ...keys.collections]));
});

export const groupsAtom = Atom.family((key: string) =>
  runtime
    .atom(withApi((api) => api.groups(parseKey(key))))
    .pipe(Atom.withReactivity([...keys.runs, ...keys.collections])),
);

export const groupAtom = Atom.family((key: string) =>
  runtime.atom(withApi((api) => api.group(parseKey(key)))).pipe(Atom.withReactivity(keys.runs)),
);

/** What is being typed in the search bar, and the suggestions for it. */
export const typedAtom = Atom.make("").pipe(Atom.keepAlive);
export const suggestionsAtom = Atom.family((typed: string) =>
  runtime
    .atom(typed.trim() ? withApi((api) => api.fields(typed)) : Effect.succeed([]))
    .pipe(Atom.withReactivity(keys.runs)),
);

export const collectionsAtom = runtime
  .atom(withApi((api) => api.collections()))
  .pipe(Atom.withReactivity(keys.collections));

export const reportAtom = Atom.family((reportId: string) =>
  runtime.atom(withApi((api) => api.report(reportId))).pipe(Atom.withReactivity(keys.runs)),
);

export const historyKey = (owner: string, repo: string, testId: string) =>
  [owner, repo, testId].join(SEP);
export const historyAtom = Atom.family((key: string) => {
  const [owner = "", repo = "", testId = ""] = key.split(SEP);
  return runtime
    .atom(withApi((api) => api.history(owner, repo, testId)))
    .pipe(Atom.withReactivity(keys.runs));
});

// Writes

export const loginFn = runtime.fn((password: string) =>
  withApi((api) => api.login(password)).pipe(
    Effect.tap((ok) => (ok ? Reactivity.invalidate(keys.session) : Effect.void)),
  ),
);

export const logoutFn = runtime.fn(() =>
  withApi((api) => api.logout()).pipe(Effect.andThen(Reactivity.invalidate(keys.session))),
);

export const checkForNewRuns = Effect.fn("web.checkForNewRuns")(function* () {
  const api = yield* TagApi;
  const { passId } = yield* api.ingest();
  let completed = 0;
  const poll = Effect.gen(function* () {
    const status = yield* api.ingestStatus();
    if (status.lastFinished?.passId === passId) {
      yield* Reactivity.invalidate(keys.runs);
      return Option.some(status.lastFinished.summary);
    }
    if (status.running?.passId !== passId) {
      yield* Reactivity.invalidate(keys.runs);
      return yield* new ApiError({
        status: 0,
        detail: "The ingest pass is no longer available. Check for new runs again.",
      });
    }
    if (status.running.repositories.length > completed) {
      completed = status.running.repositories.length;
      yield* Reactivity.invalidate(keys.runs);
    }
    return Option.none();
  });
  const summary = yield* poll.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: Option.isSome,
    }),
  );
  if (Option.isNone(summary))
    return yield* new ApiError({ status: 0, detail: "The ingest pass has no summary." });
  return summary.value;
});

export const ingestFn = runtime.fn(() => checkForNewRuns()).pipe(Atom.keepAlive);

export const createCollectionFn = runtime.fn(
  (input: { name: string; description: string; query: string }) =>
    withApi((api) => api.createCollection(input)),
  { reactivityKeys: keys.collections },
);

export const deleteCollectionFn = runtime.fn(
  (id: string) => withApi((api) => api.deleteCollection(id)),
  { reactivityKeys: keys.collections },
);

// The embedded artifact viewer on a report page.

export interface Embed {
  readonly url: string;
  readonly title: string;
}
export const embedAtom = Atom.make<Option.Option<Embed>>(Option.none()).pipe(Atom.keepAlive);

export const openArtifactFn = runtime.fn(
  (arg: { artifactId: string; path: string; title: string; inline: boolean }, get) =>
    withApi((api) => api.artifactLink(arg.artifactId, arg.path)).pipe(
      Effect.tap(({ url }) =>
        Effect.sync(() => {
          if (arg.inline) get.set(embedAtom, Option.some({ url, title: arg.title }));
          else window.open(url, "_blank", "noopener");
        }),
      ),
    ),
);

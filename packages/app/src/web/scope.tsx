// A scope's page: an org, a repository or a collection, with its repositories on top and
// every view below as a section, each fetched when it scrolls into sight.
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Cmd,
  K,
  Empty,
  Link,
  RailGroup,
  RailItem,
  Section,
  Seg,
  Shell,
  Space,
  Toolbar,
  Topbar,
  TopbarAction,
} from "@quality-sh/tag-ui";
import { GROUP_BY_INFO, RANGES, type GroupBy, type Range } from "../grouping.ts";
import { BackfillStatus, backfillOf, useBackfilling } from "./backfill.tsx";
import type { OverviewPage as Overview, RepositoryState } from "./client.ts";
import { InstallLink, Loaded, SignOut, cap } from "./common.tsx";
import { GroupsTable, Rail, Search, scopeCrumbs } from "./home.tsx";
import { Repository } from "./overview.tsx";
import { SuggestionCards } from "./suggestions.tsx";
import {
  groupsAtom,
  href,
  ingestFn,
  overviewAtom,
  overviewKey,
  scopeQuery,
  viewKey,
  type Scope,
  type View,
} from "./state.ts";

/** The views on a scope page, in reading order. */
const SECTIONS: ReadonlyArray<GroupBy> = [
  "release",
  "branch",
  "pull_request",
  "environment",
  "tag",
  "tool",
  "workflow",
  "day",
];
const ROWS = 8;

const go = (h: string) => {
  location.hash = h;
};

/** The filter a section sends: the scope's own, then what the bar holds. */
const queryOf = (scope: Scope, q: string) => `${scopeQuery(scope).q} ${q}`.trim();

export function ScopePage({ scope, q, range }: { scope: Scope; q: string; range: Range }) {
  const { c } = scopeQuery(scope);
  const key = overviewKey({ range, q: queryOf(scope, q), c: c ?? undefined });
  const result = useAtomValue(overviewAtom(key));
  const data = AsyncResult.isSuccess(result) ? result.value : undefined;
  const [ingest, runIngest] = useAtom(ingestFn);
  const ingesting = AsyncResult.isWaiting(ingest);
  const backfilling = useBackfilling().filter(
    (s) => scope.kind !== "repo" || (s.owner === scope.owner && s.repo === scope.repo),
  );
  const title =
    scope.kind === "collection"
      ? (data?.collections.find((x) => x.id === scope.id)?.name ?? scope.id)
      : scope.kind === "org"
        ? scope.owner
        : scope.repo;
  const view: View = { by: "release", q, range, collection: c };
  return (
    <>
      <Topbar
        wordmark="TAG"
        href={href.overview()}
        crumbs={[
          { label: "Overview", href: href.overview(range) },
          ...scopeCrumbs(scope, range, data?.collections).slice(0, -1),
          { label: title },
        ]}
        actions={
          <>
            <TopbarAction href={href.collections()}>collections</TopbarAction>
            <InstallLink />
            <SignOut />
          </>
        }
      />
      <Shell
        rail={
          <Rail scope={scope} range={range} collections={data?.collections} repos={data?.repoList}>
            <RailGroup title="On this page">
              {SECTIONS.map((by) => (
                <RailItem
                  key={by}
                  href={`${href.scope(scope, { q, range })}`}
                  count={data?.counts[by]}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`view-${by}`)?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  {GROUP_BY_INFO[by].label}
                </RailItem>
              ))}
            </RailGroup>
          </Rail>
        }
      >
        {scope.kind === "org" && <SuggestionCards org={scope.owner} />}
        <Space top={28}>
          <Toolbar>
            <Seg<Range>
              label="Time range"
              value={range}
              onChange={(r) => go(href.scope(scope, { q, range: r }))}
              options={RANGES.map((r) => ({ value: r, label: r }))}
            />
            <Cmd small onClick={() => runIngest()} disabled={ingesting}>
              {ingesting ? "checking…" : "check for new runs"}
            </Cmd>
            {!ingesting && AsyncResult.isSuccess(ingest) && (
              <span role="status">
                <K>
                  {ingest.value.inserted} new reports · {ingest.value.errors.length} errors
                </K>
              </span>
            )}
            {!ingesting && AsyncResult.isFailure(ingest) && (
              <span role="status">
                <K tone="bad">Check failed. Try again.</K>
              </span>
            )}
            <BackfillStatus states={backfilling} />
          </Toolbar>
        </Space>
        <Search
          q={q}
          label={`Filter ${scope.kind === "repo" ? `${scope.owner}/${scope.repo}` : title}`}
          onQuery={(next) => go(href.scope(scope, { q: next, range }))}
        />
        <Loaded result={result}>
          {(d) => <Repositories d={d} range={range} states={backfilling} />}
        </Loaded>
        {SECTIONS.map((by) => (
          <ViewSection
            key={by}
            by={by}
            scope={scope}
            view={view}
            count={data?.counts[by]}
            flat={scope.kind === "repo"}
          />
        ))}
      </Shell>
    </>
  );
}

function Repositories({
  d,
  range,
  states,
}: {
  d: Overview;
  range: Range;
  states: ReadonlyArray<RepositoryState>;
}) {
  if (d.repos.length === 0)
    return (
      <Space top={26}>
        <Empty>
          {states.length > 0
            ? "Backfilling this repository. Its runs appear as they land."
            : "No runs in this range. Widen it, loosen the filters, or check for new runs."}
        </Empty>
      </Space>
    );
  return (
    <>
      {d.repos.map((r, i) => (
        <Repository
          key={`${r.owner}/${r.repo}`}
          r={r}
          range={range}
          first={i === 0}
          link={d.repos.length > 1}
          state={backfillOf(states, r.owner, r.repo)}
        />
      ))}
    </>
  );
}

/** One view as a section: a placeholder until it scrolls near, then the newest rows. */
function ViewSection({
  by,
  scope,
  view,
  count,
  flat,
}: {
  by: GroupBy;
  scope: Scope;
  view: View;
  count: number | undefined;
  flat: boolean;
}) {
  const [ref, seen] = useNearViewport<HTMLDivElement>();
  const info = GROUP_BY_INFO[by];
  const full = href.home({ ...view, by, q: queryOf(scope, view.q) });
  return (
    <div ref={ref} id={`view-${by}`}>
      <Section
        eyebrow={cap(info.label)}
        count={
          count !== undefined ? (
            <Link href={full}>
              all {count} {count === 1 ? info.one : info.label}
            </Link>
          ) : undefined
        }
      >
        {seen ? (
          <SectionRows by={by} scope={scope} view={view} flat={flat} full={full} />
        ) : (
          <Placeholder />
        )}
      </Section>
    </div>
  );
}

function SectionRows({
  by,
  scope,
  view,
  flat,
  full,
}: {
  by: GroupBy;
  scope: Scope;
  view: View;
  flat: boolean;
  full: string;
}) {
  const q = queryOf(scope, view.q);
  const result = useAtomValue(
    groupsAtom(viewKey({ by, q, range: view.range, c: view.collection ?? undefined })),
  );
  return (
    <Loaded result={result}>
      {(d) => (
        <>
          <GroupsTable d={d} view={{ ...view, by, q }} flat={flat} limit={ROWS} />
          {d.groups.length > ROWS && (
            <Space top={12}>
              <Link href={full}>
                {d.groups.length - ROWS} more {GROUP_BY_INFO[by].label} →
              </Link>
            </Space>
          )}
        </>
      )}
    </Loaded>
  );
}

function Placeholder(): ReactNode {
  return <div style={{ minHeight: 120 }} aria-hidden="true" />;
}

/** True once the element has come within a screen of the viewport; it stays true. */
function useNearViewport<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (!("IntersectionObserver" in window)) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

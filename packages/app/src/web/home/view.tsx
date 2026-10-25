// The view page: one group-by's full table, reached from a scope page's "all n",
// with the time range, the group-by picker and the search bar on top.
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Cmd,
  K,
  NarrowOnly,
  Seg,
  Select,
  Shell,
  Space,
  Strip,
  Toolbar,
  Topbar,
  TopbarAction,
  plural,
  type StripItem,
} from "@quality-sh/tag-ui";
import {
  GROUP_BY_INFO,
  RANGES,
  isGroupBy,
  parseQuery,
  type Collection,
  type GroupBy,
  type GroupRow,
  type Range,
} from "../../grouping.ts";
import type { GroupsPage } from "../client.ts";
import { InstallLink, Loaded, SignOut, cap } from "../common.tsx";
import { groupsAtom, href, ingestFn, viewKey, type Scope, type View } from "../state.ts";
import { GroupsTable } from "./groups-table.tsx";
import { pct } from "./bits.tsx";
import { Rail } from "./rail.tsx";
import { Search } from "./search.tsx";

const RAIL_GROUP_BYS: ReadonlyArray<GroupBy> = [
  "release",
  "branch",
  "pull_request",
  "environment",
  "tag",
  "tool",
  "workflow",
  "run",
];

const go = (h: string) => {
  location.hash = h;
};

/** Runs per day over the last 14 days, from the trends of every group, each run once. */
function daily(groups: ReadonlyArray<GroupRow>, days = 14) {
  const seen = new Map<string, { passRate: number; failed: number }>();
  for (const g of groups)
    for (const t of g.trend)
      if (!seen.has(t.runId)) seen.set(t.runId, { passRate: t.passRate, failed: t.failed });
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const buckets = Array.from({ length: days }, () => ({ runs: 0, pass: 0, failed: 0 }));
  for (const g of groups)
    for (const t of g.trend) {
      const day = new Date(t.timestamp).setUTCHours(0, 0, 0, 0);
      const i = days - 1 - Math.floor((today.getTime() - day) / 86_400_000);
      const b = buckets[i];
      const r = seen.get(t.runId);
      if (!b || !r) continue;
      seen.delete(t.runId);
      b.runs++;
      b.pass += r.passRate;
      b.failed += r.failed;
    }
  return {
    runs: buckets.map((b) => b.runs),
    passRate: buckets.map((b) => (b.runs ? b.pass / b.runs : 0)),
    failed: buckets.map((b) => b.failed),
  };
}

/** The full table of one view, reached from a scope page's "all n". */
export function ViewPage({ view }: { view: View }) {
  const result = useAtomValue(groupsAtom(viewKey({ ...view, c: view.collection ?? undefined })));
  const data = AsyncResult.isSuccess(result) ? result.value : undefined;
  const [ingest, runIngest] = useAtom(ingestFn);
  const ingesting = AsyncResult.isWaiting(ingest);
  const info = GROUP_BY_INFO[view.by];
  const scope = scopeOfView(view, data?.collections);
  return (
    <>
      <Topbar
        wordmark="TAG"
        href={href.overview()}
        crumbs={[
          { label: "Overview", href: href.overview(view.range) },
          ...scopeCrumbs(scope, view.range, data?.collections),
          { label: cap(info.label) },
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
          <Rail
            scope={scope}
            range={view.range}
            collections={data?.collections}
            repos={data?.repos}
          />
        }
      >
        <Space top={28}>
          <Toolbar>
            <Seg<Range>
              label="Time range"
              value={view.range}
              onChange={(range) => go(href.home({ ...view, range }))}
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
          </Toolbar>
        </Space>
        <NarrowOnly>
          <Space top={0}>
            <Select
              label="Group by"
              placeholder="group by"
              value={view.by}
              onChange={(by) => go(href.home({ ...view, by: isGroupBy(by) ? by : "release" }))}
              options={RAIL_GROUP_BYS.map((g) => ({ value: g, label: GROUP_BY_INFO[g].label }))}
            />
          </Space>
        </NarrowOnly>
        <Search
          q={view.q}
          label={`Filter ${info.label}`}
          onQuery={(q) => go(href.home({ ...view, q }))}
        />
        <Loaded result={result}>
          {(d) => (
            <>
              <Space top={26}>
                <Summary d={d} />
              </Space>
              <Space top={26}>
                <GroupsTable d={d} view={view} />
              </Space>
            </>
          )}
        </Loaded>
      </Shell>
    </>
  );
}

/** A view's scope, when its query is exactly one org or repository, or it came from a collection. */
export function scopeOfView(
  view: View,
  collections?: ReadonlyArray<Collection>,
): Scope | undefined {
  if (view.collection && (collections ?? []).some((c) => c.id === view.collection))
    return { kind: "collection", id: view.collection };
  const filters = parseQuery(view.q);
  if (filters.length !== 1 || filters[0]?.op !== "is") return undefined;
  const f = filters[0];
  if (f.field === "org") return { kind: "org", owner: f.value };
  if (f.field === "repo" && f.value.includes("/")) {
    const [owner = "", repo = ""] = f.value.split("/");
    return { kind: "repo", owner, repo };
  }
  return undefined;
}

/** Crumbs from the overview down to a scope: org, then repository, or the collection. */
export function scopeCrumbs(
  scope: Scope | undefined,
  range: Range,
  collections?: ReadonlyArray<Collection>,
): Array<{ label: string; href?: string }> {
  if (!scope) return [];
  if (scope.kind === "collection")
    return [
      {
        label: collections?.find((c) => c.id === scope.id)?.name ?? scope.id,
        href: href.scope(scope, { range }),
      },
    ];
  const org = {
    label: scope.owner,
    href: href.scope({ kind: "org", owner: scope.owner }, { range }),
  };
  return scope.kind === "org"
    ? [org]
    : [org, { label: scope.repo, href: href.scope(scope, { range }) }];
}

function Summary({ d }: { d: GroupsPage }) {
  const day = daily(d.groups);
  const items: StripItem[] = [
    {
      key: "runs",
      label: "runs",
      value: d.totals.runs,
      note: d.range === "all" ? "all time" : `last ${d.range}`,
      bars: { values: day.runs },
    },
    {
      key: "pass",
      label: "pass rate",
      value: pct(d.totals.passRate),
      note: "latest run per group",
      tone: d.totals.passRate !== null && d.totals.passRate < 1 ? "flaky" : "passed",
      bars: { values: day.passRate, tone: "passed" },
    },
    {
      key: "failing",
      label: "failing now",
      value: d.totals.failingNow,
      note: `of ${plural(d.groups.length, GROUP_BY_INFO[d.by].one)}`,
      tone: d.totals.failingNow > 0 ? "failed" : "quiet",
      bars: { values: day.failed, tone: "failed" },
    },
    {
      key: "flaky",
      label: "flaky",
      value: d.totals.flaky,
      note: "tests in the latest runs",
      tone: d.totals.flaky > 0 ? "flaky" : "quiet",
    },
  ];
  return <Strip label={`Summary over ${d.range}`} items={items} />;
}

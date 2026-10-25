// The views: the rail every page shares, the full table of one view, one group's page,
// and the collections page where a query gets a name.
import { useState, type ReactNode } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Bad,
  Card,
  Cmd,
  Delta,
  Empty,
  Head,
  HeadRow,
  Ink,
  K,
  Link,
  Mark,
  Name,
  NarrowOnly,
  Page,
  PillInput,
  RailGroup,
  RailItem,
  SearchBar,
  Section,
  Seg,
  Select,
  Shell,
  Plot,
  Space,
  Spark,
  Split,
  Stack,
  Strip,
  Table,
  Toolbar,
  Topbar,
  TopbarAction,
  fmtDay,
  fmtMs,
  fmtWhen,
  plural,
  type Chip,
  type Column,
  type StripItem,
  type Suggestion as UiSuggestion,
} from "@quality-sh/tag-ui";
import {
  GROUP_BY_INFO,
  RANGES,
  chipOf,
  formatQuery,
  isGroupBy,
  parseQuery,
  type Collection,
  type GroupBy,
  type GroupRow,
  type Range,
  type RunSummary,
  type Suggestion,
} from "../grouping.ts";
import type { CollectionRow, GroupDetail, GroupsPage, RepoRow } from "./client.ts";
import { Loaded, SignOut, cap } from "./common.tsx";
import {
  collectionsAtom,
  createCollectionFn,
  deleteCollectionFn,
  groupAtom,
  groupsAtom,
  href,
  ingestFn,
  scopePath,
  sessionAtom,
  suggestionsAtom,
  typedAtom,
  viewKey,
  type Scope,
  type View,
} from "./state.ts";

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

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

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

const Good = ({ n }: { n: number | undefined }) =>
  n === undefined ? <Dim>—</Dim> : n > 0 ? <K tone="good">{n}</K> : <Dim>0</Dim>;
const Dim = ({ children }: { children: ReactNode }) => <K tone="dim">{children}</K>;

/** The App install link, when the server serves one; GitHub sends the admin back here. */
function InstallLink() {
  const session = useAtomValue(sessionAtom);
  const installUrl = AsyncResult.isSuccess(session) ? session.value.installUrl : undefined;
  return installUrl ? <TopbarAction href={installUrl}>install on GitHub</TopbarAction> : null;
}

const Verdict = ({ failed, none }: { failed: boolean; none?: boolean }) =>
  none ? (
    <Mark tone="quiet">no runs</Mark>
  ) : (
    <Mark tone={failed ? "failed" : "passed"}>{failed ? "failed" : "passed"}</Mark>
  );

// ---------------------------------------------------------------------------
// Rail

/** Where a page can go: the overview, every org and repository, the collections. */
export function Rail({
  scope,
  range,
  collections,
  repos,
  overview,
  children,
}: {
  scope?: Scope | undefined;
  range: Range;
  collections?: ReadonlyArray<Collection> | undefined;
  repos?: ReadonlyArray<RepoRow> | undefined;
  overview?: boolean;
  /** Extra groups, such as a page's own sections. */
  children?: ReactNode;
}) {
  const orgs = new Map<string, RepoRow[]>();
  for (const r of repos ?? []) orgs.set(r.owner, [...(orgs.get(r.owner) ?? []), r]);
  const is = (s: Scope) => scope !== undefined && scopePath(s) === scopePath(scope);
  return (
    <>
      <RailGroup title="Home">
        <RailItem href={href.overview(range)} on={overview === true}>
          overview
        </RailItem>
      </RailGroup>
      {children}
      {[...orgs.entries()].map(([owner, list]) => (
        <RailGroup key={owner} title={owner}>
          <RailItem
            href={href.scope({ kind: "org", owner }, { range })}
            on={is({ kind: "org", owner })}
            count={list.reduce((a, r) => a + r.reports, 0)}
          >
            everything
          </RailItem>
          {list.map((r) => (
            <RailItem
              key={r.repo}
              href={href.scope({ kind: "repo", owner, repo: r.repo }, { range })}
              on={is({ kind: "repo", owner, repo: r.repo })}
              count={r.reports}
            >
              {r.repo}
            </RailItem>
          ))}
        </RailGroup>
      ))}
      <RailGroup title="Collections">
        {(collections ?? []).map((c) => (
          <RailItem
            key={c.id}
            href={href.scope({ kind: "collection", id: c.id }, { range })}
            on={is({ kind: "collection", id: c.id })}
          >
            {c.name}
          </RailItem>
        ))}
        <RailItem href={href.collections()} action>
          + new collection
        </RailItem>
      </RailGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Search

export function Search({
  q,
  label,
  onQuery,
}: {
  q: string;
  label: string;
  onQuery: (q: string) => void;
}) {
  const [typed, setTyped] = useAtom(typedAtom);
  const result = useAtomValue(suggestionsAtom(typed));
  const suggestions = AsyncResult.isSuccess(result) ? result.value : [];
  const filters = parseQuery(q);
  const chips: Chip[] = filters.map((f, i) => ({ key: `${i}`, ...chipOf(f) }));
  const navigate = (next: string) => onQuery(next.trim());
  const uiSuggestions: UiSuggestion[] = suggestions.map((s) => ({
    key: s.token,
    field: s.kind === "text" ? null : s.kind === "field" ? "field" : (s.field ?? ""),
    value: s.value,
    count: s.count,
    note: s.note,
    partial: s.kind === "field",
  }));
  const pick = (u: UiSuggestion) => {
    const s = suggestions.find((x: Suggestion) => x.token === u.key);
    if (!s) return;
    if (s.kind === "field") {
      setTyped(s.token);
      return;
    }
    setTyped("");
    navigate(`${q} ${s.token}`);
  };
  return (
    <SearchBar
      label={label}
      typed={typed}
      onTyped={setTyped}
      chips={chips}
      onRemove={(c) => navigate(formatQuery(filters.filter((_, i) => `${i}` !== c.key)))}
      suggestions={uiSuggestions}
      onPick={pick}
      onSubmit={(text) => {
        setTyped("");
        navigate(`${q} ${text}`);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Home

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

/** Rows of groups, sectioned by repository unless `flat`; `limit` keeps the newest few. */
export function GroupsTable({
  d,
  view,
  flat,
  limit,
}: {
  d: GroupsPage;
  view: View;
  flat?: boolean;
  limit?: number;
}) {
  const by = d.by;
  const groups = limit === undefined ? d.groups : d.groups.slice(0, limit);
  const nameOf = (g: GroupRow) =>
    by === "run" && g.latest
      ? href.report(g.latest.reportIds[0] ?? "")
      : href.group(by, g.key, view);
  // The table is sectioned by repository, so the repository fact is already said.
  const facts = (g: GroupRow) => g.facts.filter((f) => f !== `${g.owner}/${g.repo}`);
  const columns: Column<GroupRow>[] = [
    {
      key: "name",
      head: cap(GROUP_BY_INFO[by].one),
      wrap: true,
      cell: (g) => (
        <Name sub={facts(g).join(" · ")}>
          <Link ink href={nameOf(g)}>
            {g.label}
          </Link>
        </Name>
      ),
    },
    {
      key: "verdict",
      head: "Verdict",
      cell: (g) => <Verdict failed={g.verdict === "failed"} none={g.verdict === "none"} />,
    },
    { key: "passed", head: "Passed", right: true, cell: (g) => <Good n={g.latest?.passed} /> },
    {
      key: "failed",
      head: "Failed",
      right: true,
      cell: (g) => (g.latest?.failed ? <Bad>{g.latest.failed}</Bad> : <Dim>0</Dim>),
    },
    {
      key: "flaky",
      head: "Flaky",
      right: true,
      cell: (g) => (g.latest?.flaky ? <K tone="warn">{g.latest.flaky}</K> : <Dim>0</Dim>),
    },
    {
      key: "skipped",
      head: "Skipped",
      right: true,
      hideUnder: 1280,
      cell: (g) => <Dim>{g.latest?.skipped ?? 0}</Dim>,
    },
    {
      key: "wall",
      head: "Wall time",
      right: true,
      hideUnder: 1280,
      cell: (g) => (g.latest ? fmtMs(g.latest.duration) : "—"),
    },
    {
      key: "vs",
      head: by === "branch" || by === "pull_request" ? "vs base" : "vs previous",
      right: true,
      hideUnder: 900,
      cell: (g) => (
        <Delta
          pp={g.vsBaseline}
          title={g.baselineLabel ? `against ${g.baselineLabel}` : undefined}
        />
      ),
    },
    {
      key: "trend",
      head: "Trend",
      hideUnder: 1100,
      cell: (g) => (
        <Spark
          points={g.trend.map((t) => ({ value: t.passRate, bad: t.failed > 0 }))}
          label={`${g.trend.length} runs`}
        />
      ),
    },
    {
      key: "last",
      head: by === "release" ? "Tagged" : "Last run",
      right: true,
      dim: true,
      cell: (g) => {
        const at = by === "release" && g.ref ? g.ref.timestamp : g.lastAt;
        return at ? <span title={at}>{fmtWhen(at)}</span> : "—";
      },
    },
  ];
  if (groups.length === 0)
    return (
      <Empty>
        No {GROUP_BY_INFO[by].label} match. Loosen the filters, widen the range, or check for new
        runs.
      </Empty>
    );
  const byRepo = new Map<string, GroupRow[]>();
  for (const g of groups) {
    const k = `${g.owner}/${g.repo}`;
    byRepo.set(k, [...(byRepo.get(k) ?? []), g]);
  }
  const sections = [...byRepo.entries()].map(([key, rows]) => ({
    key,
    head: (
      <HeadRow
        title={key}
        count={`${plural(rows.length, GROUP_BY_INFO[by].one)} · ${plural(
          rows.reduce((a, g) => a + g.runs, 0),
          "run",
        )}`}
      />
    ),
    rows,
  }));
  const rowKey = (g: GroupRow) => `${g.owner}/${g.repo}:${g.key}`;
  return by === "repo" || flat ? (
    <Table middle columns={columns} rows={groups} rowKey={rowKey} />
  ) : (
    <Table middle columns={columns} sections={sections} rowKey={rowKey} />
  );
}

// ---------------------------------------------------------------------------
// One group

export function GroupPage({ view, groupKey }: { view: View; groupKey: string }) {
  const result = useAtomValue(groupAtom(viewKey({ ...view, key: groupKey })));
  const info = GROUP_BY_INFO[view.by];
  return (
    <>
      <Topbar
        wordmark="TAG"
        href={href.overview()}
        crumbs={[
          { label: "Overview", href: href.overview(view.range) },
          ...scopeCrumbs(scopeOfView(view), view.range),
          { label: cap(info.label), href: href.home(view) },
          { label: groupKey },
        ]}
        actions={<SignOut />}
      />
      <Page>
        <Loaded result={result}>{(d) => <GroupBody d={d} view={view} />}</Loaded>
      </Page>
    </>
  );
}

/** The test count per run, oldest first; a red dot is a run with failures. */
function TestsOverTime({ runs }: { runs: ReadonlyArray<RunSummary> }) {
  const series = [...runs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const first = series[0];
  const last = series[series.length - 1];
  const grew = first && last ? last.tests - first.tests : 0;
  const failing = series.filter((r) => r.failed > 0).length;
  const note = [
    plural(series.length, "run"),
    grew === 0 ? "same count" : `${grew > 0 ? "+" : ""}${grew} tests since the first`,
    failing ? `${failing} with failures` : "none failed",
  ].join(" · ");
  return (
    <Space top={16}>
      <Plot
        title="Tests over time"
        note={note}
        points={series.map((r) => ({
          y: r.tests,
          label: fmtDay(r.timestamp),
          failed: r.failed > 0,
        }))}
        format={(v) => String(Math.round(v))}
        tone="metric"
      />
    </Space>
  );
}

function GroupBody({ d, view }: { d: GroupDetail; view: View }) {
  const g = d.group;
  const info = GROUP_BY_INFO[view.by];
  const avg = d.runs.length ? d.runs.reduce((a, r) => a + r.duration, 0) / d.runs.length : null;
  const latest = g.latest;
  const strip: StripItem[] = [
    {
      key: "verdict",
      label: "verdict",
      value: <Verdict failed={g.verdict === "failed"} none={g.verdict === "none"} />,
      note: latest ? fmtWhen(latest.timestamp) : undefined,
    },
    {
      key: "passed",
      label: "passed",
      value: latest?.passed ?? "—",
      tone: "passed",
      note: latest ? `of ${plural(latest.tests, "test")}` : undefined,
    },
    {
      key: "failed",
      label: "failed",
      value: latest?.failed ?? "—",
      tone: latest?.failed ? "failed" : "quiet",
      note: latest?.flaky ? `${latest.flaky} flaky` : "none flaky",
    },
    {
      key: "rate",
      label: "pass rate",
      value: latest ? pct(latest.passRate) : "—",
      tone: latest && latest.passRate < 1 ? "flaky" : "passed",
      note: g.baselineLabel ? (
        <>
          <Delta pp={g.vsBaseline} /> vs {g.baselineLabel}
        </>
      ) : undefined,
    },
  ];
  const runColumns: Column<RunSummary>[] = [
    {
      key: "run",
      head: "Run",
      wrap: true,
      cell: (r) => (
        <Name
          sub={[r.branch, r.commit?.slice(0, 7), r.tools.join(" · ")].filter(Boolean).join(" · ")}
        >
          <Link ink href={href.report(r.reportIds[0] ?? "")}>
            {r.runId}
          </Link>
        </Name>
      ),
    },
    { key: "verdict", head: "Verdict", cell: (r) => <Verdict failed={r.failed > 0} /> },
    { key: "passed", head: "Passed", right: true, cell: (r) => <Good n={r.passed} /> },
    {
      key: "failed",
      head: "Failed",
      right: true,
      cell: (r) => (r.failed ? <Bad>{r.failed}</Bad> : <Dim>0</Dim>),
    },
    {
      key: "flaky",
      head: "Flaky",
      right: true,
      cell: (r) => (r.flaky ? <K tone="warn">{r.flaky}</K> : <Dim>0</Dim>),
    },
    {
      key: "skipped",
      head: "Skipped",
      right: true,
      hideUnder: 1100,
      cell: (r) => <Dim>{r.skipped}</Dim>,
    },
    { key: "wall", head: "Wall time", right: true, cell: (r) => fmtMs(r.duration) },
    {
      key: "avg",
      head: "vs average",
      right: true,
      hideUnder: 900,
      cell: (r) => (avg ? <Delta pp={((r.duration - avg) / avg) * 100} title="wall time" /> : "—"),
    },
    {
      key: "when",
      head: "When",
      right: true,
      dim: true,
      cell: (r) => <span title={r.timestamp}>{fmtWhen(r.timestamp)}</span>,
    },
  ];
  return (
    <>
      <Head
        eyebrow={info.one}
        title={g.label}
        question={g.ref?.title ?? undefined}
        facts={[
          ...g.facts,
          plural(g.runs, "run"),
          g.ref?.timestamp ? `tagged ${fmtDay(g.ref.timestamp)}` : null,
          g.ref?.url ? (
            <Link external href={g.ref.url}>
              on GitHub ↗
            </Link>
          ) : null,
          latest?.buildUrl ? (
            <Link external href={latest.buildUrl}>
              workflow ↗
            </Link>
          ) : null,
        ]}
        aside={
          <>
            {d.previous && <Link href={href.group(view.by, d.previous, view)}>← {d.previous}</Link>}
            {d.next && <Link href={href.group(view.by, d.next, view)}>{d.next} →</Link>}
          </>
        }
      />
      <Strip label={g.ref?.commit ? "At the tagged commit" : "Latest run"} items={strip} />
      {d.runs.length >= 2 && <TestsOverTime runs={d.runs} />}
      <Split>
        <Stack gap={16}>
          <Card head="Failing tests" meta={plural(d.failing.length, "test")}>
            {d.failing.length === 0 ? (
              <K>Nothing failed in the latest run.</K>
            ) : (
              <Stack>
                {d.failing.slice(0, 12).map((t) => (
                  <div key={`${t.reportId}:${t.testId}`}>
                    <Link ink href={href.test(g.owner, g.repo, t.testId)}>
                      {t.name}
                    </Link>
                    <K block>
                      {[t.tool, t.suite, t.message?.split("\n")[0]?.slice(0, 100)]
                        .filter(Boolean)
                        .join(" · ")}
                    </K>
                  </div>
                ))}
              </Stack>
            )}
          </Card>
          <Card head="Most common errors" meta={plural(d.errors.length, "distinct error")}>
            {d.errors.length === 0 ? (
              <K>No errors.</K>
            ) : (
              <Stack>
                {d.errors.slice(0, 8).map((e) => (
                  <div
                    key={e.message}
                    style={{ display: "flex", gap: 12, justifyContent: "space-between" }}
                  >
                    <K>
                      <Ink>{e.message}</Ink>
                    </K>
                    <K tone="bad">{e.count}</K>
                  </div>
                ))}
              </Stack>
            )}
          </Card>
        </Stack>
      </Split>
      <Section
        eyebrow={
          g.baselineLabel && view.by === "release" ? `Runs since ${g.baselineLabel}` : "Runs"
        }
        count={plural(d.runs.length, "run")}
      >
        {d.runs.length === 0 ? (
          <Empty>No runs in this range.</Empty>
        ) : (
          <Table middle columns={runColumns} rows={d.runs} rowKey={(r) => r.runId} />
        )}
      </Section>
      <Section eyebrow="Flaky tests" count={plural(d.flaky.length, "test")}>
        {d.flaky.length === 0 ? (
          <Empty>No test flaked in these runs.</Empty>
        ) : (
          <Table
            columns={[
              {
                key: "name",
                head: "Test",
                cell: (t) => (
                  <Link ink href={href.test(g.owner, g.repo, t.testId)}>
                    {t.name}
                  </Link>
                ),
              },
              { key: "tool", head: "Tool", dim: true, cell: (t) => t.tool },
              {
                key: "n",
                head: "Flaked",
                right: true,
                cell: (t) => <K tone="warn">{t.occurrences}</K>,
              },
            ]}
            rows={d.flaky}
            rowKey={(t) => t.testId}
          />
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Collections

export function CollectionsPage() {
  const result = useAtomValue(collectionsAtom);
  const [create, runCreate] = useAtom(createCollectionFn);
  const remove = useAtomSet(deleteCollectionFn);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const saving = AsyncResult.isWaiting(create);
  const submit = () => {
    if (!name.trim()) return;
    runCreate({ name: name.trim(), description: description.trim(), query: query.trim() });
    setName("");
    setDescription("");
    setQuery("");
  };
  return (
    <>
      <Topbar
        wordmark="TAG"
        href={href.overview()}
        crumbs={[{ label: "Overview", href: href.overview() }, { label: "Collections" }]}
        actions={<SignOut />}
      />
      <Page>
        <Space top={28}>
          <Loaded result={result}>
            {(list) =>
              list.length === 0 ? (
                <Empty>No collections yet. Make one below.</Empty>
              ) : (
                <CollectionsTable rows={list} onDelete={(id) => remove(id)} />
              )
            }
          </Loaded>
        </Space>
        <Section eyebrow="New collection">
          <div style={{ maxWidth: "34rem" }}>
            <Stack gap={14}>
              <Field label="Name">
                <PillInput label="Name" value={name} onChange={setName} placeholder="payments" />
              </Field>
              <Field label="Description">
                <PillInput
                  label="Description"
                  value={description}
                  onChange={setDescription}
                  placeholder="what this watches"
                />
              </Field>
              <Field label="Include runs where">
                <PillInput
                  label="Include runs where"
                  value={query}
                  onChange={setQuery}
                  placeholder="org:acme tag:smoke -env:staging"
                />
              </Field>
              <div>
                <Cmd primary onClick={submit} disabled={saving || !name.trim()}>
                  {saving ? "saving…" : "create collection"}
                </Cmd>
              </div>
            </Stack>
          </div>
        </Section>
      </Page>
    </>
  );
}

/** Collections as rows: what each holds now, and where it opens. */
export function CollectionsTable({
  rows,
  onDelete,
}: {
  rows: ReadonlyArray<CollectionRow>;
  onDelete?: (id: string) => void;
}) {
  const columns: Column<CollectionRow>[] = [
    {
      key: "name",
      head: "Collection",
      wrap: true,
      cell: (c) => (
        <Name sub={c.description || undefined}>
          <Link ink href={href.scope({ kind: "collection", id: c.id })}>
            {c.name}
          </Link>
        </Name>
      ),
    },
    {
      key: "q",
      head: "Include runs where",
      cell: (c) =>
        c.query ? (
          <span style={{ display: "inline-flex", gap: 10, flexWrap: "wrap" }}>
            {parseQuery(c.query).map((f, i) => {
              const chip = chipOf(f);
              return (
                <K key={i}>
                  {chip.field}: <Ink>{chip.value}</Ink>
                </K>
              );
            })}
          </span>
        ) : (
          <Dim>every run</Dim>
        ),
    },
    { key: "repos", head: "Repositories", right: true, cell: (c) => c.repos },
    { key: "runs", head: "Runs · 30d", right: true, cell: (c) => c.runs },
    {
      key: "failing",
      head: "Failing",
      right: true,
      cell: (c) => (c.failing ? <Bad>{c.failing}</Bad> : <Dim>0</Dim>),
    },
  ];
  if (onDelete)
    columns.push({
      key: "x",
      head: "",
      right: true,
      cell: (c) => (
        <Cmd small onClick={() => onDelete(c.id)}>
          delete
        </Cmd>
      ),
    });
  return <Table middle columns={columns} rows={rows} rowKey={(c) => c.id} />;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <K>{label}</K>
      {children}
    </label>
  );
}

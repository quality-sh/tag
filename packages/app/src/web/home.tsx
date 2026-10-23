// The home page (runs grouped by anything, filtered by a query), one group's
// page, and the collections page where a query and a group-by get a name.
import { useState, type ReactNode } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Bad,
  Card,
  Cmd,
  Delta,
  Empty,
  Facts,
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
  Spark,
  Split,
  Stack,
  Strip,
  Table,
  Topbar,
  TopbarAction,
  fmtMs,
  fmtWhen,
  plural,
  type Chip,
  type Column,
  type StripItem,
  type Suggestion as UiSuggestion,
} from "@quality-sh/verdict-ui";
import {
  GROUP_BYS,
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
import type { GroupsPage } from "./client.ts";
import { Loaded, SignOut, cap } from "./common.tsx";
import {
  collectionsAtom,
  createCollectionFn,
  deleteCollectionFn,
  groupAtom,
  groupsAtom,
  href,
  ingestFn,
  suggestionsAtom,
  typedAtom,
  viewKey,
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

const verdictTone = (g: GroupRow) =>
  g.verdict === "failed" ? "failed" : g.verdict === "passed" ? "passed" : "quiet";

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

/** Runs per day over the last 14 days, from the trends of every group, each run once. */
function daily(groups: ReadonlyArray<GroupRow>, days = 14) {
  const seen = new Map<string, { passRate: number; failed: number; flaky: number }>();
  for (const g of groups)
    for (const t of g.trend)
      if (!seen.has(t.runId))
        seen.set(t.runId, { passRate: t.passRate, failed: t.failed, flaky: 0 });
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const buckets = Array.from({ length: days }, () => ({ runs: 0, pass: 0, failed: 0 }));
  for (const g of groups)
    for (const t of g.trend) {
      const i =
        days -
        1 -
        Math.floor((today.getTime() - new Date(t.timestamp).setUTCHours(0, 0, 0, 0)) / 86_400_000);
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

// ---------------------------------------------------------------------------
// Rail

function Rail({ view, data }: { view: View; data: GroupsPage | undefined }) {
  return (
    <>
      <RailGroup title="Group by">
        {RAIL_GROUP_BYS.map((by) => (
          <RailItem
            key={by}
            href={href.home({ ...view, by, collection: null })}
            on={view.by === by && !view.collection}
            count={data?.counts[by]}
          >
            {GROUP_BY_INFO[by].label}
          </RailItem>
        ))}
      </RailGroup>
      <RailGroup title="Collections">
        {(data?.collections ?? []).map((c) => (
          <RailItem
            key={c.id}
            href={href.home({ by: c.groupBy, q: c.query, range: view.range, collection: c.id })}
            on={view.collection === c.id}
          >
            {c.name}
          </RailItem>
        ))}
        <RailItem href={href.collections()} action>
          + new collection
        </RailItem>
      </RailGroup>
      <RailGroup title="Repositories">
        {(data?.repos ?? []).map((r) => {
          const q = `repo:${r.owner}/${r.repo}`;
          return (
            <RailItem
              key={q}
              href={href.home({ ...view, q, collection: null })}
              on={view.q === q}
              count={r.reports}
            >
              {r.owner}/{r.repo}
            </RailItem>
          );
        })}
      </RailGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Search

function Search({ view, label }: { view: View; label: string }) {
  const [typed, setTyped] = useAtom(typedAtom);
  const result = useAtomValue(suggestionsAtom(typed));
  const suggestions = AsyncResult.isSuccess(result) ? result.value : [];
  const filters = parseQuery(view.q);
  const chips: Chip[] = filters.map((f, i) => ({ key: `${i}`, ...chipOf(f) }));
  const navigate = (q: string) => go(href.home({ ...view, q: q.trim(), collection: null }));
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
    navigate(`${view.q} ${s.token}`);
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
        navigate(`${view.q} ${text}`);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Home

export function HomePage({ view }: { view: View }) {
  const result = useAtomValue(groupsAtom(viewKey(view)));
  const data = AsyncResult.isSuccess(result) ? result.value : undefined;
  const [ingest, runIngest] = useAtom(ingestFn);
  const ingesting = AsyncResult.isWaiting(ingest);
  const info = GROUP_BY_INFO[view.by];
  const collection = data?.collections.find((c) => c.id === view.collection);
  const title = collection ? collection.name : cap(info.label);
  return (
    <>
      <Topbar
        wordmark="Verdict"
        href={href.home()}
        crumbs={[{ label: title }]}
        actions={
          <>
            <TopbarAction href={href.collections()}>collections</TopbarAction>
            <SignOut />
          </>
        }
      />
      <Shell rail={<Rail view={view} data={data} />}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: "12px 24px",
          }}
        >
          <div style={{ minWidth: 0, maxWidth: "48rem" }}>
            <HeadRow title={collection ? "Collection" : `Group by ${info.one}`} />
            <h1
              style={{
                fontWeight: 300,
                fontSize: "clamp(2rem, 4vw, 2.75rem)",
                lineHeight: 1.05,
                marginTop: 6,
              }}
            >
              {title}
            </h1>
            <p style={{ marginTop: 8 }}>
              <K>{collection ? collection.description || info.lede : info.lede}</K>
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Seg<Range>
              label="Time range"
              value={view.range}
              onChange={(range) => go(href.home({ ...view, range }))}
              options={RANGES.map((r) => ({ value: r, label: r }))}
            />
            <Cmd small onClick={() => runIngest()} disabled={ingesting}>
              {ingesting ? "checking…" : "check for new runs"}
            </Cmd>
          </div>
        </div>
        <NarrowOnly>
          <div style={{ marginTop: 14 }}>
            <Select
              label="Group by"
              placeholder="group by"
              value={view.by}
              onChange={(by) =>
                go(href.home({ ...view, by: isGroupBy(by) ? by : "release", collection: null }))
              }
              options={RAIL_GROUP_BYS.map((g) => ({ value: g, label: GROUP_BY_INFO[g].label }))}
            />
          </div>
        </NarrowOnly>
        <div style={{ marginTop: 18 }}>
          <Search view={view} label={`Filter ${info.label}`} />
        </div>
        <Loaded result={result}>
          {(d) => (
            <>
              <div style={{ marginTop: 26 }}>
                <Summary d={d} />
              </div>
              <div style={{ marginTop: 26 }}>
                <GroupsTable d={d} view={view} />
              </div>
            </>
          )}
        </Loaded>
      </Shell>
    </>
  );
}

function Summary({ d }: { d: GroupsPage }) {
  const day = daily(d.groups);
  const items: StripItem[] = [
    {
      key: "runs",
      label: "runs",
      value: d.totals.runs,
      note: `in ${d.range === "all" ? "all time" : d.range}`,
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
      note: plural(d.groups.length, GROUP_BY_INFO[d.by].one).replace(/^\d+ /, "of "),
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

function GroupsTable({ d, view }: { d: GroupsPage; view: View }) {
  const by = d.by;
  const nameOf = (g: GroupRow) =>
    by === "run" && g.latest
      ? href.report(g.latest.reportIds[0] ?? "")
      : href.group(by, g.key, view);
  const columns: Column<GroupRow>[] = [
    {
      key: "name",
      head: cap(GROUP_BY_INFO[by].one),
      wrap: true,
      cell: (g) => (
        <Name sub={g.facts.join(" · ")}>
          <Link ink href={nameOf(g)}>
            {g.label}
          </Link>
        </Name>
      ),
    },
    {
      key: "verdict",
      head: "Verdict",
      cell: (g) => (
        <Mark tone={verdictTone(g)}>{g.verdict === "none" ? "no runs" : g.verdict}</Mark>
      ),
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
      cell: (g) => <Dim>{g.latest?.skipped ?? 0}</Dim>,
    },
    {
      key: "wall",
      head: "Wall time",
      right: true,
      cell: (g) => (g.latest ? fmtMs(g.latest.duration) : "—"),
    },
    {
      key: "vs",
      head: by === "branch" || by === "pull_request" ? "vs base" : "vs previous",
      right: true,
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
      cell: (g) => (
        <Spark
          points={g.trend.map((t) => ({ value: t.passRate, bad: t.failed > 0 }))}
          label={`${g.trend.length} runs`}
        />
      ),
    },
    {
      key: "last",
      head: "Last run",
      right: true,
      dim: true,
      cell: (g) => (g.lastAt ? <span title={g.lastAt}>{fmtWhen(g.lastAt)}</span> : "—"),
    },
  ];
  if (d.groups.length === 0)
    return (
      <Empty>
        No {GROUP_BY_INFO[by].label} match. Loosen the filters, widen the range, or check for new
        runs.
      </Empty>
    );
  const byRepo = new Map<string, GroupRow[]>();
  for (const g of d.groups) {
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
  return by === "repo" ? (
    <Table middle columns={columns} rows={d.groups} rowKey={rowKey} />
  ) : (
    <Table middle columns={columns} sections={sections} rowKey={rowKey} />
  );
}

const Good = ({ n }: { n: number | undefined }) =>
  n === undefined ? <Dim>—</Dim> : n > 0 ? <K tone="good">{n}</K> : <Dim>0</Dim>;
const Dim = ({ children }: { children: ReactNode }) => <K tone="dim">{children}</K>;

// ---------------------------------------------------------------------------
// One group

export function GroupPage({ view, groupKey }: { view: View; groupKey: string }) {
  const result = useAtomValue(groupAtom(viewKey({ ...view, key: groupKey })));
  const info = GROUP_BY_INFO[view.by];
  return (
    <>
      <Topbar
        wordmark="Verdict"
        href={href.home()}
        crumbs={[{ label: cap(info.label), href: href.home(view) }, { label: groupKey }]}
        actions={<SignOut />}
      />
      <Page>
        <Loaded result={result}>
          {(d) => {
            const g = d.group;
            const avg = d.runs.length
              ? d.runs.reduce((a, r) => a + r.duration, 0) / d.runs.length
              : null;
            const latest = g.latest;
            const strip: StripItem[] = [
              {
                key: "verdict",
                label: "verdict",
                value: (
                  <Mark tone={verdictTone(g)}>{g.verdict === "none" ? "no runs" : g.verdict}</Mark>
                ),
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
                    sub={[r.branch, r.commit?.slice(0, 7), r.tools.join(" · ")]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    <Link ink href={href.report(r.reportIds[0] ?? "")}>
                      {r.runId}
                    </Link>
                  </Name>
                ),
              },
              {
                key: "verdict",
                head: "Verdict",
                cell: (r) => (
                  <Mark tone={r.failed > 0 ? "failed" : "passed"}>
                    {r.failed > 0 ? "failed" : "passed"}
                  </Mark>
                ),
              },
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
              { key: "skipped", head: "Skipped", right: true, cell: (r) => <Dim>{r.skipped}</Dim> },
              { key: "wall", head: "Wall time", right: true, cell: (r) => fmtMs(r.duration) },
              {
                key: "avg",
                head: "vs average",
                right: true,
                cell: (r) =>
                  avg ? <Delta pp={((r.duration - avg) / avg) * 100} title="wall time" /> : "—",
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
                <div
                  style={{
                    paddingTop: "2.5rem",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "flex-end",
                    justifyContent: "space-between",
                    gap: "12px 24px",
                  }}
                >
                  <div style={{ minWidth: 0, maxWidth: "48rem" }}>
                    <HeadRow title={info.one} />
                    <h1
                      style={{
                        fontWeight: 300,
                        fontSize: "clamp(2rem, 4vw, 2.75rem)",
                        lineHeight: 1.05,
                        marginTop: 6,
                      }}
                    >
                      {g.label}
                    </h1>
                    {g.ref?.title && (
                      <p style={{ marginTop: 8, fontStyle: "italic", color: "#908caa" }}>
                        {g.ref.title}
                      </p>
                    )}
                    <div style={{ marginTop: 10 }}>
                      <Facts>
                        {[
                          ...g.facts,
                          plural(g.runs, "run"),
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
                      </Facts>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 18 }}>
                    {d.previous && (
                      <Link href={href.group(view.by, d.previous, view)}>← {d.previous}</Link>
                    )}
                    {d.next && <Link href={href.group(view.by, d.next, view)}>{d.next} →</Link>}
                  </div>
                </div>
                <div style={{ marginTop: 26 }}>
                  <Strip
                    label={g.ref?.commit ? "At the tagged commit" : "Latest run"}
                    items={strip}
                  />
                </div>
                <Split>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
                      gap: 16,
                    }}
                  >
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
                    <Card
                      head="Most common errors"
                      meta={plural(d.errors.length, "distinct error")}
                    >
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
                  </div>
                </Split>
                <Section
                  eyebrow={
                    g.baselineLabel && view.by === "release"
                      ? `Runs since ${g.baselineLabel}`
                      : "Runs"
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
          }}
        </Loaded>
      </Page>
    </>
  );
}

// ---------------------------------------------------------------------------
// Collections

const yamlOf = (c: { name: string; description: string; query: string; groupBy: GroupBy }) =>
  [
    "# .verdict/collections.yaml",
    "collections:",
    `  - name: ${JSON.stringify(c.name || "…")}`,
    ...(c.description ? [`    description: ${JSON.stringify(c.description)}`] : []),
    `    include: ${JSON.stringify(c.query || "*")}`,
    `    group_by: ${c.groupBy}`,
  ].join("\n");

export function CollectionsPage() {
  const result = useAtomValue(collectionsAtom);
  const [create, runCreate] = useAtom(createCollectionFn);
  const remove = useAtomSet(deleteCollectionFn);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("release");
  const saving = AsyncResult.isWaiting(create);
  const submit = () => {
    if (!name.trim()) return;
    runCreate({ name: name.trim(), description: description.trim(), query: query.trim(), groupBy });
    setName("");
    setDescription("");
    setQuery("");
  };
  const columns: Column<Collection>[] = [
    {
      key: "name",
      head: "Collection",
      wrap: true,
      cell: (c) => (
        <Name sub={c.description || undefined}>
          <Link ink href={href.home({ by: c.groupBy, q: c.query, collection: c.id })}>
            {c.name}
          </Link>
        </Name>
      ),
    },
    { key: "by", head: "Group by", dim: true, cell: (c) => GROUP_BY_INFO[c.groupBy].one },
    {
      key: "q",
      head: "Include runs where",
      cell: (c) =>
        c.query ? (
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
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
    {
      key: "x",
      head: "",
      right: true,
      cell: (c) => (
        <Cmd small onClick={() => remove(c.id)}>
          delete
        </Cmd>
      ),
    },
  ];
  return (
    <>
      <Topbar
        wordmark="Verdict"
        href={href.home()}
        crumbs={[{ label: "Collections" }]}
        actions={<SignOut />}
      />
      <Page>
        <div style={{ paddingTop: "2.5rem", maxWidth: "48rem" }}>
          <HeadRow title="Custom groupings" />
          <h1
            style={{
              fontWeight: 300,
              fontSize: "clamp(2rem, 4vw, 2.75rem)",
              lineHeight: 1.05,
              marginTop: 6,
            }}
          >
            Collections
          </h1>
          <p style={{ marginTop: 8 }}>
            <K>
              A collection is a saved filter and a group by, with a name. It shows in the rail and
              opens as a home page of its own.
            </K>
          </p>
        </div>
        <Section
          eyebrow="Saved"
          first
          count={
            AsyncResult.isSuccess(result) ? plural(result.value.length, "collection") : undefined
          }
        >
          <Loaded result={result}>
            {(list) =>
              list.length === 0 ? (
                <Empty>No collections yet. Make one below.</Empty>
              ) : (
                <Table middle columns={columns} rows={list} rowKey={(c) => c.id} />
              )
            }
          </Loaded>
        </Section>
        <Section eyebrow="New collection">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
              gap: 24,
            }}
          >
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
                  placeholder="repo:acme/widgets tag:smoke -env:staging"
                />
              </Field>
              <Field label="Group by">
                <Select
                  label="Group by"
                  placeholder="release"
                  value={groupBy}
                  onChange={(v) => setGroupBy(isGroupBy(v) ? v : "release")}
                  options={GROUP_BYS.map((g) => ({ value: g, label: GROUP_BY_INFO[g].one }))}
                />
              </Field>
              <div>
                <Cmd primary onClick={submit} disabled={saving || !name.trim()}>
                  {saving ? "saving…" : "create collection"}
                </Cmd>
              </div>
            </Stack>
            <Card head="YAML equivalent" meta="commit it next to the code">
              <pre
                style={{
                  fontFamily: '"Fragment Mono", ui-monospace, monospace',
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: "#e0def4",
                  whiteSpace: "pre-wrap",
                  margin: 0,
                }}
              >
                {yamlOf({ name, description, query, groupBy })}
              </pre>
              <p style={{ marginTop: 12 }}>
                <K>Tags come from CI: verdict upload --tag smoke --tag env=staging</K>
              </p>
            </Card>
          </div>
        </Section>
      </Page>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <K>{label}</K>
      {children}
    </label>
  );
}

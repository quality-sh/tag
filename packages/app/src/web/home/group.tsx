// One group's page: the group's figures, its failing tests and common errors, and
// the runs and flaky tests behind it.
import { useAtomValue } from "@effect/atom-react/Hooks";
import {
  Bad,
  Card,
  Delta,
  Empty,
  Head,
  Ink,
  K,
  Link,
  Name,
  Page,
  Plot,
  Section,
  Space,
  Split,
  Stack,
  Strip,
  Table,
  Topbar,
  fmtDay,
  fmtMs,
  fmtWhen,
  plural,
  type Column,
  type StripItem,
} from "@quality-sh/tag-ui";
import { GROUP_BY_INFO, type RunSummary } from "../../grouping.ts";
import type { GroupDetail } from "../client.ts";
import { Loaded, SignOut, cap } from "../common.tsx";
import { groupAtom, href, viewKey, type View } from "../state.ts";
import { Dim, Good, Verdict, pct } from "./bits.tsx";
import { scopeOfView, scopeCrumbs } from "./view.tsx";

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

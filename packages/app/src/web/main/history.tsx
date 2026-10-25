// The test history page: one test's results across runs, its metrics, and where each
// run sits.
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtomValue } from "@effect/atom-react/Hooks";
import {
  Accent,
  Bad,
  Bars,
  Big,
  Head,
  Ink,
  Lead,
  Link,
  Mark,
  Page,
  Plot,
  Section,
  Split,
  Stats,
  Sub,
  Table,
  Topbar,
  basename,
  fmtDay,
  fmtMs,
  fmtPct,
  fmtStamp,
  toneOf,
} from "@quality-sh/tag-ui";
import { Loaded, SignOut } from "../common.tsx";
import { historyAtom, historyKey, href } from "../state.ts";

export function TestHistoryPage({
  owner,
  repo,
  testId,
}: {
  owner: string;
  repo: string;
  testId: string;
}) {
  const result = useAtomValue(historyAtom(historyKey(owner, repo, testId)));
  const latest = AsyncResult.isSuccess(result) ? result.value[0] : undefined;
  return (
    <>
      <Topbar
        wordmark="TAG"
        crumbs={[
          { label: "Overview", href: href.overview() },
          { label: `${owner}/${repo}` },
          { label: latest?.name ?? "test" },
        ]}
        actions={<SignOut />}
      />
      <Page>
        <Loaded result={result}>
          {(history) => {
            const rows = [...history].reverse(); // oldest first for the plot
            const last = rows[rows.length - 1];
            const metricNames = [...new Set(rows.flatMap((r) => r.metrics.map((m) => m.name)))];
            const passes = rows.filter((r) => r.status === "passed").length;
            const meanMs = rows.length ? rows.reduce((s, r) => s + r.duration, 0) / rows.length : 0;
            return (
              <>
                <Head
                  eyebrow={
                    <>
                      Test · <Accent>{last?.tool ?? ""}</Accent>
                    </>
                  }
                  title={last?.name ?? testId}
                  question={last?.suite ?? undefined}
                  facts={[
                    last?.filePath ? basename(last.filePath) : null,
                    `${owner}/${repo}`,
                    <Ink>{testId}</Ink>,
                  ]}
                />
                <Lead
                  aside={
                    <>
                      {metricNames.map((n) => (
                        <Plot
                          key={n}
                          title={n}
                          note="per run · filled dot = below threshold"
                          max={1}
                          points={rows.map((r) => {
                            const m = r.metrics.find((x) => x.name === n);
                            return {
                              y: m?.value ?? null,
                              label: fmtDay(r.timestamp),
                              failed: m?.passed === 0,
                            };
                          })}
                        />
                      ))}
                      {metricNames.length === 0 && (
                        <Plot
                          title="Duration"
                          note="per run"
                          tone="ran"
                          format={(v) => fmtMs(v)}
                          points={rows.map((r) => ({
                            y: r.duration,
                            label: fmtDay(r.timestamp),
                            failed: r.status === "failed",
                          }))}
                        />
                      )}
                    </>
                  }
                >
                  <Big
                    tone={passes === rows.length ? "metric" : "failed"}
                    title="Pass rate over the recorded runs"
                  >
                    {fmtPct(passes, rows.length)}
                  </Big>
                  <Stats
                    items={[
                      { label: "runs", value: rows.length },
                      {
                        label: "last result",
                        value: <Mark tone={toneOf(last?.status ?? "other", last?.flaky)} />,
                      },
                      { label: "mean duration", value: fmtMs(meanMs) },
                    ]}
                  />
                  <Split>
                    <Bars
                      gapped
                      segments={[
                        { tone: "passed", value: passes, label: "passed" },
                        {
                          tone: "failed",
                          value: rows.filter((r) => r.status === "failed").length,
                          label: "failed",
                        },
                        {
                          tone: "skipped",
                          value: rows.filter((r) => r.status === "skipped").length,
                          label: "skipped",
                        },
                      ]}
                    />
                  </Split>
                </Lead>
                <Section eyebrow="History" count={rows.length}>
                  <Table
                    rows={[...rows].reverse()}
                    rowKey={(r) => r.reportId}
                    columns={[
                      {
                        key: "when",
                        head: "When",
                        cell: (r) => <span title={r.timestamp}>{fmtStamp(r.timestamp)}</span>,
                      },
                      {
                        key: "run",
                        head: "Run",
                        cell: (r) => <Link href={href.report(r.reportId)}>{r.runId}</Link>,
                      },
                      { key: "branch", head: "Branch", dim: true, cell: (r) => r.branch },
                      {
                        key: "status",
                        head: "Status",
                        cell: (r) => (
                          <>
                            <Mark tone={toneOf(r.status, r.flaky)} />
                            {r.message && <Sub tone="bad">{r.message.split("\n")[0]}</Sub>}
                          </>
                        ),
                      },
                      ...metricNames.map((n) => ({
                        key: n,
                        head: n,
                        right: true,
                        cell: (r: (typeof rows)[number]) => {
                          const m = r.metrics.find((x) => x.name === n);
                          const v = m?.value?.toFixed(2) ?? "—";
                          return m?.passed === 0 ? <Bad>{v}</Bad> : v;
                        },
                      })),
                      {
                        key: "duration",
                        head: "Duration",
                        right: true,
                        cell: (r) => fmtMs(r.duration),
                      },
                    ]}
                  />
                </Section>
              </>
            );
          }}
        </Loaded>
      </Page>
    </>
  );
}

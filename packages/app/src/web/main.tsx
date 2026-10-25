import "@quality-sh/tag-ui/global.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Cause, Option } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { RegistryContext, scheduleTask } from "@effect/atom-react/RegistryContext";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Accent,
  Bad,
  Bars,
  Big,
  Card,
  Cmd,
  Disclosure,
  Empty,
  Facts,
  FigureCell,
  FigureGrid,
  Figures,
  Frame,
  Head,
  Ink,
  Inline,
  K,
  Lead,
  Link,
  LoginShell,
  Mark,
  Message,
  Page,
  PillInput,
  Plot,
  Row,
  Rows,
  Section,
  Space,
  Split,
  Stats,
  Sub,
  Table,
  Topbar,
  Trace,
  Warn,
  basename,
  fmtBytes,
  fmtDay,
  fmtMs,
  fmtPct,
  fmtStamp,
  fmtWhen,
  plural,
  short,
  toneOf,
} from "@quality-sh/tag-ui";
import { type ArtifactRow, type ReportDetail, type RunRow } from "./client.ts";
import { DeepEval } from "./deepeval.tsx";
import { Loaded, SignOut, segmentsOf } from "./common.tsx";
import { CollectionsPage, GroupPage, ViewPage } from "./home.tsx";
import { OverviewPage } from "./overview.tsx";
import { ScopePage } from "./scope.tsx";
import {
  embedAtom,
  historyAtom,
  historyKey,
  href,
  loginFn,
  openArtifactFn,
  parseRoute,
  scopePath,
  reportAtom,
  routeAtom,
  sessionAtom,
} from "./state.ts";

// ---------------------------------------------------------------------------
// Report

function ReportPage({ reportId }: { reportId: string }) {
  const result = useAtomValue(reportAtom(reportId));
  const run = AsyncResult.isSuccess(result) ? result.value.run : undefined;
  return (
    <>
      <Topbar
        wordmark="TAG"
        crumbs={[
          { label: "Overview", href: href.overview() },
          { label: run ? `${run.owner}/${run.repo}` : "…" },
          { label: run?.runId ?? "…" },
          { label: run?.tool ?? "report" },
        ]}
        actions={<SignOut />}
      />
      <Page>
        <Loaded result={result}>{(d) => <ReportBody d={d} reportId={reportId} />}</Loaded>
      </Page>
    </>
  );
}

function ReportBody({ d, reportId }: { d: ReportDetail; reportId: string }) {
  const { run } = d;
  const failing = run.failed > 0;
  const isDeepEval = run.tool.includes("deepeval");
  const failures = d.tests.filter((t) => t.status === "failed");
  const ctrfByTestId = new Map((d.report?.results.tests ?? []).map((t) => [t.testId ?? "", t]));
  return (
    <>
      <Head
        eyebrow={
          <>
            Report · <Accent>{run.tool}</Accent>
            {run.toolVersion ? ` ${run.toolVersion}` : ""}
          </>
        }
        title={run.runId}
        question={`${run.passed} of ${run.tests} tests passed on ${run.branch ?? "an unknown branch"} at ${short(run.commit) || "an unknown commit"}, ${fmtStamp(run.timestamp)}.`}
        facts={[
          `${run.owner}/${run.repo}`,
          run.branch,
          short(run.commit) || null,
          fmtMs(run.duration),
          run.buildUrl ? (
            <Link external href={run.buildUrl}>
              workflow ↗
            </Link>
          ) : null,
          `ingested ${fmtWhen(run.ingestedAt)}`,
          `${run.adapter} adapter`,
        ]}
      />

      <Lead
        aside={
          <>
            {d.siblings.length > 0 && (
              <Card pad={false} head="Also in this run" meta={plural(d.siblings.length, "report")}>
                <Space top={12}>
                  <Figures
                    items={d.siblings.map((s) => ({
                      key: s.reportId,
                      label: <Link href={href.report(s.reportId)}>{s.tool} →</Link>,
                      value: fmtPct(s.passed, s.tests),
                      unit: `${s.passed}/${s.tests} passed`,
                      note: s.failed > 0 ? <Bad>{s.failed} failed</Bad> : fmtMs(s.duration),
                      tone: s.failed > 0 ? "failed" : "metric",
                    }))}
                  />
                </Space>
              </Card>
            )}
            <Artifacts artifacts={d.artifacts} refs={d.artifactRefs} run={run} />
          </>
        }
      >
        <Big
          tone={failing ? "failed" : "metric"}
          title={failing ? "Pass rate, with failures" : "Pass rate"}
        >
          {fmtPct(run.passed, run.tests)}
        </Big>
        <Stats
          items={[
            { label: "passed", value: run.passed, tone: "passed" },
            { label: "failed", value: run.failed, tone: run.failed ? "failed" : undefined },
            { label: "skipped", value: run.skipped },
            ...(run.flaky ? [{ label: "flaky", value: run.flaky, tone: "flaky" as const }] : []),
            { label: "tests", value: run.tests },
          ]}
        />
        <Split>
          <Bars segments={segmentsOf(run)} />
        </Split>
      </Lead>

      <EmbeddedArtifact />

      {failures.length > 0 && !isDeepEval && (
        <Section eyebrow="Failures" count={failures.length}>
          <Rows>
            {failures.map((t) => {
              const full = ctrfByTestId.get(t.testId);
              return (
                <Row
                  key={t.testId + t.name}
                  title={
                    <Link ink href={href.test(run.owner, run.repo, t.testId)}>
                      {t.name}
                    </Link>
                  }
                  facts={
                    <Facts>
                      {[
                        t.suite,
                        t.filePath ? basename(t.filePath) : null,
                        t.retries > 0 ? <Warn>{plural(t.retries, "retry", "retries")}</Warn> : null,
                        fmtMs(t.duration),
                      ]}
                    </Facts>
                  }
                >
                  {t.message && <Message>{t.message}</Message>}
                  {full?.snippet && <Trace>{full.snippet}</Trace>}
                  {full?.trace && (
                    <Space top={10}>
                      <Disclosure summary="stack trace">
                        <Trace>{full.trace}</Trace>
                      </Disclosure>
                    </Space>
                  )}
                </Row>
              );
            })}
          </Rows>
        </Section>
      )}

      {isDeepEval && <DeepEval d={d} />}

      <Section eyebrow="All tests" count={d.tests.length}>
        <Table
          rows={d.tests}
          rowKey={(t) => t.testId + t.name}
          columns={[
            {
              key: "name",
              head: "Test",
              cell: (t) => (
                <>
                  <Link href={href.test(run.owner, run.repo, t.testId)}>{t.name}</Link>
                  {t.filePath && <Sub>{basename(t.filePath)}</Sub>}
                </>
              ),
            },
            { key: "suite", head: "Suite", dim: true, cell: (t) => t.suite },
            {
              key: "status",
              head: "Status",
              cell: (t) => <Mark tone={toneOf(t.status, t.flaky)} />,
            },
            { key: "duration", head: "Duration", right: true, cell: (t) => fmtMs(t.duration) },
          ]}
        />
      </Section>
      <Space top={32}>
        <K block tone="dim">
          report {reportId}
        </K>
      </Space>
    </>
  );
}

// ---------------------------------------------------------------------------
// Artifacts

function Artifacts({
  artifacts,
  refs,
  run,
}: {
  artifacts: ReadonlyArray<ArtifactRow>;
  refs: ReportDetail["artifactRefs"];
  run: RunRow;
}) {
  const [opening, open] = useAtom(openArtifactFn);
  const setEmbed = useAtomSet(embedAtom);
  const own = artifacts.find((a) => a.artifactId === run.artifactId);
  const htmlRef = refs.find((r) => r.kind === "playwright-html");
  const autoOpen =
    own && htmlRef && own.state !== "expired"
      ? { artifactId: own.artifactId, path: htmlRef.path, title: htmlRef.name }
      : undefined;

  // A Playwright report opens by itself when the report changes; everything else waits for a click.
  useEffect(() => {
    setEmbed(Option.none());
    if (autoOpen) open({ ...autoOpen, inline: true });
  }, [run.reportId, autoOpen?.artifactId, autoOpen?.path]);

  if (artifacts.length === 0) return null;
  return (
    <Card pad={false} head="Original artifacts" meta={plural(artifacts.length, "artifact")}>
      <Space top={12}>
        <FigureGrid single>
          {artifacts.map((a) => {
            const isOwn = a.artifactId === run.artifactId;
            const links =
              isOwn && refs.length ? refs : [{ kind: "file", name: "index", path: "index.html" }];
            return (
              <FigureCell key={a.artifactId}>
                <K block>
                  <Ink>{a.name}</Ink> · {fmtBytes(a.sizeBytes)} · {a.state}
                  {a.expiresAt && ` · source expires ${fmtDay(a.expiresAt)}`}
                </K>
                <Space top={8}>
                  <Inline>
                    {a.state === "expired" ? (
                      <K tone="warn">expired at the source</K>
                    ) : (
                      links.map((l) => (
                        <Inline key={l.path}>
                          {(l.kind === "playwright-html" || l.kind === "file") && (
                            <Cmd
                              small
                              disabled={AsyncResult.isWaiting(opening)}
                              onClick={() =>
                                open({
                                  artifactId: a.artifactId,
                                  path: l.path,
                                  title: l.name,
                                  inline: true,
                                })
                              }
                            >
                              view {l.kind === "playwright-html" ? "report" : basename(l.path)}
                            </Cmd>
                          )}
                          <Cmd
                            small
                            onClick={() =>
                              open({
                                artifactId: a.artifactId,
                                path: l.path,
                                title: l.name,
                                inline: false,
                              })
                            }
                          >
                            {basename(l.path)} ↗
                          </Cmd>
                        </Inline>
                      ))
                    )}
                  </Inline>
                </Space>
              </FigureCell>
            );
          })}
        </FigureGrid>
      </Space>
    </Card>
  );
}

function EmbeddedArtifact() {
  const embed = useAtomValue(embedAtom);
  return Option.match(embed, {
    onNone: () => null,
    onSome: (e) => (
      <Section eyebrow="Original report">
        <Frame title={e.title} src={e.url} meta="served from TAG's artifact origin, sandboxed" />
      </Section>
    ),
  });
}

// ---------------------------------------------------------------------------
// Test history

function TestHistoryPage({ owner, repo, testId }: { owner: string; repo: string; testId: string }) {
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

// ---------------------------------------------------------------------------
// Login and the shell

function LoginPage() {
  const [pw, setPw] = useState("");
  const [login, runLogin] = useAtom(loginFn);
  const rejected = AsyncResult.isSuccess(login) && login.value === false;
  return (
    <>
      <Topbar wordmark="TAG" />
      <LoginShell
        eyebrow="Test results from CI, in one place"
        title="Sign in to TAG."
        lede="Enter the shared viewer password."
        onSubmit={() => runLogin(pw)}
        error={rejected ? "That password was not accepted." : undefined}
      >
        <PillInput
          type="password"
          value={pw}
          onChange={setPw}
          placeholder="viewer password"
          label="Viewer password"
          autoFocus
        />
        <Cmd type="submit" primary disabled={AsyncResult.isWaiting(login)}>
          sign in
        </Cmd>
      </LoginShell>
    </>
  );
}

function RouteSync() {
  const setRoute = useAtomSet(routeAtom);
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(location.hash));
      scrollTo(0, 0);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, [setRoute]);
  return null;
}

function App() {
  const route = useAtomValue(routeAtom);
  const session = useAtomValue(sessionAtom);
  if (!AsyncResult.isSuccess(session))
    return AsyncResult.isFailure(session) ? (
      <Empty>TAG is not reachable: {String(Cause.squash(session.cause))}</Empty>
    ) : null;
  const authed = session.value.authenticated || !session.value.authRequired;
  if (!authed) return <LoginPage />;
  switch (route.page) {
    case "report":
      return <ReportPage key={route.reportId} reportId={route.reportId} />;
    case "test":
      return <TestHistoryPage key={route.testId} {...route} />;
    case "collections":
      return <CollectionsPage />;
    case "group":
      return <GroupPage key={`${route.by}/${route.key}`} view={route} groupKey={route.key} />;
    case "view":
      return <ViewPage view={route} />;
    case "scope":
      return (
        <ScopePage
          key={scopePath(route.scope)}
          scope={route.scope}
          q={route.q}
          range={route.range}
        />
      );
    default:
      return <OverviewPage range={route.range} />;
  }
}

const registry = AtomRegistry.make({ scheduleTask });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryContext.Provider value={registry}>
      <RouteSync />
      <App />
    </RegistryContext.Provider>
  </StrictMode>,
);

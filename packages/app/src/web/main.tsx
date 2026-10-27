// The web app shell: the hash router, the page switch, and the React root with its
// atom registry. Each page lives in the module in main/ beside this entry.
import "@quality-sh/tag-ui/global.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Cause } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { RegistryContext, scheduleTask } from "@effect/atom-react/RegistryContext";
import { useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import { Empty } from "@quality-sh/tag-ui";
import { LoginPage } from "./main/login.tsx";
import { ReportPage } from "./main/report.tsx";
import { TestHistoryPage } from "./main/history.tsx";
import { CollectionsPage, GroupPage, ViewPage } from "./home.tsx";
import type { Session } from "./client.ts";
import { OnboardingPage } from "./onboarding.tsx";
import { needsOnboarding } from "./onboarding-steps.ts";
import { OverviewPage } from "./overview.tsx";
import { ScopePage } from "./scope.tsx";
import { href, parseRoute, reposAtom, routeAtom, scopePath, sessionAtom } from "./state.ts";

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

/**
 * On first load at the overview, send a new user to onboarding: no App installed, or no
 * report yet. Deep links stay where they point.
 */
function FirstLoad({ session, onDone }: { session: Session; onDone: () => void }) {
  const repos = useAtomValue(reposAtom);
  useEffect(() => {
    if (AsyncResult.isInitial(repos)) return;
    if (AsyncResult.isSuccess(repos) && needsOnboarding(session, repos.value))
      location.hash = href.onboarding();
    onDone();
  }, [repos, session, onDone]);
  return null;
}

function App() {
  const route = useAtomValue(routeAtom);
  const session = useAtomValue(sessionAtom);
  const [deciding, setDeciding] = useState(route.page === "overview");
  if (!AsyncResult.isSuccess(session))
    return AsyncResult.isFailure(session) ? (
      <Empty>TAG is not reachable: {String(Cause.squash(session.cause))}</Empty>
    ) : null;
  const authed = session.value.authenticated || !session.value.authRequired;
  if (!authed) return <LoginPage session={session.value} />;
  if (deciding) return <FirstLoad session={session.value} onDone={() => setDeciding(false)} />;
  switch (route.page) {
    case "onboarding":
      return <OnboardingPage />;
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

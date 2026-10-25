// The web app shell: the hash router, the page switch, and the React root with its
// atom registry. Each page lives in the module in main/ beside this entry.
import "@quality-sh/tag-ui/global.css";
import { StrictMode, useEffect } from "react";
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
import { OverviewPage } from "./overview.tsx";
import { ScopePage } from "./scope.tsx";
import { parseRoute, routeAtom, scopePath, sessionAtom } from "./state.ts";

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

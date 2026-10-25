// Rebuild: drop the index and re-ingest every report from the artifact store.
import type { Database } from "bun:sqlite";
import { Effect, Option } from "effect";
import { validateReport, withIdentity, type CtrfReport } from "@quality-sh/tag-schema";
import type { Interface, ReportOrigin } from "./result-store-rows.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { trySync } from "./result-store-db.ts";

export const makeRebuild = (
  db: Database,
  store: ArtifactStore.Interface,
  indexReport: (report: CtrfReport, origin: ReportOrigin) => boolean,
): Pick<Interface, "rebuild"> => {
  const rebuild = Effect.fn("ResultStore.rebuild")(function* () {
    yield* trySync("rebuild.clear", () => {
      db.run("DELETE FROM metrics");
      db.run("DELETE FROM tests");
      db.run("DELETE FROM report_tags");
      db.run("DELETE FROM reports");
    });
    const keys = yield* store.list("reports/");
    let count = 0;
    for (const key of keys) {
      if (!key.endsWith(".ctrf.json")) continue;
      const [, owner, repo] = key.split("/");
      const blob = yield* store.get(key);
      if (Option.isNone(blob) || !owner || !repo) continue;
      const v = validateReport(JSON.parse(new TextDecoder().decode(blob.value.bytes)));
      if (!v.ok) {
        yield* Effect.logWarning(`rebuild: skipping invalid report ${key}`);
        continue;
      }
      const inserted = yield* trySync("rebuild.index", () =>
        indexReport(withIdentity(v.report), { owner, repo, adapter: "rebuild" }),
      );
      if (inserted) count++;
    }
    return { reports: count };
  });
  return { rebuild };
};

import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { Ingest } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { testLayer } from "./helpers.ts";

describe("ingest pipeline (fixtures -> fs store -> sqlite)", () => {
  test("ingests every fixture artifact, idempotently, and serves queries", async () => {
    const { layer } = await testLayer();
    const program = Effect.gen(function* () {
      const ingest = yield* Ingest.Service;
      const results = yield* ResultStore.Service;
      const store = yield* ArtifactStore.Service;

      const first = yield* ingest.ingestAll();
      expect(first.errors).toEqual([]);
      expect(first.runs).toBe(3);
      expect(first.refs).toBe(4);
      expect(first.artifacts).toBe(7);
      expect(first.cached).toBe(7);
      // 3 adapters x 2 runs + junit on the pull request run
      expect(first.reports).toBe(7);
      expect(first.inserted).toBe(7);

      const second = yield* ingest.ingestAll();
      expect(second.inserted).toBe(0);
      expect(second.cached).toBe(0);

      const runs = yield* results.listRuns({ owner: "acme", repo: "widgets" });
      expect(runs).toHaveLength(7);
      expect(new Set(runs.map((r) => r.tool))).toEqual(
        new Set(["deepeval", "pytest", "playwright"]),
      );
      const latestPw = runs.find((r) => r.tool === "playwright" && r.runId === "run-1002")!;
      expect(latestPw).toMatchObject({
        passed: 5,
        failed: 0,
        skipped: 1,
        branch: "main",
        artifactName: "playwright-report",
      });

      const report = yield* results.getReport(latestPw.reportId);
      expect(Option.isSome(report)).toBe(true);
      const tests = yield* results.testsOf(latestPw.reportId);
      expect(tests).toHaveLength(6);

      const de = runs.find((r) => r.tool === "deepeval" && r.runId === "run-1002")!;
      const metrics = yield* results.metricsOf(de.reportId);
      expect(metrics.length).toBe(18);
      const failing = (yield* results.testsOf(de.reportId)).find((t) => t.status === "failed")!;
      const history = yield* results.testHistory("acme", "widgets", failing.testId, 10);
      expect(history).toHaveLength(2);
      expect(history[0]!.metrics.map((m) => m.name).sort()).toEqual([
        "Answer Relevancy",
        "Faithfulness",
        "Hallucination",
      ]);

      // Artifact files landed in the store, including the Playwright HTML report.
      const keys = yield* store.list("artifacts/acme/widgets/run-1002__playwright-report/");
      expect(keys).toContain("artifacts/acme/widgets/run-1002__playwright-report/index.html");
      const art = yield* results.getArtifact("run-1002__playwright-report");
      expect(Option.isSome(art) && art.value.state).toBe("cached");

      // Index is rebuildable from the bucket alone.
      const rebuilt = yield* results.rebuild();
      expect(rebuilt.reports).toBe(7);
      expect((yield* results.repos())[0]).toMatchObject({
        owner: "acme",
        repo: "widgets",
        reports: 7,
      });
    });
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  }, 30_000);
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { buildZip, extractZip, isSafeEntryPath } from "../src/server/zip.ts";
import { FIXTURES, localS3, run, tmpDir } from "./helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const storeContract = (name: string, make: () => Promise<ArtifactStore.Interface>) =>
  describe(`${name} store`, () => {
    test("put, has, get, list, remove", async () => {
      const store = await make();
      const ns = `test/${Date.now()}-${Math.random().toString(36).slice(2)}/`;
      await run(store.put(`${ns}a/one.txt`, enc("one"), "text/plain"));
      await run(store.put(`${ns}a/two.json`, enc("{}"), "application/json"));
      await run(store.put(`${ns}b.html`, enc("<p>hi</p>"), "text/html"));
      expect(await run(store.has(`${ns}a/one.txt`))).toBe(true);
      expect(await run(store.has(`${ns}missing`))).toBe(false);
      const got = await run(store.get(`${ns}b.html`));
      expect(Option.isSome(got)).toBe(true);
      if (Option.isSome(got)) {
        expect(dec(got.value.bytes)).toBe("<p>hi</p>");
        expect(got.value.contentType).toContain("text/html");
      }
      expect(await run(store.list(`${ns}a/`))).toEqual([`${ns}a/one.txt`, `${ns}a/two.json`]);
      expect((await run(store.list(ns))).length).toBe(3);
      await run(store.remove(`${ns}b.html`));
      expect(await run(store.has(`${ns}b.html`))).toBe(false);
      expect(Option.isNone(await run(store.get(`${ns}b.html`)))).toBe(true);
    });
    test("rejects unsafe keys", async () => {
      const store = await make();
      const r = await Effect.runPromise(
        Effect.result(store.put("../escape", enc("x"), "text/plain")),
      );
      expect(r._tag).toBe("Failure");
    });
  });

storeContract("fs", async () => ArtifactStore.makeFs(join(await tmpDir(), "store")));

const s3 = await localS3();
if (s3) storeContract("s3 (rustfs)", async () => ArtifactStore.makeS3(s3));
else test.skip("s3 store (rustfs not reachable on :9000)", () => {});

describe("zip", () => {
  test("round trips and preserves paths", () => {
    const zip = buildZip([
      { path: "index.html", bytes: enc("<html/>") },
      { path: "data/a.png", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const out = extractZip(zip);
    expect(out.map((e) => e.path).sort()).toEqual(["data/a.png", "index.html"]);
    expect(dec(out.find((e) => e.path === "index.html")!.bytes)).toBe("<html/>");
  });
  test("blocks zip-slip paths", () => {
    expect(isSafeEntryPath("../etc/passwd")).toBe(false);
    expect(isSafeEntryPath("/abs")).toBe(false);
    expect(isSafeEntryPath("ok/../../x")).toBe(false);
    expect(isSafeEntryPath("C:/x")).toBe(false);
    expect(isSafeEntryPath("a\\b")).toBe(false);
    expect(isSafeEntryPath("fine/path.txt")).toBe(true);
    const zip = buildZip([{ path: "../evil.txt", bytes: enc("x") }]);
    expect(() => extractZip(zip)).toThrow();
  });
  test("rejects garbage", () => {
    expect(() => extractZip(enc("not a zip"))).toThrow();
  });
});

describe("fixture source", () => {
  const src = ArtifactSource.makeFixtures(FIXTURES);
  test("lists repos, runs and artifacts", async () => {
    expect(await run(src.repos())).toEqual([{ owner: "acme", repo: "widgets" }]);
    const runs = await run(src.listRuns({ owner: "acme", repo: "widgets" }, { limit: 10 }));
    expect(runs.map((r) => r.runId)).toEqual(["run-1003", "run-1002", "run-1001"]);
    expect(runs[0]?.branch).toBe("feat/checkout-retry");
    expect(runs[1]?.branch).toBe("main");
    expect(runs[1]?.environment).toBe("production");
    expect(runs[1]?.tags).toEqual(["smoke", "nightly"]);
    const refs = await run(src.listRefs({ owner: "acme", repo: "widgets" }));
    expect(refs.map((r) => `${r.kind}:${r.key}`)).toEqual([
      "release:v2.3.0",
      "release:v2.4.0",
      "pull_request:#42",
      "deployment:production",
    ]);
    const arts = await run(src.listArtifacts(runs[1]!));
    expect(arts.map((a) => a.name)).toEqual([
      "deepeval-results",
      "junit-results",
      "playwright-report",
    ]);
    expect(arts.every((a) => a.sizeBytes > 0)).toBe(true);
  });
  test("opens an artifact as a zip", async () => {
    const arts = await run(
      src.listArtifacts({ owner: "acme", repo: "widgets", runId: "run-1001" }),
    );
    const zip = await run(src.openArtifact(arts.find((a) => a.name === "junit-results")!));
    const entries = extractZip(zip);
    expect(entries.map((e) => e.path)).toEqual(["results.xml"]);
  });
});

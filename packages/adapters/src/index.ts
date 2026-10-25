import {
  withArtifacts,
  withIdentity,
  artifactsOf,
  type CtrfReport,
  type TagArtifact,
} from "@quality-sh/tag-schema";
import { ctrfAdapter } from "./ctrf.ts";
import { deepevalAdapter } from "./deepeval.ts";
import { junitAdapter } from "./junit.ts";
import { playwrightAdapter, findPlaywrightHtmlIndex } from "./playwright.ts";
import type { Adapter, AdapterInput, FileRef } from "./types.ts";

export * from "./types.ts";
export { ctrfAdapter, deepevalAdapter, junitAdapter, playwrightAdapter };
export { convertDeepEval } from "./deepeval.ts";
export { convertJUnit } from "./junit.ts";
export { convertPlaywright } from "./playwright.ts";

/** Dispatch order. First-class CTRF first; the Playwright JSON fallback is skipped when CTRF was found. */
export const adapters: Adapter[] = [ctrfAdapter, playwrightAdapter, deepevalAdapter, junitAdapter];

export interface AdapterRun {
  adapter: string;
  reports: CtrfReport[];
}

/**
 * Run every adapter whose detect() matches. Fills identity and attaches
 * artifact references the adapter itself did not know about (e.g. the
 * Playwright HTML report next to a CTRF file).
 */
export async function runAdapters(
  input: AdapterInput,
  registry: Adapter[] = adapters,
): Promise<AdapterRun[]> {
  const files = input.files.map(memoText);
  const paths = files.map((f) => f.path);
  const out: AdapterRun[] = [];
  let hasCtrf = false;
  for (const adapter of registry) {
    if (adapter === playwrightAdapter && hasCtrf) continue;
    if (!adapter.detect(paths)) continue;
    const reports = await adapter.parse({ ...input, files });
    if (reports.length === 0) continue; // nothing of this format inside, by content
    if (adapter === ctrfAdapter) hasCtrf = true;
    out.push({
      adapter: adapter.name,
      reports: reports.map((r) => withIdentity(withArtifacts(r, sweepArtifacts(r, paths)))),
    });
  }
  return out;
}

/** Adapters sniff content, so several may read one file: read it once. */
function memoText(f: FileRef): FileRef {
  let text: Promise<string> | undefined;
  return { ...f, text: () => (text ??= f.text()) };
}

/** Artifact references that can be inferred from file names regardless of adapter. */
export function sweepArtifacts(report: CtrfReport, paths: string[]): TagArtifact[] {
  const have = new Set(artifactsOf(report).map((a) => a.path));
  const found: TagArtifact[] = [];
  const html = findPlaywrightHtmlIndex(paths);
  if (html && !have.has(html) && report.results.tool.name.toLowerCase().includes("playwright")) {
    found.push({
      kind: "playwright-html",
      name: "Playwright HTML report",
      path: html,
      contentType: "text/html",
    });
  }
  return found;
}

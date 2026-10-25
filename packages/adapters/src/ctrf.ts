// Identity adapter: the artifact already contains CTRF. Validate and fill in environment.
import { validateReport, type CtrfReport } from "@quality-sh/tag-schema";
import { environmentFrom, isJson, parseJson, type Adapter, type AdapterInput } from "./types.ts";

/** A CTRF report by shape: `results` with a tool, a summary and a list of tests. */
function looksLikeCtrf(o: unknown): boolean {
  if (!o || typeof o !== "object") return false;
  const r = (o as { results?: unknown }).results;
  return (
    !!r &&
    typeof r === "object" &&
    "tool" in r &&
    "summary" in r &&
    Array.isArray((r as { tests?: unknown }).tests)
  );
}

export const ctrfAdapter: Adapter = {
  name: "ctrf",
  version: "0.1.0",
  detect: (paths) => paths.some(isJson),
  async parse({ files, context }: AdapterInput): Promise<CtrfReport[]> {
    const out: CtrfReport[] = [];
    for (const f of files.filter((f) => isJson(f.path))) {
      const parsed = parseJson(await f.text());
      if (!looksLikeCtrf(parsed)) continue;
      const v = validateReport(parsed);
      if (!v.ok) throw new Error(`${f.path}: invalid CTRF: ${v.errors.slice(0, 5).join("; ")}`);
      const r = v.report;
      out.push({
        ...r,
        runId: r.runId ?? context.runId,
        // The run's time when CI gave one, so every report of a run agrees on when it ran.
        ...(context.timestamp ? { timestamp: context.timestamp } : {}),
        results: {
          ...r.results,
          environment: { ...environmentFrom(context), ...(r.results.environment ?? {}) },
        },
      });
    }
    return out;
  },
};

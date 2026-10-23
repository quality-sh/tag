// Identity adapter: the artifact already contains CTRF. Validate and fill in environment.
import { validateReport, type CtrfReport } from "@quality-sh/verdict-schema";
import { basename, environmentFrom, type Adapter, type AdapterInput } from "./types.ts";

const isCandidate = (p: string) => {
  const b = basename(p);
  return b.endsWith(".ctrf.json") || b === "ctrf-report.json" || b === "ctrf.json";
};

export const ctrfAdapter: Adapter = {
  name: "ctrf",
  version: "0.1.0",
  detect: (paths) => paths.some(isCandidate),
  async parse({ files, context }: AdapterInput): Promise<CtrfReport[]> {
    const out: CtrfReport[] = [];
    for (const f of files.filter((f) => isCandidate(f.path))) {
      const parsed: unknown = JSON.parse(await f.text());
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

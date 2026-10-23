// Stable identifiers. Computed by the ingester when the adapter does not set them.
import type { CtrfReport, CtrfTest } from "./ctrf.ts";

function sha1Hex(input: string): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(input);
  return h.digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

/** sha1(tool, filePath, suite path, name, parameters) truncated to 16 hex chars. */
export function testId(toolName: string, test: CtrfTest): string {
  if (test.testId) return test.testId;
  const parts = [
    toolName,
    test.filePath ?? "",
    (test.suite ?? []).join("/"),
    test.name,
    test.parameters ? canonical(test.parameters) : "",
  ];
  return sha1Hex(parts.join("\n")).slice(0, 16);
}

/** Format 32 hex chars as a UUID with version 5 and RFC 4122 variant bits, like UUID v5 (SHA-1 based). */
function hexToUuidV5(hex32: string): string {
  const h = hex32.slice(0, 32).split("");
  h[12] = "5";
  h[16] = ((parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Idempotency key for a report: reportId when present, else a deterministic UUID from (runId, tool, shardId, start). */
export function reportKey(report: CtrfReport): string {
  if (report.reportId) return report.reportId;
  const parts = [
    report.runId ?? "",
    report.results.tool.name,
    report.results.environment?.shardId ?? "",
    String(report.results.summary.start),
  ];
  return hexToUuidV5(sha1Hex(parts.join("\n")));
}

/** Return a copy of the report with every test carrying a testId and the report a reportId. */
export function withIdentity(report: CtrfReport): CtrfReport {
  const tool = report.results.tool.name;
  return {
    ...report,
    reportId: reportKey(report),
    results: {
      ...report.results,
      tests: report.results.tests.map((t) => ({ ...t, testId: testId(tool, t) })),
    },
  };
}

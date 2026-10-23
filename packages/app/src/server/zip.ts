// Zip extraction with a zip-slip guard and size caps. Artifacts are untrusted input.
import { unzipSync, zipSync } from "fflate";
import { Schema } from "effect";

export class ZipError extends Schema.TaggedError<ZipError>()("Zip.ZipError", {
  reason: Schema.String,
  entry: Schema.optionalKey(Schema.String),
}) {}

export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const MAX_ENTRIES = 50_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB uncompressed

/** Returns true when the path is safe to use as a store key suffix. */
export function isSafeEntryPath(p: string): boolean {
  if (p.length === 0 || p.length > 1024) return false;
  if (p.includes("\0") || p.includes("\\")) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  const parts = p.split("/");
  return parts.every((seg) => seg !== ".." && seg !== "." && seg.length > 0);
}

export function extractZip(bytes: Uint8Array): ZipEntry[] {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes);
  } catch (e) {
    throw new ZipError({ reason: `corrupt zip: ${e instanceof Error ? e.message : String(e)}` });
  }
  const out: ZipEntry[] = [];
  let total = 0;
  for (const [rawPath, data] of Object.entries(unzipped)) {
    if (rawPath.endsWith("/")) continue; // directory entry
    const path = rawPath.replace(/^\.\//, "");
    if (!isSafeEntryPath(path)) throw new ZipError({ reason: "unsafe entry path", entry: rawPath });
    total += data.byteLength;
    if (total > MAX_TOTAL_BYTES)
      throw new ZipError({ reason: "archive exceeds size cap", entry: rawPath });
    out.push({ path, bytes: data });
    if (out.length > MAX_ENTRIES) throw new ZipError({ reason: "archive exceeds entry cap" });
  }
  return out;
}

/** Build a zip from in-memory entries. Used by the fixture source and tests. */
export function buildZip(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const e of entries) input[e.path] = e.bytes;
  return zipSync(input, { level: 1 });
}

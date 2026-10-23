// Formatting helpers shared by every page. Numbers stay tabular, dates stay short.

export const fmtMs = (ms: number): string =>
  ms >= 60_000
    ? `${(ms / 60_000).toFixed(1)} min`
    : ms >= 1000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.round(ms)} ms`;

export const fmtBytes = (n: number): string =>
  n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "7 Oct" or "7 Oct 2025" when the year differs from today's. */
export const fmtDay = (iso: string | Date): string => {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const year = d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
};

/** "7 Oct 16:02" */
export const fmtStamp = (iso: string | Date): string => {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${fmtDay(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Relative when recent, a day otherwise. */
export const fmtWhen = (iso: string): string => {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const h = diff / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return fmtDay(d);
};

export const fmtPct = (n: number, d: number): string =>
  d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
export const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : "");
export const basename = (p: string): string => p.split("/").pop() ?? p;
export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

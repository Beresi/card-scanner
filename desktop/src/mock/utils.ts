/**
 * Mock data utilities — shared helpers for building fixture timestamps.
 * These run in the browser (Date is available) and produce stable-ish
 * relative timestamps anchored to the moment the module is first imported.
 */

// Anchor all timestamps to module-load time so "ago" labels look live but
// the relative ordering within a session stays stable.
const NOW = Date.now();

/**
 * Returns a SQLite-style UTC datetime string 'YYYY-MM-DD HH:MM:SS'
 * for the instant that was `minutes` minutes before module load.
 */
export function minutesAgo(minutes: number): string {
  return toSqlite(new Date(NOW - minutes * 60_000));
}

/**
 * Returns a SQLite-style UTC datetime string 'YYYY-MM-DD HH:MM:SS'
 * for the instant that was `hours` hours before module load.
 */
export function hoursAgo(hours: number): string {
  return minutesAgo(hours * 60);
}

/**
 * Returns a SQLite-style UTC datetime string 'YYYY-MM-DD HH:MM:SS'
 * for the instant that was `days` days before module load.
 */
export function daysAgo(days: number): string {
  return minutesAgo(days * 24 * 60);
}

/**
 * Format a Date to the SQLite UTC datetime format 'YYYY-MM-DD HH:MM:SS'.
 */
function toSqlite(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

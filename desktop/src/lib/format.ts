// Pure formatting utilities — no React, no side effects, no I/O.
// All money arrives as integer cents; the ONLY division by 100 is inside usd().

// ---------------------------------------------------------------------------
// usd — format integer cents to a locale currency string
// ---------------------------------------------------------------------------

/**
 * Format integer cents to a human-readable currency string.
 *
 * @param cents    Integer cents (the only place division by 100 occurs).
 * @param currency ISO 4217 currency code (e.g. 'USD', 'EUR'). Defaults to 'USD'.
 *
 * @example usd(1234)        → "$12.34"
 * @example usd(999, 'EUR')  → "€9.99"
 */
export function usd(cents: number, currency = 'USD'): string {
  // The ONLY place we divide by 100 in the entire client.
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Fallback for unknown/invalid currency codes: show raw decimals + code.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

// ---------------------------------------------------------------------------
// savings — cents saved vs. the baseline price
// ---------------------------------------------------------------------------

/**
 * Returns how many cents cheaper the deal is vs. the cohort baseline.
 * Derived at the display edge — never stored.
 *
 * @param baselineCents  The median cohort price in integer cents.
 * @param priceCents     The deal listing price in integer cents.
 */
export function savings(baselineCents: number, priceCents: number): number {
  return baselineCents - priceCents;
}

// ---------------------------------------------------------------------------
// ago — compact relative time string
// ---------------------------------------------------------------------------

/**
 * Compact relative time from an ISO/SQLite datetime string to now.
 * SQLite stores 'YYYY-MM-DD HH:MM:SS' as UTC; we append 'Z' if no timezone
 * indicator is present before parsing.
 *
 * @example ago('2024-01-01 10:00:00') → "5m" / "2h" / "3d"
 */
export function ago(iso: string): string {
  if (!iso || typeof iso !== 'string') return '';
  try {
    // Append 'Z' to bare SQLite datetimes so Date.parse treats them as UTC.
    const normalised = /Z|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
    const ms = Date.now() - new Date(normalised).getTime();
    if (isNaN(ms) || ms < 0) return '';

    const s = Math.floor(ms / 1_000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// flag — ISO 3166-1 alpha-2 country code → regional indicator emoji flag
// ---------------------------------------------------------------------------

/**
 * Convert a 2-letter ISO 3166-1 alpha-2 country code to a flag emoji.
 * Invalid codes or null return an empty string.
 *
 * Regional indicator symbols: U+1F1E6 (A) ... U+1F1FF (Z).
 * Pair them for a flag: 'US' → 🇺🇸
 *
 * @example flag('US') → '🇺🇸'
 * @example flag('DE') → '🇩🇪'
 * @example flag(null) → ''
 */
export function flag(countryCode: string | null): string {
  if (!countryCode || typeof countryCode !== 'string') return '';
  const upper = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return '';
  // Regional indicator base: 0x1F1E6 is the codepoint for 🇦 (regional indicator A)
  const BASE = 0x1f1e6;
  const a = BASE + (upper.charCodeAt(0) - 65);
  const b = BASE + (upper.charCodeAt(1) - 65);
  return String.fromCodePoint(a, b);
}

// ---------------------------------------------------------------------------
// pct — integer discount percentage → display string
// ---------------------------------------------------------------------------

/**
 * @example pct(50)  → "50%"
 * @example pct(33)  → "33%"
 */
export function pct(n: number): string {
  return `${Math.round(n)}%`;
}

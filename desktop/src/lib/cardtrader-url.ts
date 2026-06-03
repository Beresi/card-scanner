/**
 * cardtrader-url.ts — build a "View on CardTrader" URL for any WatchItem type.
 *
 * URL patterns used:
 *
 * blueprint (cardtrader_id != null):
 *   https://www.cardtrader.com/cards/{cardtrader_id}
 *   Same pattern as buildBuyUrl in worker/src/cardtrader/client.ts and used
 *   throughout the app for deal buy-links.  Confirmed working in prod.
 *
 * expansion:
 *   The expansion detail page uses a name-slug
 *   (/en/games/magic/expansions/{slug}/blueprints_search) that is NOT stored on
 *   WatchItem — only cardtrader_id (numeric) and label (human name) are available.
 *   There is no reliable way to derive the slug from those fields, so we fall back
 *   to a category-scoped card search filtered by the expansion label.  The search
 *   endpoint pattern /en/games/magic/categories/magic-single-card/blueprints_search?q=
 *   is live on cardtrader.com and returns results filtered by the query string.
 *   If a future refactor stores the expansion code/slug on WatchItem, replace this
 *   with: https://www.cardtrader.com/en/games/magic/expansions/{slug}/blueprints_search
 *
 * card (any printing):
 *   https://www.cardtrader.com/cards/{repr_blueprint_id}/versions
 *   A card-type watch has no blueprint id of its own (cardtrader_id is null), so
 *   the worker derives `repr_blueprint_id` — a representative printing's id — from
 *   the catalog at read time. The public `/cards/{id}/versions` page lists EVERY
 *   printing of that card, which is exactly the "any printing" semantics.  Bare
 *   ids redirect to the canonical slug URL (same as /cards/{id} buy-links).  Falls
 *   back to a name search only when repr_blueprint_id is null (set not yet synced).
 *
 *   NOTE: the old category search page
 *   (/en/games/magic/categories/magic-single-card/blueprints_search?q=) no longer
 *   renders results server-side and is treated as a last-resort fallback only.
 */

import type { WatchItem } from '../api/types';

const BASE = 'https://www.cardtrader.com';

// Combining diacritical marks (U+0300–U+036F), built from an escaped string so
// the source stays ASCII-only.
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * Slugify a name the way CardTrader's card URLs do: lowercase, accents stripped,
 * each run of non-alphanumerics → a single hyphen, no leading/trailing hyphen.
 * The trailing slug on `/cards/{id}-{slug}` is cosmetic — only the id is used
 * for lookup — so this just makes the link human-readable.
 *
 * "Ravenous Robots (Extended Art)" → "ravenous-robots-extended-art"
 */
function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `{id}` or, when a name is available, `{id}-{slug}` (cosmetic slug). */
function idWithSlug(id: number, name?: string | null): string {
  const slug = name ? slugify(name) : '';
  return slug ? `${id}-${slug}` : `${id}`;
}

/**
 * Search landing for Magic singles on CardTrader — the most robust public URL
 * that accepts a card/set name query without requiring a slug we don't have.
 */
function searchUrl(q: string): string {
  // /en/games/magic/categories/magic-single-card/blueprints_search is the live
  // CardTrader search page for Magic singles that accepts ?q= (confirmed June 2026).
  return `${BASE}/en/games/magic/categories/magic-single-card/blueprints_search?q=${encodeURIComponent(q)}`;
}

/**
 * Build the best available "View on CardTrader" URL for a watch-list item.
 *
 * Never returns an empty or broken URL — every branch has a safe fallback.
 */
export function buildWatchUrl(item: WatchItem): string {
  switch (item.type) {
    case 'blueprint':
      // Direct card page by blueprint ID — same as deal buy-links everywhere.
      // Append a readable (cosmetic) slug from the label; no locale segment, so
      // CardTrader auto-redirects to the viewer's own locale.
      if (item.cardtrader_id != null) {
        return `${BASE}/cards/${idWithSlug(item.cardtrader_id, item.label)}`;
      }
      // Defensive: blueprint without id (should never happen) — search by label.
      return searchUrl(item.label);

    case 'expansion':
      // Expansion page needs a name-slug not stored on WatchItem; search instead.
      // Query the expansion name so the user lands on a filtered list of that set.
      return searchUrl(item.label);

    case 'card':
      // Any-printing watch: link to a representative printing's /versions page,
      // which lists every printing. repr_blueprint_id is derived server-side from
      // the catalog; when absent (set not synced yet) fall back to a name search.
      if (item.repr_blueprint_id != null) {
        const slugName = item.card_name_norm ?? item.label;
        return `${BASE}/cards/${idWithSlug(item.repr_blueprint_id, slugName)}/versions`;
      }
      return searchUrl(item.card_name_norm ?? item.label);
  }
}

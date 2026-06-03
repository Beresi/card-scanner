/**
 * effOf — §9a inherit/override resolver for the watchlist UI.
 *
 * MIRRORS the backend resolveEffective: a field is "inherited" when the
 * WatchItem column is null; the effective value then comes from the
 * matching Config default.
 *
 * Rules:
 *   - min_discount_pct  → config.default_discount_pct
 *   - min_condition     → config.default_min_condition
 *   - foil_pref         → config.new_ticket_foil_pref
 *   - importance        → config.new_ticket_importance
 *   - telegram_enabled  → config.new_ticket_telegram_enabled
 *   - telegram_min_discount_pct → config.telegram_min_discount_pct
 *
 * Fields NOT in this helper (no config default — plain nullable):
 *   - telegram_max_price_cents   (NULL = "no cap")
 *   - telegram_min_savings_cents (NULL = "no floor")
 *   - allow_graded               (schema default is 0, no config col)
 *
 * The UI DISPLAYS inherit vs override state; it never resolves for scan
 * purposes — that is the backend's job.
 */
import type { Config, DetectionMode, WatchItem } from '../../api/types';
import { usd } from '../../lib/format';

// Fields with a real config default — InheritField applies here
export type InheritableField =
  | 'min_discount_pct'
  | 'min_condition'
  | 'foil_pref'
  | 'importance'
  | 'telegram_enabled'
  | 'telegram_min_discount_pct'
  | 'detection_mode'
  | 'max_price_cents';

export interface EffResult<T> {
  /** The effective display value (item override if set, else config default) */
  value: T;
  /** True when the item column is null (using the config default) */
  inherited: boolean;
  /** Human-readable label for the config default shown in InheritField */
  defaultLabel: string;
}

/**
 * Resolve effective min_discount_pct for display.
 */
export function effThreshold(item: WatchItem, config: Config): EffResult<number> {
  const inherited = item.min_discount_pct == null;
  return {
    value: item.min_discount_pct ?? config.default_discount_pct,
    inherited,
    defaultLabel: `${config.default_discount_pct}%`,
  };
}

/**
 * Resolve effective min_condition for display.
 */
export function effMinCondition(item: WatchItem, config: Config): EffResult<string> {
  const inherited = item.min_condition == null;
  return {
    value: item.min_condition ?? config.default_min_condition,
    inherited,
    defaultLabel: config.default_min_condition,
  };
}

/**
 * Resolve effective foil_pref for display.
 */
export function effFoilPref(
  item: WatchItem,
  config: Config,
): EffResult<'any' | 'foil' | 'nonfoil'> {
  const inherited = item.foil_pref == null;
  return {
    value: item.foil_pref ?? config.new_ticket_foil_pref,
    inherited,
    defaultLabel: config.new_ticket_foil_pref,
  };
}

/**
 * Resolve effective importance for display.
 */
export function effImportance(
  item: WatchItem,
  config: Config,
): EffResult<'low' | 'normal' | 'high'> {
  const inherited = item.importance == null;
  return {
    value: item.importance ?? config.new_ticket_importance,
    inherited,
    defaultLabel: config.new_ticket_importance,
  };
}

/**
 * Resolve effective telegram_enabled for display.
 * Returns a boolean (0|1 → false|true) at the display edge.
 */
export function effTelegramEnabled(
  item: WatchItem,
  config: Config,
): EffResult<boolean> {
  const inherited = item.telegram_enabled == null;
  const rawDefault = config.new_ticket_telegram_enabled;
  return {
    value: (item.telegram_enabled ?? rawDefault) === 1,
    inherited,
    defaultLabel: rawDefault === 1 ? 'on' : 'off',
  };
}

/**
 * Resolve effective telegram_min_discount_pct for display.
 */
export function effTelegramMinDiscount(item: WatchItem, config: Config): EffResult<number> {
  const inherited = item.telegram_min_discount_pct == null;
  return {
    value: item.telegram_min_discount_pct ?? config.telegram_min_discount_pct,
    inherited,
    defaultLabel: `${config.telegram_min_discount_pct}%`,
  };
}

/**
 * Resolve effective detection_mode for display.
 *
 * 'discount' (the default) uses the min_discount_pct / median-baseline logic.
 * 'price' flags any listing whose price_cents ≤ max_price_cents.
 */
export function effDetectionMode(item: WatchItem, config: Config): EffResult<DetectionMode> {
  const inherited = item.detection_mode == null;
  const dflt = config.default_detection_mode;
  return {
    value: item.detection_mode ?? dflt,
    inherited,
    defaultLabel: dflt,
  };
}

/**
 * Resolve effective max_price_cents for display.
 *
 * NULL means "no price cap" — the item (and possibly the config default) have no
 * absolute ceiling, so detection falls back to min_discount_pct in discount mode.
 * defaultLabel is either a formatted dollar amount or "none" when the config
 * default is also null.
 */
export function effMaxPrice(item: WatchItem, config: Config): EffResult<number | null> {
  const inherited = item.max_price_cents == null;
  const dflt = config.default_max_price_cents;
  return {
    value: item.max_price_cents ?? dflt,
    inherited,
    defaultLabel: dflt != null ? usd(dflt) : 'none',
  };
}

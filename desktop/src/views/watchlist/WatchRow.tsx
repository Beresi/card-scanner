/**
 * WatchRow — one dense table row in the watchlist.
 *
 * Columns (9-column grid from watchlist.css .wr):
 *   type icon | name+subtext | condition | foil | threshold | importance | telegram | [hits slot] | active switch
 *
 * Interaction:
 *   - Clicking the row calls select(item.id).
 *   - The active Switch fires usePatchWatchItem inline and stopPropagation
 *     so it does not select the row.
 *   - Keyboard: the row is focusable via role="row" + tabIndex=0; Enter/Space selects.
 *
 * §9a: shows resolved (effective) values for display using effOf helpers.
 * The "hits" column has no WatchItem schema field — it is rendered as a
 * placeholder dash per the spec note (column dropped; slot kept for layout).
 *
 * Config is optional here: WatchRow is rendered while config is still loading.
 * When null/undefined the effOf helpers fall back gracefully (inherited = true,
 * defaultLabel = '…').
 */
import type { Config, WatchItem } from '../../api/types';
import { usePatchWatchItem } from '../../api/hooks';
import { Icon } from '../../components/Icon';
import { Switch } from '../../components/Switch';
import { Tag } from '../../components/Tag';
import { effImportance, effMinCondition, effThreshold } from './effOf';

export interface WatchRowProps {
  item: WatchItem;
  /** May be undefined while config is loading — effOf handles it gracefully. */
  config: Config | undefined;
  isSelected: boolean;
  onSelect: (id: number) => void;
}

// Condition short labels shown in the table row
const COND_SHORT: Record<string, string> = {
  NM: 'NM',
  LP: 'LP',
  MP: 'MP',
  HP: 'HP',
  D:  'D',
};

// Minimal Config fallback used only while config is still loading.
const CONFIG_FALLBACK: Config = {
  default_threshold_pct: 50,
  default_min_condition: 'NM',
  cohort_size: 4,
  min_cohort: 2,
  currency: 'USD',
  min_price_cents: 200,
  min_savings_cents: 100,
  new_ticket_foil_pref: 'any',
  new_ticket_allow_graded: 0,
  new_ticket_importance: 'normal',
  new_ticket_telegram_enabled: 0,
  telegram_min_discount_pct: 60,
  quiet_hours_start: null,
  quiet_hours_end: null,
  digest_on_quiet_end: 0,
  theme: 'dark',
  theme_palette: 'cyan',
  font: 'chakra',
  accent_color: '',
  density: 'comfortable',
  scan_mode: 'chunked',
  scan_batch_size: 40,
  deal_retention_days: 30,
  timezone: null,
  updated_at: null,
};

export function WatchRow({
  item,
  config,
  isSelected,
  onSelect,
}: WatchRowProps) {
  const patchItem = usePatchWatchItem();

  const effectiveConfig = config ?? CONFIG_FALLBACK;
  const thrEff  = effThreshold(item, effectiveConfig);
  const condEff = effMinCondition(item, effectiveConfig);
  const impEff  = effImportance(item, effectiveConfig);

  const selected = isSelected;

  const rowClass = [
    'wr',
    selected ? 'is-sel' : undefined,
    item.active === 0 ? 'wr-off' : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  function handleClick() {
    onSelect(item.id);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(item.id);
    }
  }

  function handleSwitchClick(e: React.MouseEvent) {
    e.stopPropagation();
  }

  function handleToggleActive() {
    patchItem.mutate({ id: item.id, patch: { active: item.active === 1 ? 0 : 1 } });
  }

  const condShort = COND_SHORT[condEff.value] ?? condEff.value;
  const isHighImp = impEff.value === 'high';
  const hasTelegram = item.telegram_enabled === 1;

  return (
    <div
      className={rowClass}
      role="row"
      tabIndex={0}
      aria-selected={selected}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Type icon */}
      <span className="wr-type" role="cell">
        <Icon
          name={item.type === 'expansion' ? 'layers' : 'card'}
          size={15}
          svgProps={{
            style: { color: item.type === 'expansion' ? 'var(--accent)' : 'var(--text-dim)' },
          }}
        />
      </span>

      {/* Name + subtext */}
      <span className="wr-name" role="cell">
        <span className="wr-label">{item.label}</span>
        <span className="wr-exp cb-mono">#{item.cardtrader_id}</span>
      </span>

      {/* Condition */}
      <span className="wr-c" role="cell">
        <Tag tone={condEff.value === 'NM' ? 'good' : 'default'} title={condEff.inherited ? `inherit · ${condEff.defaultLabel}` : undefined}>
          {condShort}+
        </Tag>
      </span>

      {/* Foil pref */}
      <span className="wr-c wr-foil" role="cell">
        {item.foil_pref ?? effectiveConfig.new_ticket_foil_pref}
      </span>

      {/* Threshold — dim if inherited */}
      <span
        className="wr-c wr-thr"
        role="cell"
        title={thrEff.inherited ? `inherit · ${thrEff.defaultLabel}` : undefined}
        style={{ color: thrEff.inherited ? 'var(--text-faint)' : undefined } as React.CSSProperties}
      >
        &le;{thrEff.value}%
      </span>

      {/* Importance */}
      <span className="wr-c wr-imp" role="cell">
        {isHighImp ? (
          <Tag tone="hot">HIGH</Tag>
        ) : (
          <span style={{ color: 'var(--text-faint)', fontSize: 11, fontFamily: 'var(--f-mono)' }}>
            normal
          </span>
        )}
      </span>

      {/* Telegram */}
      <span className="wr-c wr-tg" role="cell">
        {hasTelegram ? (
          <Tag tone="accent" title="Telegram enabled">
            <Icon name="send" size={10} />
          </Tag>
        ) : (
          <span style={{ color: 'var(--text-faint)' }} aria-label="Telegram disabled">—</span>
        )}
      </span>

      {/* Hits — no hits field in WatchItem; column kept for layout, always dash */}
      <span
        className="wr-c wr-hits"
        role="cell"
        aria-label="Hits: not available"
        style={{ color: 'var(--text-faint)' } as React.CSSProperties}
      >
        —
      </span>

      {/* Active switch — stopPropagation so click does not select the row */}
      <span
        className="wr-c wr-act"
        role="cell"
        onClick={handleSwitchClick}
      >
        <Switch
          on={item.active === 1}
          onChange={handleToggleActive}
          aria-label={`${item.label} active`}
        />
      </span>
    </div>
  );
}

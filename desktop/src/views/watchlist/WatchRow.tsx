/**
 * WatchRow — one dense table row in the watchlist.
 *
 * Columns (9-column grid from watchlist.css .wr):
 *   type icon | name+subtext | condition | foil | threshold | importance | telegram | [hits slot] | active switch
 *
 * Interaction:
 *   - Clicking the row calls select(item.id).
 *   - The active Switch calls toggleActive and stopPropagation so it does not
 *     select the row.
 *   - Keyboard: the row is focusable via role="row" + tabIndex=0; Enter selects.
 *
 * §9a: shows resolved (effective) values for display using effOf helpers.
 * The "hits" column has no WatchItem schema field — it is rendered as a
 * placeholder dash per the spec note (column dropped; slot kept for layout).
 */
import type { Config, WatchItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Switch } from '../../components/Switch';
import { Tag } from '../../components/Tag';
import { effImportance, effMinCondition, effThreshold } from './effOf';

export interface WatchRowProps {
  item: WatchItem;
  config: Config;
  isSelected: boolean;
  onSelect: (id: number) => void;
  onToggleActive: (id: number) => void;
}

// Condition short labels shown in the table row
const COND_SHORT: Record<string, string> = {
  NM: 'NM',
  LP: 'LP',
  MP: 'MP',
  HP: 'HP',
  D:  'D',
};

export function WatchRow({
  item,
  config,
  isSelected,
  onSelect,
  onToggleActive,
}: WatchRowProps) {
  const thrEff = effThreshold(item, config);
  const condEff = effMinCondition(item, config);
  const impEff = effImportance(item, config);

  const rowClass = [
    'wr',
    isSelected ? 'is-sel' : undefined,
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

  const condShort = COND_SHORT[condEff.value] ?? condEff.value;
  const isHighImp = impEff.value === 'high';
  const hasTelegram = item.telegram_enabled === 1;

  return (
    <div
      className={rowClass}
      role="row"
      tabIndex={0}
      aria-selected={isSelected}
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
        {item.foil_pref ?? config.new_ticket_foil_pref}
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
          onChange={() => onToggleActive(item.id)}
          aria-label={`${item.label} active`}
        />
      </span>
    </div>
  );
}

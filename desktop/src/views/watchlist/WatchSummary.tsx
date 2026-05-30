/**
 * WatchSummary — right-rail content shown when NO watchlist row is selected.
 *
 * Reads useWatchlist() for the item list (real server data via TanStack Query).
 * Reads useWatchSelection() for the openAddFlow action.
 *
 * Stats rendered:
 *   - Total items
 *   - Active count
 *   - High-priority count
 *   - Telegram-on count
 *   - Card vs set composition (two-segment bar using .tdist classes)
 *   - Active vs inactive bar
 *
 * "Add card or set" button opens the AddFlow modal via the shared selection
 * store's openAddFlow() — no prop-drilling.
 */
import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { useWatchlist } from '../../api/hooks';
import { useWatchSelection } from './selection';

export function WatchSummary() {
  const { data: items = [] } = useWatchlist();
  const { openAddFlow } = useWatchSelection();

  // Compute stats from current items
  const total        = items.length;
  const activeCount  = items.filter((w) => w.active === 1).length;
  const inactiveCount = total - activeCount;
  const highCount    = items.filter((w) => w.importance === 'high').length;
  const tgCount      = items.filter((w) => w.telegram_enabled === 1).length;
  const bpCount      = items.filter((w) => w.type === 'blueprint').length;
  const expCount     = items.filter((w) => w.type === 'expansion').length;

  // Bar fill percentages (guard against division by zero)
  const bpPct     = total > 0 ? Math.round((bpCount   / total) * 100) : 0;
  const expPct    = total > 0 ? Math.round((expCount  / total) * 100) : 0;
  const activePct = total > 0 ? Math.round((activeCount / total) * 100) : 0;

  return (
    <div className="tele" style={{ gap: 16 }}>
      {/* Eyebrow */}
      <span className="cb-eyebrow">Watchlist summary</span>

      {/* Stat tiles — 2-column grid */}
      <div className="tstat-grid">
        <div className="tstat">
          <span className="cb-eyebrow" style={{ fontSize: 9 }}>Total</span>
          <span className="tstat-v">{total}</span>
        </div>
        <div className="tstat tstat-accent">
          <span className="cb-eyebrow" style={{ fontSize: 9 }}>Active</span>
          <span className="tstat-v">{activeCount}</span>
        </div>
        <div className="tstat tstat-hot">
          <span className="cb-eyebrow" style={{ fontSize: 9 }}>High priority</span>
          <span className="tstat-v">{highCount}</span>
        </div>
        <div className="tstat tstat-good">
          <span className="cb-eyebrow" style={{ fontSize: 9 }}>Telegram on</span>
          <span className="tstat-v">{tgCount}</span>
        </div>
      </div>

      {/* Composition bars */}
      <div className="tele-sec">
        <span className="cb-eyebrow" style={{ display: 'block', marginBottom: 10 }}>
          Composition
        </span>
        <div className="tdist">
          <div className="tdist-row">
            <span className="tdist-k">Cards</span>
            <div className="tdist-bar">
              <div className="tdist-fill" style={{ width: `${bpPct}%` }} />
            </div>
            <span className="tdist-n">{bpCount}</span>
          </div>
          <div className="tdist-row">
            <span className="tdist-k">Sets</span>
            <div className="tdist-bar">
              <div
                className="tdist-fill"
                style={{
                  width: `${expPct}%`,
                  background: 'var(--text-dim)',
                  boxShadow: 'none',
                }}
              />
            </div>
            <span className="tdist-n">{expCount}</span>
          </div>
        </div>
      </div>

      {/* Active/inactive bar */}
      <div className="tdist">
        <div className="tdist-row">
          <span className="tdist-k">Active</span>
          <div className="tdist-bar">
            <div
              className="tdist-fill"
              style={{
                width: `${activePct}%`,
                background: 'var(--good)',
                boxShadow: '0 0 calc(7px * var(--glow)) var(--good)',
              }}
            />
          </div>
          <span className="tdist-n">{activeCount}</span>
        </div>
        <div className="tdist-row">
          <span className="tdist-k">Inactive</span>
          <div className="tdist-bar">
            <div
              className="tdist-fill"
              style={{
                width: total > 0 ? `${100 - activePct}%` : '0%',
                background: 'var(--text-faint)',
                boxShadow: 'none',
              }}
            />
          </div>
          <span className="tdist-n">{inactiveCount}</span>
        </div>
      </div>

      {/* Hint + add button */}
      <div className="ws-hint">
        Select a row to inspect and edit its settings, or add a new card or set below.
      </div>

      <Btn
        variant="primary"
        onClick={openAddFlow}
        style={{ width: '100%', justifyContent: 'center', display: 'flex', alignItems: 'center', gap: 6 } as React.CSSProperties}
      >
        <Icon name="plus" size={14} />
        Add card or set
      </Btn>
    </div>
  );
}

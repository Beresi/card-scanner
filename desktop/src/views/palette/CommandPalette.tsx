/**
 * CommandPalette — ⌘K command palette.
 *
 * Rendered inside Modal (inherits focus-trap, Esc, and focus restore).
 * The Modal provides the .cb-modal-overlay backdrop; we pass className="cmdk"
 * so the panel gets the palette-specific styling.
 *
 * Keyboard:
 *   ArrowDown / ArrowUp  — move .is-active highlight (wraps)
 *   Enter                — run the active command and close
 *   Esc                  — Modal handles Esc → onClose (no double-close)
 *   Mouse hover          — sets active index
 *
 * The active item is scrolled into view automatically.
 *
 * A11y:
 *   - input: role implicit, aria-label, autofocus via Modal
 *   - list: role="listbox", items role="option" aria-selected
 *   - aria-activedescendant on the input points to the active item id
 *
 * Command list is built from props. Each command has:
 *   { id, group, label, hint?, icon?, run() }
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { IconName } from '../../components/Icon';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useWatchlist } from '../../api/hooks';
import type { ViewKey } from '../types';

// ---------------------------------------------------------------------------
// Command shape
// ---------------------------------------------------------------------------

interface PaletteCommand {
  id: string;
  group: 'Navigate' | 'Actions' | 'Watch Items';
  label: string;
  hint?: string;
  icon?: IconName;
  run: () => void;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: ViewKey) => void;
  onScanNow: () => void;
  onReplayBoot: () => void;
  onToggleEffects: () => void;
  onJumpToWatch: (id: number) => void;
}

// ---------------------------------------------------------------------------
// Token-match filter (multi-token, case-insensitive, matches label + group + hint)
// ---------------------------------------------------------------------------

function matches(cmd: PaletteCommand, q: string): boolean {
  if (!q.trim()) return true;
  const haystack = [cmd.label, cmd.group, cmd.hint ?? '']
    .join(' ')
    .toLowerCase();
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((tok) => haystack.includes(tok));
}

// ---------------------------------------------------------------------------
// CommandPalette
// ---------------------------------------------------------------------------

const LABEL_ID = 'cmdk-label';
const listboxId = 'cmdk-listbox';
function itemId(i: number): string {
  return `cmdk-item-${i}`;
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onScanNow,
  onReplayBoot,
  onToggleEffects,
  onJumpToWatch,
}: CommandPaletteProps) {
  const { data: watchItems = [] } = useWatchlist();
  const [q, setQ] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset query + index when palette opens/closes
  useEffect(() => {
    if (!open) {
      setQ('');
      setActiveIdx(0);
    }
  }, [open]);

  // Build the full command list (memoised; rebuilds when watchItems or callbacks change)
  const allCommands = useMemo<PaletteCommand[]>(() => {
    const navCmds: PaletteCommand[] = [
      {
        id: 'nav-feed',
        group: 'Navigate',
        label: 'Deal Feed',
        hint: 'View all open deals',
        icon: 'feed',
        run: () => onNavigate('feed'),
      },
      {
        id: 'nav-watchlist',
        group: 'Navigate',
        label: 'Watchlist',
        hint: 'Manage watched cards and sets',
        icon: 'watch',
        run: () => onNavigate('watchlist'),
      },
      {
        id: 'nav-settings',
        group: 'Navigate',
        label: 'Settings',
        hint: 'Configure app preferences',
        icon: 'gear',
        run: () => onNavigate('settings'),
      },
      {
        id: 'nav-health',
        group: 'Navigate',
        label: 'Health',
        hint: 'Scanner status and scan history',
        icon: 'pulse',
        run: () => onNavigate('health'),
      },
    ];

    const actionCmds: PaletteCommand[] = [
      {
        id: 'act-scan',
        group: 'Actions',
        label: 'Scan now',
        hint: 'Trigger an immediate scan run',
        icon: 'radar',
        run: () => {
          onScanNow();
          onClose();
        },
      },
      {
        id: 'act-boot',
        group: 'Actions',
        label: 'Replay boot sequence',
        hint: 'Re-run the startup animation on next reload',
        icon: 'bolt',
        run: onReplayBoot,
      },
      {
        id: 'act-fx',
        group: 'Actions',
        label: 'Toggle motion effects',
        hint: 'Enable or disable all animations',
        icon: 'bolt',
        run: onToggleEffects,
      },
    ];

    const watchCmds: PaletteCommand[] = watchItems.map((item) => ({
      id: `watch-${item.id}`,
      group: 'Watch Items' as const,
      label: item.label,
      hint: item.type === 'expansion' ? 'expansion' : 'blueprint',
      icon: item.type === 'expansion' ? 'layers' : 'card',
      run: () => onJumpToWatch(item.id),
    }));

    return [...navCmds, ...actionCmds, ...watchCmds];
  }, [watchItems, onNavigate, onScanNow, onClose, onReplayBoot, onToggleEffects, onJumpToWatch]);

  // Filtered list
  const filtered = useMemo(
    () => allCommands.filter((c) => matches(c, q)),
    [allCommands, q],
  );

  // Reset active index when query changes
  useEffect(() => {
    setActiveIdx(0);
  }, [q]);

  // Scroll active item into view
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, filtered.length]);

  // Group-preserving ordered groups
  const groups = useMemo(() => {
    const seen = new Map<string, PaletteCommand[]>();
    for (const cmd of filtered) {
      const arr = seen.get(cmd.group) ?? [];
      arr.push(cmd);
      seen.set(cmd.group, arr);
    }
    return Array.from(seen.entries()); // [groupName, commands[]]
  }, [filtered]);

  // Keyboard handler on the inner panel (Modal's onKeyDown also fires for Esc)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % Math.max(filtered.length, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) =>
          i <= 0 ? Math.max(filtered.length - 1, 0) : i - 1,
        );
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[activeIdx];
        if (cmd) {
          cmd.run();
          // run() might call onClose internally (scan-now does); for others, close too.
          onClose();
        }
      }
      // Esc is handled by Modal — no double-close needed.
    },
    [filtered, activeIdx, onClose],
  );

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={LABEL_ID}
      className="cmdk"
    >
      {/* Visually hidden label for the dialog */}
      <span id={LABEL_ID} style={{ display: 'none' }}>
        Command palette
      </span>

      {/* Input row */}
      <div className="cmdk-input-wrap" onKeyDown={handleKeyDown}>
        <Icon name="search" size={16} />
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="type a command, view, or card…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search commands"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={
            filtered.length > 0 ? itemId(activeIdx) : undefined
          }
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
        <span className="cmdk-esc">ESC</span>
      </div>

      {/* Results list */}
      <div
        id={listboxId}
        className="cmdk-list"
        role="listbox"
        aria-label="Command results"
      >
        {filtered.length === 0 ? (
          <div className="cmdk-none">no matching command</div>
        ) : (
          groups.map(([groupName, cmds]) => (
            <div key={groupName} className="cmdk-group">
              <div className="cmdk-group-label cb-eyebrow">{groupName}</div>
              {cmds.map((cmd) => {
                // global index in filtered for is-active comparison
                const globalIdx = filtered.indexOf(cmd);
                const isActive = globalIdx === activeIdx;
                return (
                  <button
                    key={cmd.id}
                    id={itemId(globalIdx)}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    ref={isActive ? (el) => { activeItemRef.current = el; } : undefined}
                    className={['cmdk-item', isActive ? 'is-active' : ''].filter(Boolean).join(' ')}
                    onMouseEnter={() => setActiveIdx(globalIdx)}
                    onClick={() => {
                      cmd.run();
                      onClose();
                    }}
                  >
                    {cmd.icon && (
                      <Icon
                        name={cmd.icon}
                        size={15}
                        svgProps={{
                          style: {
                            color: isActive ? 'var(--accent)' : 'var(--text-dim)',
                            flexShrink: 0,
                          },
                        }}
                      />
                    )}
                    <span className="cmdk-item-label">{cmd.label}</span>
                    {cmd.hint && (
                      <span className="cmdk-item-hint">{cmd.hint}</span>
                    )}
                    {isActive && <span className="cmdk-enter">↵</span>}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* Footer legend */}
      <div className="cmdk-foot">
        <span>↑↓ navigate</span>
        <span>↵ run</span>
        <span>esc close</span>
      </div>
    </Modal>
  );
}

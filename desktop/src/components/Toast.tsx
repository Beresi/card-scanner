/**
 * Toast + ToastHost — notification toasts with auto-dismiss queue.
 *
 * ---- Toast (presentational item) ----
 * Emits:
 *   .toast               (root — always)
 *   .toast-hot           (tone="hot")
 *   .toast-rail          (left accent bar)
 *   .toast-body          (text content area)
 *   .toast-head          (eyebrow / icon row)
 *   .toast-title         (primary text)
 *   .toast-sub           (secondary text — when sub is provided)
 *
 * NOTE: The CSS defines .toast-rail with background: var(--hot) by default.
 * Tone variants 'accent' and 'good' are not defined in overlays.css at this
 * time (only .toast-hot exists). The component emits .toast-hot for tone="hot"
 * and leaves the base .toast for tone="accent"|"good" so the default styling
 * applies. REPORT: no .toast-accent or .toast-good class exists in overlays.css;
 * the design-agent should add those if distinct styling is needed.
 *
 * ---- ToastHost (queue + container) ----
 * Emits:
 *   .toasts              (fixed host container, aria-live="polite")
 *
 * ---- useToasts() hook ----
 * Returns { toasts, push, dismiss }:
 *   push(item: ToastItem): string   → adds a toast; auto-dismisses after 4600 ms.
 *   dismiss(id: string): void       → removes immediately.
 *   toasts: ToastEntry[]            → current queue (for ToastHost).
 *
 * Usage:
 *   const { toasts, push, dismiss } = useToasts();
 *   // somewhere:
 *   push({ title: 'Deal found', sub: 'Lightning Bolt −63%', tone: 'hot' });
 *   // render:
 *   <ToastHost toasts={toasts} onDismiss={dismiss} />
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { IconName } from './Icon';
import { Icon } from './Icon';

/* ============================================================
   Types
   ============================================================ */

export type ToastTone = 'accent' | 'hot' | 'good';

export interface ToastItem {
  title: string;
  sub?: string;
  tone?: ToastTone;
  icon?: IconName;
}

export interface ToastEntry extends ToastItem {
  id: string;
}

/* ============================================================
   Toast — presentational item
   ============================================================ */

export interface ToastProps extends ToastItem {
  className?: string;
}

export function Toast({ title, sub, tone, icon, className }: ToastProps) {
  const rootClass = [
    'toast',
    tone === 'hot' ? 'toast-hot' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass} role="status">
      <div className="toast-rail" aria-hidden="true" />
      <div className="toast-body">
        <div className="toast-head">
          {icon && <Icon name={icon} size={14} />}
          <span className="cb-eyebrow">{tone?.toUpperCase() ?? 'INFO'}</span>
        </div>
        <div className="toast-title">{title}</div>
        {sub && <div className="toast-sub">{sub}</div>}
      </div>
    </div>
  );
}

/* ============================================================
   ToastHost — queue container
   ============================================================ */

export interface ToastHostProps {
  toasts: ToastEntry[];
  onDismiss: (id: string) => void;
  className?: string;
}

export function ToastHost({ toasts, onDismiss, className }: ToastHostProps) {
  const rootClass = ['toasts', className].filter(Boolean).join(' ');

  return (
    <div className={rootClass} aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} style={{ position: 'relative' }}>
          <Toast
            title={t.title}
            sub={t.sub}
            tone={t.tone}
            icon={t.icon}
          />
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
            style={{
              position: 'absolute',
              top: '6px',
              right: '6px',
              background: 'transparent',
              border: '0',
              color: 'var(--text-faint)',
              cursor: 'pointer',
              padding: '2px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   useToasts() hook
   ============================================================ */

/** Auto-dismiss delay in ms. */
const AUTO_DISMISS_MS = 4600;

let _seq = 0;
function nextId(): string {
  return `toast-${++_seq}`;
}

export interface UseToastsReturn {
  toasts: ToastEntry[];
  /** Add a toast. Returns its generated id. Auto-dismisses after 4600 ms. */
  push: (item: ToastItem) => string;
  /** Immediately remove a toast by id. */
  dismiss: (id: string) => void;
}

export function useToasts(): UseToastsReturn {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  // Track per-toast timer handles so we can clear them on manual dismiss.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Cleanup all timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((handle) => clearTimeout(handle));
      timers.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (item: ToastItem): string => {
      const id = nextId();
      const entry: ToastEntry = { ...item, id };
      setToasts((prev) => [...prev, entry]);

      const handle = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, AUTO_DISMISS_MS);

      timersRef.current.set(id, handle);
      return id;
    },
    [],
  );

  return { toasts, push, dismiss };
}

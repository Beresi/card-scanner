/**
 * Modal — generic dialog base with portal, focus trap, and focus restore.
 *
 * Emits:
 *   cb-modal-overlay     (fixed full-screen backdrop)
 *   cb-modal             (the dialog panel; + className)
 *
 * A11y requirements met:
 *   - role="dialog" aria-modal="true" on the panel.
 *   - aria-labelledby={labelledBy} when provided.
 *   - Focus moves into the panel (first focusable or the panel itself) on open.
 *   - Tab / Shift+Tab are trapped within the panel while open.
 *   - Escape closes the dialog (calls onClose).
 *   - Focus returns to the element that was focused before the modal opened.
 *
 * Portal: rendered into document.body so z-index layering is reliable.
 * Renders nothing (null) when open=false.
 *
 * Click on the overlay backdrop calls onClose; click inside the panel does
 * not propagate to the overlay (stopPropagation on the panel click).
 *
 * This is the shared base for the command palette, add-flow, and scan overlay.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** Selectors for all elements that can receive keyboard focus. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** id of the element that labels this dialog (aria-labelledby). */
  labelledBy?: string;
  children: React.ReactNode;
  className?: string;
}

export function Modal({ open, onClose, labelledBy, children, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** The element focused before this modal opened — restored on close. */
  const restoreRef = useRef<Element | null>(null);

  // Move focus into the panel when opening; record the prior focus target.
  useEffect(() => {
    if (!open) return;

    // Remember what had focus before the modal opened.
    restoreRef.current = document.activeElement;

    const panel = panelRef.current;
    if (!panel) return;

    // Focus the first focusable child, or the panel itself.
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    if (first) {
      first.focus();
    } else {
      panel.focus();
    }

    return () => {
      // Restore focus when unmounting with open=true (e.g. hot-reload edge case).
      if (restoreRef.current instanceof HTMLElement) {
        restoreRef.current.focus();
      }
    };
  }, [open]);

  // Restore focus when modal closes.
  useEffect(() => {
    if (open) return;
    if (restoreRef.current instanceof HTMLElement) {
      restoreRef.current.focus();
      restoreRef.current = null;
    }
  }, [open]);

  // Trap Tab / Shift+Tab within the panel; Escape closes.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;

    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  if (!open) return null;

  const panelClass = ['cb-modal', className].filter(Boolean).join(' ');

  return createPortal(
    <div
      className="cb-modal-overlay"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * EffectsContext — lightweight provider for the motion/effects flag.
 *
 * Persists to localStorage key 'cardbroker_fx' (default: ON).
 * On mount and on every change, writes:
 *   document.body.dataset.fx = enabled ? 'on' : 'off'
 *
 * CSS convention (effects.css):
 *   body:not([data-fx="off"]) .the-class { animation: … }
 * So: 'on' = effects enabled; 'off' = all motion disabled.
 * Absence of the attribute (pre-mount) = treated as ON by CSS (no guard matches 'off').
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

const LS_KEY = 'cardbroker_fx';

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface EffectsContextValue {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

const EffectsContext = createContext<EffectsContextValue>({
  enabled: true,
  setEnabled: () => undefined,
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function readFromStorage(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    // null (never set) → default ON; anything stored that is NOT '0' → ON
    return raw !== '0';
  } catch {
    return true;
  }
}

export function EffectsProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(readFromStorage);

  // Sync to DOM attribute + localStorage on every change.
  useEffect(() => {
    document.body.dataset.fx = enabled ? 'on' : 'off';
    try {
      localStorage.setItem(LS_KEY, enabled ? '1' : '0');
    } catch {
      // localStorage unavailable — silently ignore
    }
  }, [enabled]);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
  }, []);

  const value = useMemo<EffectsContextValue>(
    () => ({ enabled, setEnabled }),
    [enabled, setEnabled],
  );

  return (
    <EffectsContext.Provider value={value}>{children}</EffectsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useEffects(): EffectsContextValue {
  return useContext(EffectsContext);
}

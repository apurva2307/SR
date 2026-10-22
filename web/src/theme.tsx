import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'sevalekh.theme';
const CHOICES: ThemeChoice[] = ['system', 'light', 'dark'];

function read(): ThemeChoice {
  // Wrapped: a private window, cleared site data, or a browser set to block
  // site data makes the accessor itself throw, and the page must still render.
  try {
    const v = localStorage.getItem(KEY);
    return CHOICES.includes(v as ThemeChoice) ? (v as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

/**
 * "system" stamps nothing, leaving prefers-color-scheme to decide. An explicit
 * choice stamps data-theme, which the stylesheet honours in both directions.
 */
function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

interface ThemeValue {
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
}

const Ctx = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(read);

  useEffect(() => { apply(choice); }, [choice]);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
    try { localStorage.setItem(KEY, c); } catch { /* preference simply will not persist */ }
  }, []);

  const value = useMemo(() => ({ choice, setChoice }), [choice, setChoice]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}

const LABELS: Record<ThemeChoice, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

export function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  return (
    <div className="theme-switch" role="group" aria-label="Colour theme">
      {CHOICES.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={choice === c}
          title={c === 'system' ? 'Follow the operating system setting' : `Always ${LABELS[c].toLowerCase()}`}
          onClick={() => setChoice(c)}
        >
          {LABELS[c]}
        </button>
      ))}
    </div>
  );
}

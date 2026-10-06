'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

function applyTheme(theme: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Storage can be unavailable (private mode, blocked). The class still
    // applies for this session; we just can't persist the choice.
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    // Dark is the default; only an explicit 'light' choice steps it down. This
    // matches the server-rendered default and the bootstrap script in the root
    // layout, so the icon never disagrees with the painted theme.
    const initial: 'light' | 'dark' =
      localStorage.getItem('theme') === 'light' ? 'light' : 'dark';
    // One-time sync of initial theme from persisted storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initial);
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}

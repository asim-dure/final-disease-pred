import React, { useEffect, useState } from 'react'

// Two visual themes only -- "Light" (current white UI, unchanged) and "Dark"
// (inverted per the FMOH-MDD Situation Room reference the user supplied).
// Purely a `data-theme` attribute on <html> plus the CSS variable overrides
// in styles.css (:root[data-theme='dark']) -- no component logic changes,
// every existing view already reads var(--bg-1)/var(--txt-0)/etc or (for the
// miq-root command-centre dashboards) the C object, which now points at the
// same var(--miq-*) tokens. Persisted in localStorage so a refresh keeps
// whichever theme was picked.
const STORAGE_KEY = 'miq-theme'

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light'
    return localStorage.getItem(STORAGE_KEY) || 'light'
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])
  return [theme, setTheme]
}

export function ThemeToggle({ theme, setTheme }) {
  const dark = theme === 'dark'
  return (
    <button type="button" className="theme-toggle" onClick={() => setTheme(dark ? 'light' : 'dark')}
      title={dark ? 'Switch to Light mode' : 'Switch to Dark mode'}>
      <span className="dot">{dark ? '🌙' : '☀️'}</span>
      {dark ? 'Dark' : 'Light'}
    </button>
  )
}

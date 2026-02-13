import { useSyncExternalStore } from 'react'
import { useAppStore } from '../store/app-store'
import type { Theme } from '../store/types'

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

function getSystemTheme(): 'dark' | 'light' {
  return mediaQuery.matches ? 'dark' : 'light'
}

function subscribeToSystemTheme(callback: () => void): () => void {
  mediaQuery.addEventListener('change', callback)
  return () => mediaQuery.removeEventListener('change', callback)
}

/**
 * Returns the resolved theme ('dark' | 'light') based on the user's theme setting.
 * When the setting is 'system', this hook subscribes to OS theme changes and
 * automatically updates when the system preference changes.
 */
export function useResolvedTheme(): 'dark' | 'light' {
  const themeSetting = useAppStore((s) => s.settings.theme)
  const systemTheme = useSyncExternalStore(subscribeToSystemTheme, getSystemTheme)

  if (themeSetting === 'system') {
    return systemTheme
  }
  return themeSetting
}

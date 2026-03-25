import { useEffect } from 'react'

/**
 * Watch a directory for filesystem changes and invoke a callback when changes occur.
 * Handles watchDir registration, onDirChanged listener filtered by path, and cleanup.
 */
export function useFileWatcher(worktreePath: string, callback: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    window.api.fs.watchDir(worktreePath)
    const unsub = window.api.fs.onDirChanged((changedDir: string) => {
      if (changedDir === worktreePath) callback()
    })
    return () => {
      unsub()
      window.api.fs.unwatchDir(worktreePath)
    }
  }, [worktreePath, callback, enabled])
}

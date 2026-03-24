import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'

export function useSyncProgressListener(): void {
  useEffect(() => {
    return window.api.git.onSyncProgress((progress) => {
      const { workspaces, setSyncState, addToast } = useAppStore.getState()

      // Match worktreePath to a workspace
      const ws = workspaces.find((w) => w.worktreePath === progress.worktreePath)
      if (!ws) return

      if (progress.stage === 'done') {
        setSyncState(ws.id, { syncing: false, lastSyncedAt: Date.now(), lastError: null })
      } else if (progress.stage === 'error') {
        setSyncState(ws.id, { syncing: false, lastError: progress.message })
        addToast({ id: `sync-err-${ws.id}-${Date.now()}`, message: `Sync failed for ${ws.name}: ${progress.message}`, type: 'error' })
      } else if (progress.stage === 'skip') {
        setSyncState(ws.id, { syncing: false, lastError: null })
      } else {
        setSyncState(ws.id, { syncing: true, lastError: null })
      }
    })
  }, [])
}

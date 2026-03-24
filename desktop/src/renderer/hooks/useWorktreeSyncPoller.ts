import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

const POLL_INTERVAL = 60_000

export function useWorktreeSyncPoller(): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    let disposed = false

    async function poll() {
      if (disposed || document.hidden || runningRef.current) return
      runningRef.current = true

      try {
        const { projects, workspaces, lastKnownRemoteHead, setLastKnownRemoteHead } =
          useAppStore.getState()

        for (const project of projects) {
          if (disposed) break
          const projectWs = workspaces.filter((w) => w.projectId === project.id)
          if (projectWs.length === 0) continue

          try {
            const defaultBranch = await window.api.git.getDefaultBranch(project.repoPath)
            const shortBranch = defaultBranch.replace(/^origin\//, '')
            const hash = await window.api.git.checkRemoteHead(project.repoPath, shortBranch)
            if (!hash) continue

            const prev = lastKnownRemoteHead[project.id]
            if (prev && prev !== hash) {
              // Remote head changed — sync all worktrees
              await window.api.git.syncAllWorktrees(project.repoPath)
            }
            setLastKnownRemoteHead(project.id, hash)
          } catch {
            // Network issue or missing remote — skip
          }
        }
      } finally {
        runningRef.current = false
      }

      if (!disposed && !document.hidden) {
        timerRef.current = setTimeout(poll, POLL_INTERVAL)
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
      } else {
        poll()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    // Initial poll after a short delay
    timerRef.current = setTimeout(poll, 5_000)

    return () => {
      disposed = true
      if (timerRef.current) clearTimeout(timerRef.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}

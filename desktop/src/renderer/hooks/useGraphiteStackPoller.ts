import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

const POLL_INTERVAL = 10_000

export function useGraphiteStackPoller(): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    let disposed = false

    async function poll() {
      if (disposed || runningRef.current) return
      runningRef.current = true

      try {
        const { projects, workspaces, setGraphiteStack, updateWorkspaceBranch } =
          useAppStore.getState()

        // Only poll workspaces belonging to graphite projects
        const graphiteProjectIds = new Set(
          projects
            .filter((p) => p.prLinkProvider === 'graphite')
            .map((p) => p.id),
        )

        const graphiteWorkspaces = workspaces.filter((ws) =>
          graphiteProjectIds.has(ws.projectId),
        )

        await Promise.allSettled(
          graphiteWorkspaces.map(async (ws) => {
            const project = projects.find((p) => p.id === ws.projectId)
            if (!project) return

            try {
              const stack = await window.api.graphite.getStack(
                project.repoPath,
                ws.worktreePath,
              )
              setGraphiteStack(ws.id, stack)

              // If the current branch changed, update the workspace
              if (stack && stack.currentBranch !== ws.branch) {
                updateWorkspaceBranch(ws.id, stack.currentBranch)
              }
            } catch {
              // Graphite info is nice-to-have — silently ignore
            }
          }),
        )
      } finally {
        runningRef.current = false
      }

      if (!disposed && !document.hidden) {
        timerRef.current = setTimeout(poll, POLL_INTERVAL)
      }
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
      } else {
        void poll()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    void poll()

    return () => {
      disposed = true
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}

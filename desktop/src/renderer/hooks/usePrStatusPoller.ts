import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

const POLL_INTERVAL = 90_000
const INITIAL_DELAY = 2_000

export function usePrStatusPoller(): void {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    async function pollAll() {
      const { projects, workspaces, setPrStatuses, setGhAvailability, updateWorkspaceBranch } =
        useAppStore.getState()

      // Refresh actual branch names from git before querying PRs
      await Promise.allSettled(
        workspaces.map(async (ws) => {
          if (!ws.worktreePath) return
          try {
            const actual = await window.api.git.getCurrentBranch(ws.worktreePath)
            if (actual && actual !== ws.branch) {
              updateWorkspaceBranch(ws.id, actual)
            }
          } catch {
            // Worktree may have been removed — ignore
          }
        })
      )

      // Re-read workspaces after branch updates
      const freshWorkspaces = useAppStore.getState().workspaces

      const projectBranches = new Map<string, { repoPath: string; branches: string[] }>()
      for (const ws of freshWorkspaces) {
        const project = projects.find((p) => p.id === ws.projectId)
        if (!project || !ws.branch) continue

        let entry = projectBranches.get(project.id)
        if (!entry) {
          entry = { repoPath: project.repoPath, branches: [] }
          projectBranches.set(project.id, entry)
        }
        if (!entry.branches.includes(ws.branch)) {
          entry.branches.push(ws.branch)
        }
      }

      const fetches = Array.from(projectBranches.entries()).map(
        async ([projectId, { repoPath, branches }]) => {
          try {
            const result = await window.api.github.getPrStatuses(repoPath, branches)
            setGhAvailability(projectId, result.available)
            if (result.available) {
              setPrStatuses(projectId, result.data)
            }
          } catch {
            // PR status is nice-to-have — silently ignore errors
          }
        }
      )

      await Promise.allSettled(fetches)
    }

    const initialTimer = setTimeout(pollAll, INITIAL_DELAY)
    timerRef.current = setInterval(pollAll, POLL_INTERVAL)

    return () => {
      clearTimeout(initialTimer)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])
}

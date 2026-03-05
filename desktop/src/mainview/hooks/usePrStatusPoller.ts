import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

const FAST_POLL_INTERVAL = 7_000
const NORMAL_POLL_INTERVAL = 25_000
const STARTUP_BURST_MS = 60_000
const RESUME_BURST_MS = 30_000
const EVENT_BURST_MS = 120_000
const PENDING_BURST_MS = 60_000
const PR_POLL_HINT_EVENT = 'constellagent:pr-poll-hint'

export function usePrStatusPoller(): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runningRef = useRef(false)
  const queuedImmediateRef = useRef(false)
  const burstUntilRef = useRef(0)

  useEffect(() => {
    let disposed = false

    const inBurst = () => Date.now() < burstUntilRef.current

    const extendBurst = (durationMs: number) => {
      const until = Date.now() + durationMs
      if (until > burstUntilRef.current) burstUntilRef.current = until
    }

    const nextIntervalMs = () => (inBurst() ? FAST_POLL_INTERVAL : NORMAL_POLL_INTERVAL)

    async function pollAll(): Promise<{ hasPendingChecks: boolean }> {
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
              return Object.values(result.data).some(
                (pr) => pr !== null && pr.state === 'open' && pr.checkStatus === 'pending'
              )
            }
            return false
          } catch {
            // PR status is nice-to-have — silently ignore errors
            return false
          }
        }
      )

      const settled = await Promise.allSettled(fetches)
      const hasPendingChecks = settled.some((item) => item.status === 'fulfilled' && item.value)
      return { hasPendingChecks }
    }

    const clearTimer = () => {
      if (!timerRef.current) return
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const schedule = (delayMs: number) => {
      if (disposed || document.hidden) return
      clearTimer()
      timerRef.current = setTimeout(() => {
        void runPoll()
      }, delayMs)
    }

    const requestImmediatePoll = () => {
      if (disposed || document.hidden) return
      if (runningRef.current) {
        queuedImmediateRef.current = true
        return
      }
      schedule(0)
    }

    async function runPoll() {
      if (disposed || document.hidden) return
      if (runningRef.current) {
        queuedImmediateRef.current = true
        return
      }

      runningRef.current = true
      let hasPendingChecks = false
      try {
        const result = await pollAll()
        hasPendingChecks = result.hasPendingChecks
      } finally {
        runningRef.current = false
      }

      if (disposed || document.hidden) return
      if (hasPendingChecks) {
        extendBurst(PENDING_BURST_MS)
      }
      if (queuedImmediateRef.current) {
        queuedImmediateRef.current = false
        schedule(0)
        return
      }
      schedule(nextIntervalMs())
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        clearTimer()
        return
      }
      extendBurst(RESUME_BURST_MS)
      requestImmediatePoll()
    }

    const onPrPollHint = (_event: Event) => {
      extendBurst(EVENT_BURST_MS)
      requestImmediatePoll()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener(PR_POLL_HINT_EVENT, onPrPollHint)
    extendBurst(STARTUP_BURST_MS)
    requestImmediatePoll()

    return () => {
      disposed = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener(PR_POLL_HINT_EVENT, onPrPollHint)
    }
  }, [])
}

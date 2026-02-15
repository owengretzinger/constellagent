import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useAppStore } from '../../store/app-store'
import styles from './TerminalPanel.module.css'

const PR_POLL_HINT_EVENT = 'constellagent:pr-poll-hint'
const PR_POLL_HINT_COMMAND_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*(?:sudo\s+)?(?:(?:git\s+push)|(?:gh\s+pr\s+(?:create|ready|reopen|merge)))(?:\s|$)/
const TERMINAL_SNAPSHOT_KEY_PREFIX = 'constellagent:terminal-snapshot:'
const TERMINAL_SNAPSHOT_VERSION = 1
const TERMINAL_SNAPSHOT_MAX_CHARS = 2_000_000

interface TerminalSnapshot {
  version: number
  updatedAt: number
  seq: number
  data: string
}

function getSnapshotKey(ptyId: string): string {
  return `${TERMINAL_SNAPSHOT_KEY_PREFIX}${ptyId}`
}

function loadTerminalSnapshot(ptyId: string): TerminalSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(getSnapshotKey(ptyId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TerminalSnapshot>
    if (parsed.version !== TERMINAL_SNAPSHOT_VERSION) return null
    if (typeof parsed.data !== 'string' || parsed.data.length === 0) return null
    if (typeof parsed.seq !== 'number' || !Number.isFinite(parsed.seq) || parsed.seq < 0) return null
    return {
      version: TERMINAL_SNAPSHOT_VERSION,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      seq: parsed.seq,
      data: parsed.data,
    }
  } catch {
    return null
  }
}

function saveTerminalSnapshot(ptyId: string, snapshot: TerminalSnapshot): void {
  try {
    window.sessionStorage.setItem(getSnapshotKey(ptyId), JSON.stringify(snapshot))
  } catch {
    // Ignore storage quota and serialization failures.
  }
}

interface Props {
  ptyId: string
  active: boolean
}

export function TerminalPanel({ ptyId, active }: Props) {
  const termDivRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitFnRef = useRef<(() => void) | null>(null)
  const inputLineRef = useRef('')
  const outputSeqRef = useRef(0)
  const flushedSeqRef = useRef(0)
  const lastStableSnapshotRef = useRef<TerminalSnapshot | null>(null)
  const terminalFontSize = useAppStore((s) => s.settings.terminalFontSize)

  const emitPrPollHint = (command: string) => {
    const normalized = command.trim().toLowerCase()
    const kind = normalized.startsWith('git push') ? 'push' : 'pr'
    window.dispatchEvent(
      new CustomEvent(PR_POLL_HINT_EVENT, {
        detail: { ptyId, command, kind },
      })
    )
  }

  const detectPrPollHint = (chunk: string) => {
    // Remove cursor-control escape sequences so arrow keys do not pollute the command buffer.
    const cleaned = chunk
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1bO./g, '')
      .replace(/\x1b./g, '')

    for (const char of cleaned) {
      if (char === '\r' || char === '\n') {
        const command = inputLineRef.current.trim()
        if (command && PR_POLL_HINT_COMMAND_RE.test(command)) {
          emitPrPollHint(command)
        }
        inputLineRef.current = ''
        continue
      }

      if (char === '\u0003' || char === '\u0015') {
        inputLineRef.current = ''
        continue
      }

      if (char === '\u007f' || char === '\b') {
        inputLineRef.current = inputLineRef.current.slice(0, -1)
        continue
      }

      if (char < ' ' || char > '~') continue
      inputLineRef.current += char
      if (inputLineRef.current.length > 512) {
        inputLineRef.current = inputLineRef.current.slice(-512)
      }
    }
  }

  useEffect(() => {
    if (!termDivRef.current) return

    const termDiv = termDivRef.current
    inputLineRef.current = ''
    outputSeqRef.current = 0
    flushedSeqRef.current = 0
    lastStableSnapshotRef.current = null

    let disposed = false
    let cleanup: (() => void) | null = null

    const setup = () => {
      try {
        termDiv.innerHTML = ''

        const term = new Terminal({
          fontSize: useAppStore.getState().settings.terminalFontSize,
          fontFamily: "'SF Mono', Menlo, 'Cascadia Code', monospace",
          cursorBlink: true,
          cursorStyle: 'bar',
          scrollback: 10000,
          theme: {
            background: '#13141b',
            foreground: '#c0caf5',
            cursor: '#c0caf5',
            selectionBackground: 'rgba(122, 162, 247, 0.2)',
            black: '#15161e',
            red: '#f7768e',
            green: '#9ece6a',
            yellow: '#e0af68',
            blue: '#7aa2f7',
            magenta: '#bb9af7',
            cyan: '#7dcfff',
            white: '#a9b1d6',
            brightBlack: '#414868',
            brightRed: '#f7768e',
            brightGreen: '#9ece6a',
            brightYellow: '#e0af68',
            brightBlue: '#7aa2f7',
            brightMagenta: '#bb9af7',
            brightCyan: '#7dcfff',
            brightWhite: '#c0caf5',
          },
        })

        const fitAddon = new FitAddon()
        const serializeAddon = new SerializeAddon()
        const webLinksAddon = new WebLinksAddon((event, uri) => {
          event.preventDefault()
          window.open(uri, '_blank')
        })
        term.loadAddon(fitAddon)
        term.loadAddon(serializeAddon)
        term.loadAddon(webLinksAddon)
        term.open(termDiv)

        if (disposed) {
          term.dispose()
          return
        }

        // During renderer reload restore, prevent resize/fit churn from racing the replay stream.
        // TUIs that do cursor-up redraws (Codex/Ink) are particularly sensitive to this.
        let allowFitAndResize = false

        const fitTerminal = (): boolean => {
          if (disposed) return false
          if (!allowFitAndResize) return false
          if (termDiv.clientWidth <= 0 || termDiv.clientHeight <= 0) return false
          fitAddon.fit()
          return true
        }
        fitFnRef.current = () => {
          fitTerminal()
        }

        // Defer fit until container has real dimensions.
        let fitAttempts = 0
        const tryFit = () => {
          if (disposed) return
          if (termDiv.clientWidth > 0 && termDiv.clientHeight > 0) {
            fitTerminal()
          } else if (++fitAttempts < 30) {
            requestAnimationFrame(tryFit)
          }
        }
        requestAnimationFrame(tryFit)

        let resizeTimer: ReturnType<typeof setTimeout> | null = null

        const resizeObserver = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => {
            if (!disposed) {
              fitTerminal()
            }
          }, 100)
        })
        resizeObserver.observe(termDiv)

        const settleTimer = setTimeout(() => {
          if (!disposed) {
            fitTerminal()
          }
        }, 200)

        let snapshotTimer: ReturnType<typeof setTimeout> | null = null
        let snapshotDirty = false

        const captureStableSnapshot = (): TerminalSnapshot | null => {
          try {
            // Avoid capturing if xterm's escape sequence parser is mid-sequence. The serialize addon
            // cannot restore parser-internal state, so restoring from that snapshot would corrupt
            // cursor-positioned TUIs after reload.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const parser = (term as any)?._core?._inputHandler?._parser
            if (parser && parser.currentState !== parser.initialState) return null

            const data = serializeAddon.serialize()
            if (!data || data.length > TERMINAL_SNAPSHOT_MAX_CHARS) return null
            return {
              version: TERMINAL_SNAPSHOT_VERSION,
              updatedAt: Date.now(),
              // `outputSeqRef` can run ahead while xterm processes its async write queue;
              // snapshotting with that seq would skip output on restore and corrupt cursor state.
              seq: flushedSeqRef.current,
              data,
            }
          } catch {
            return null
          }
        }

        const persistSnapshot = () => {
          if (!snapshotDirty) return
          snapshotDirty = false
          const attempt = () => {
            if (disposed) return
            const snapshot = captureStableSnapshot()
            if (!snapshot) {
              // Retry quickly; we may have caught the PTY output stream mid-escape-sequence.
              schedulePersistSnapshot(50)
              return
            }
            lastStableSnapshotRef.current = snapshot
            saveTerminalSnapshot(ptyId, snapshot)
          }

          // Flush xterm's write buffer before serializing to avoid capturing half-applied frames.
          try {
            term.write('', attempt)
          } catch {
            attempt()
          }
        }
        const schedulePersistSnapshot = (delayMs = 750) => {
          snapshotDirty = true
          if (snapshotTimer) return
          snapshotTimer = setTimeout(() => {
            snapshotTimer = null
            persistSnapshot()
          }, delayMs)
        }

        const onDataDisposable = term.onData((data: string) => {
          detectPrPollHint(data)
          window.api.pty.write(ptyId, data)
        })

        const onResizeDisposable = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          if (!allowFitAndResize) return
          window.api.pty.resize(ptyId, cols, rows)
        })

        const snapshot = loadTerminalSnapshot(ptyId)
        const snapshotSeq = snapshot?.seq ?? 0
        outputSeqRef.current = snapshotSeq
        flushedSeqRef.current = snapshotSeq

        let restoring = true
        const bufferedOutput: Array<{ startSeq?: number; data: string }> = []

        const applyPtyOutput = (data: string, startSeq?: number) => {
          if (!data) return

          if (typeof startSeq !== 'number' || !Number.isFinite(startSeq)) {
            const nextSeq = outputSeqRef.current + data.length
            outputSeqRef.current = nextSeq
            term.write(data, () => {
              flushedSeqRef.current = Math.max(flushedSeqRef.current, nextSeq)
            })
            schedulePersistSnapshot()
            return
          }

          const currentSeq = outputSeqRef.current
          const chunkEnd = startSeq + data.length

          // Entire chunk is already applied (duplicate).
          if (chunkEnd <= currentSeq) return

          let slice = data
          let appliedStart = startSeq

          // Partial overlap: drop already-applied prefix.
          if (startSeq < currentSeq) {
            const offset = currentSeq - startSeq
            slice = data.slice(offset)
            appliedStart = currentSeq
          }

          // If there's a gap (we missed output), writing this chunk may still look
          // wrong, but we prefer forward progress over stalling.
          const nextSeq = appliedStart + slice.length
          outputSeqRef.current = nextSeq
          term.write(slice, () => {
            flushedSeqRef.current = Math.max(flushedSeqRef.current, nextSeq)
          })
          schedulePersistSnapshot()
        }

        const unsubData = window.api.pty.onData(ptyId, (data: string, startSeq?: number) => {
          if (disposed) return
          if (restoring) {
            bufferedOutput.push({ startSeq, data })
            return
          }
          applyPtyOutput(data, startSeq)
        })

        const onBeforeUnload = () => {
          const snapshot = lastStableSnapshotRef.current ?? captureStableSnapshot()
          if (snapshot) saveTerminalSnapshot(ptyId, snapshot)
        }
        window.addEventListener('beforeunload', onBeforeUnload)

        // Restore xterm state from sessionStorage snapshot (fast path) and then
        // replay any PTY output that occurred while the renderer was reloading.
        window.api.pty
          .reattach(ptyId, snapshotSeq)
          .then(async (res) => {
            if (disposed) return
            if (!res.ok) return

            // Restore into a terminal of the same size as the running PTY.
            // The serialize addon expects this for correct cursor positioning.
            if (Number.isFinite(res.cols) && Number.isFinite(res.rows) && res.cols > 0 && res.rows > 0) {
              term.resize(res.cols, res.rows)
            }

            // If main truncated the replay buffer past our snapshot, the snapshot is too old
            // to be safely applied without duplication. Fall back to replay-only.
            const canUseSnapshot = !!snapshot && !res.truncated

            const writeToTerm = (data: string) =>
              new Promise<void>((resolve) => {
                term.write(data, () => resolve())
              })

            if (canUseSnapshot) {
              term.reset()
              await writeToTerm(snapshot.data)
            }

            if (res.replay) {
              if (!canUseSnapshot) {
                term.reset()
              }
              await writeToTerm(res.replay)
            }

            outputSeqRef.current = res.endSeq
            flushedSeqRef.current = Math.max(flushedSeqRef.current, res.endSeq)
          })
          .catch(() => {})
          .finally(() => {
            // Flush any output that arrived while we were restoring/replaying.
            restoring = false
            if (disposed) return
            if (bufferedOutput.length > 0) {
              bufferedOutput.sort((a, b) => {
                if (typeof a.startSeq === 'number' && typeof b.startSeq === 'number') {
                  return a.startSeq - b.startSeq
                }
                if (typeof a.startSeq === 'number') return -1
                if (typeof b.startSeq === 'number') return 1
                return 0
              })
              for (const chunk of bufferedOutput) {
                applyPtyOutput(chunk.data, chunk.startSeq)
              }
              bufferedOutput.length = 0
            }

            allowFitAndResize = true
            fitTerminal()
            schedulePersistSnapshot()
          })

        termRef.current = term

        cleanup = () => {
          const snapshot = lastStableSnapshotRef.current ?? captureStableSnapshot()
          if (snapshot) saveTerminalSnapshot(ptyId, snapshot)
          if (snapshotTimer) clearTimeout(snapshotTimer)
          resizeObserver.disconnect()
          if (resizeTimer) clearTimeout(resizeTimer)
          clearTimeout(settleTimer)
          onDataDisposable.dispose()
          onResizeDisposable.dispose()
          unsubData()
          window.removeEventListener('beforeunload', onBeforeUnload)
          term.dispose()
        }

        setTimeout(() => {
          if (!disposed && active) term.focus()
        }, 50)
      } catch (err) {
        console.error('Failed to initialize terminal:', err)
      }
    }

    setup()

    return () => {
      disposed = true
      cleanup?.()
      cleanup = null
      termRef.current = null
      fitFnRef.current = null
      inputLineRef.current = ''
    }
  }, [ptyId])

  // Update font size on live terminals.
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    term.options.fontSize = terminalFontSize
    fitFnRef.current?.()
  }, [terminalFontSize])

  // Focus + refit when this tab becomes active.
  useEffect(() => {
    if (!active || !termRef.current) return

    fitFnRef.current?.()
    termRef.current.focus()
  }, [active])

  return (
    <div className={`${styles.terminalContainer} ${active ? styles.active : styles.hidden}`}>
      {/* Separate div for xterm — not managed by React. */}
      <div ref={termDivRef} className={styles.terminalInner} />
    </div>
  )
}

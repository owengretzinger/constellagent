import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { useResolvedTheme } from '../../hooks/useResolvedTheme'
import styles from './TerminalPanel.module.css'

const PR_POLL_HINT_EVENT = 'constellagent:pr-poll-hint'
const PR_POLL_HINT_COMMAND_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*(?:sudo\s+)?(?:(?:git\s+push)|(?:gh\s+pr\s+(?:create|ready|reopen|merge)))(?:\s|$)/

// Terminal color palettes
const DARK_THEME = {
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
}

const LIGHT_THEME = {
  background: '#e9e9ed',
  foreground: '#343b58',
  cursor: '#343b58',
  selectionBackground: 'rgba(46, 125, 233, 0.2)',
  black: '#d5d6db',
  red: '#f52a65',
  green: '#587539',
  yellow: '#8c6c3e',
  blue: '#2e7de9',
  magenta: '#9854f1',
  cyan: '#007197',
  white: '#5a607d',
  brightBlack: '#b8bdd4',
  brightRed: '#f52a65',
  brightGreen: '#587539',
  brightYellow: '#8c6c3e',
  brightBlue: '#2e7de9',
  brightMagenta: '#9854f1',
  brightCyan: '#007197',
  brightWhite: '#343b58',
}

interface Props {
  ptyId: string
  active: boolean
}

export function TerminalPanel({ ptyId, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termDivRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<any>(null)
  const fitFnRef = useRef<(() => void) | null>(null)
  const inputLineRef = useRef('')
  const [loading, setLoading] = useState(true)
  const terminalFontSize = useAppStore((s) => s.settings.terminalFontSize)
  const resolvedTheme = useResolvedTheme()

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

  // Single effect for terminal lifecycle — StrictMode safe
  useEffect(() => {
    if (!termDivRef.current) return
    const termDiv = termDivRef.current!
    inputLineRef.current = ''

    let disposed = false
    let cleanup: (() => void) | null = null

    async function setup() {
      try {
        const ghostty = await import('ghostty-web')
        await ghostty.init()

        if (disposed) return

        // Clear any leftover DOM from a previous terminal instance
        termDiv.innerHTML = ''

        const term = new ghostty.Terminal({
          fontSize: useAppStore.getState().settings.terminalFontSize,
          fontFamily: "'SF Mono', Menlo, 'Cascadia Code', monospace",
          cursorBlink: true,
          cursorStyle: 'bar',
          scrollback: 10000,
          theme: resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME,
        })

        term.open(termDiv)

        if (disposed) {
          term.dispose()
          return
        }

        // ghostty-web's FitAddon reserves 15px for a scrollbar, which creates
        // a visible empty strip on the right edge in this layout. Fit using
        // the real container width so the canvas reaches the pane divider.
        const fitTerminal = () => {
          const renderer = term.renderer
          const metrics = renderer?.getMetrics?.()
          if (!metrics?.width || !metrics?.height) return

          const styles = window.getComputedStyle(termDiv)
          const paddingTop = Number.parseInt(styles.getPropertyValue('padding-top'), 10) || 0
          const paddingBottom = Number.parseInt(styles.getPropertyValue('padding-bottom'), 10) || 0
          const paddingLeft = Number.parseInt(styles.getPropertyValue('padding-left'), 10) || 0
          const paddingRight = Number.parseInt(styles.getPropertyValue('padding-right'), 10) || 0

          const availableWidth = termDiv.clientWidth - paddingLeft - paddingRight
          const availableHeight = termDiv.clientHeight - paddingTop - paddingBottom
          if (availableWidth <= 0 || availableHeight <= 0) return

          const cols = Math.max(2, Math.floor(availableWidth / metrics.width))
          const rows = Math.max(1, Math.floor(availableHeight / metrics.height))
          if (cols !== term.cols || rows !== term.rows) {
            term.resize(cols, rows)
          }
        }
        fitFnRef.current = fitTerminal

        // Defer fit until container has real dimensions
        let fitAttempts = 0
        function tryFit() {
          if (disposed) return
          if (termDiv.clientWidth > 0 && termDiv.clientHeight > 0) {
            fitTerminal()
            setLoading(false)
          } else if (++fitAttempts < 30) {
            requestAnimationFrame(tryFit)
          } else {
            setLoading(false)
          }
        }
        requestAnimationFrame(tryFit)

        // Own ResizeObserver instead of fitAddon.observeResize() — ghostty's
        // built-in observer silently drops resize events that fire during its
        // 50ms _isResizing lock, causing the terminal to stay at a wrong width
        // when Allotment settles after the initial fit.
        let resizeTimer: ReturnType<typeof setTimeout>
        const resizeObserver = new ResizeObserver(() => {
          clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => {
            if (!disposed) fitTerminal()
          }, 150)
        })
        resizeObserver.observe(termDiv)

        // Delayed refit — catches cases where the container was already the
        // right size but ghostty-web's renderer metrics weren't ready yet
        // (font not measured, canvas not initialized). The ResizeObserver
        // won't fire in that case because the container never changes size.
        const settleTimer = setTimeout(() => {
          if (!disposed) fitTerminal()
        }, 500)

        // Connect to PTY via IPC
        term.onData((data: string) => {
          detectPrPollHint(data)
          window.api.pty.write(ptyId, data)
        })

        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          window.api.pty.resize(ptyId, cols, rows)
        })

        const unsubData = window.api.pty.onData(ptyId, (data: string) => {
          if (disposed) return
          term.write(data)
        })

        termRef.current = term

        cleanup = () => {
          resizeObserver.disconnect()
          clearTimeout(resizeTimer)
          clearTimeout(settleTimer)
          unsubData()
          term.dispose()
        }

        setTimeout(() => {
          if (!disposed) term.focus()
        }, 50)
      } catch (err) {
        console.error('Failed to initialize terminal:', err)
        if (!disposed) setLoading(false)
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
  }, [ptyId, resolvedTheme])

  // Update font size on live terminals
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      term.setOption('fontSize', terminalFontSize)
      fitFnRef.current?.()
    } catch {
      // ghostty-web may not support setOption — font applies on next terminal create
    }
  }, [terminalFontSize])

  // Focus + refit when this tab becomes active
  useEffect(() => {
    if (!active || !termRef.current) return

    // Terminals keep real dimensions via visibility:hidden, so fit is reliable
    fitFnRef.current?.()
    termRef.current?.focus()
  }, [active])

  return (
    <div
      className={`${styles.terminalContainer} ${active ? styles.active : styles.hidden}`}
      ref={containerRef}
    >
      {/* Separate div for ghostty-web — not managed by React */}
      <div ref={termDivRef} className={styles.terminalInner} />
      {loading && (
        <div className={styles.loading}>
          <span className={styles.loadingDot}>●</span>
          &nbsp;Loading terminal...
        </div>
      )}
    </div>
  )
}

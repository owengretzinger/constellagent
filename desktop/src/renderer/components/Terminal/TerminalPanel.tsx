import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useAppStore } from '../../store/app-store'
import styles from './TerminalPanel.module.css'

const PR_POLL_HINT_EVENT = 'constellagent:pr-poll-hint'
const PR_POLL_HINT_COMMAND_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*(?:sudo\s+)?(?:(?:git\s+push)|(?:gh\s+pr\s+(?:create|ready|reopen|merge)))(?:\s|$)/

interface Props {
  ptyId: string
  active: boolean
}

export function TerminalPanel({ ptyId, active }: Props) {
  const termDivRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitFnRef = useRef<(() => void) | null>(null)
  const inputLineRef = useRef('')
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
        const webLinksAddon = new WebLinksAddon((event, uri) => {
          event.preventDefault()
          window.open(uri, '_blank')
        })
        term.loadAddon(fitAddon)
        term.loadAddon(webLinksAddon)
        term.open(termDiv)

        if (disposed) {
          term.dispose()
          return
        }

        const fitTerminal = () => {
          if (disposed) return
          if (termDiv.clientWidth <= 0 || termDiv.clientHeight <= 0) return
          fitAddon.fit()
        }
        fitFnRef.current = fitTerminal

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
            if (!disposed) fitTerminal()
          }, 100)
        })
        resizeObserver.observe(termDiv)

        const settleTimer = setTimeout(() => {
          if (!disposed) fitTerminal()
        }, 200)

        const onDataDisposable = term.onData((data: string) => {
          detectPrPollHint(data)
          window.api.pty.write(ptyId, data)
        })

        const onResizeDisposable = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          window.api.pty.resize(ptyId, cols, rows)
        })

        const unsubData = window.api.pty.onData(ptyId, (data: string) => {
          if (disposed) return
          term.write(data)
        })

        termRef.current = term

        cleanup = () => {
          resizeObserver.disconnect()
          if (resizeTimer) clearTimeout(resizeTimer)
          clearTimeout(settleTimer)
          onDataDisposable.dispose()
          onResizeDisposable.dispose()
          unsubData()
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

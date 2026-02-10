import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import styles from './TerminalPanel.module.css'

interface Props {
  ptyId: string
  active: boolean
}

export function TerminalPanel({ ptyId, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termDivRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<any>(null)
  const fitAddonRef = useRef<any>(null)
  const [loading, setLoading] = useState(true)
  const terminalFontSize = useAppStore((s) => s.settings.terminalFontSize)

  // Single effect for terminal lifecycle — StrictMode safe
  useEffect(() => {
    if (!termDivRef.current) return
    const termDiv = termDivRef.current!

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

        const fitAddon = new ghostty.FitAddon()
        term.loadAddon(fitAddon)

        term.open(termDiv)

        if (disposed) {
          term.dispose()
          return
        }

        // Defer fit until container has real dimensions
        let fitAttempts = 0
        function tryFit() {
          if (disposed) return
          if (termDiv.clientWidth > 0 && termDiv.clientHeight > 0) {
            fitAddon.fit()
            setLoading(false)
          } else if (++fitAttempts < 30) {
            requestAnimationFrame(tryFit)
          } else {
            setLoading(false)
          }
        }
        requestAnimationFrame(tryFit)

        if (fitAddon.observeResize) {
          fitAddon.observeResize()
        }

        // Connect to PTY via IPC
        term.onData((data: string) => {
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
        fitAddonRef.current = fitAddon

        cleanup = () => {
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
      fitAddonRef.current = null
    }
  }, [ptyId])

  // Update font size on live terminals
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      term.setOption('fontSize', terminalFontSize)
      fitAddonRef.current?.fit()
    } catch {
      // ghostty-web may not support setOption — font applies on next terminal create
    }
  }, [terminalFontSize])

  // Focus + refit when this tab becomes active
  useEffect(() => {
    if (!active || !termRef.current) return

    // Terminals keep real dimensions via visibility:hidden, so fit is reliable
    fitAddonRef.current?.fit()
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

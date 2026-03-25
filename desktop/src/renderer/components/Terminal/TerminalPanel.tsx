import { useEffect, useRef, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useAppStore } from '../../store/app-store'
import { CONSTELLAGENT_PATH_MIME, wrapBracketedPaste } from '../../utils/add-to-chat'
import styles from './TerminalPanel.module.css'

const TAB_TITLE_LOG = '[constellagent:tab-title]'

const PR_POLL_HINT_EVENT = 'constellagent:pr-poll-hint'
const PR_POLL_HINT_COMMAND_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*(?:sudo\s+)?(?:(?:git\s+push)|(?:gh\s+pr\s+(?:create|ready|reopen|merge)))(?:\s|$)/

interface Props {
  ptyId: string
  active: boolean
  /** When rendered inside a split container, uses relative positioning */
  inSplit?: boolean
  /** Pane ID for focus tracking inside splits */
  paneId?: string
  /** Called when this pane receives focus (for split focus tracking) */
  onFocus?: (paneId: string) => void
  /** Whether this pane is the focused pane within a split */
  isFocusedPane?: boolean
}

export function TerminalPanel({ ptyId, active, inSplit, paneId, onFocus, isFocusedPane }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
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

  const detectPrPollHint = (chunk: string): string | undefined => {
    // Remove cursor-control escape sequences so arrow keys do not pollute the command buffer.
    const cleaned = chunk
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1bO./g, '')
      .replace(/\x1b./g, '')

    let codexTabLine: string | undefined

    for (const char of cleaned) {
      if (char === '\r' || char === '\n') {
        const command = inputLineRef.current.trim()
        // Codex TUI: PTY write is often newline-only — bundle the local line on PTY_WRITE so main can derive the tab title with the same IPC as write().
        if (command.length >= 3 && !/^(y|n|p|yes|no)$/i.test(command)) {
          codexTabLine = command
        }
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

    return codexTabLine
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
            background: '#111111',
            foreground: '#eeeeee',
            cursor: '#eeeeee',
            selectionBackground: 'rgba(255, 255, 255, 0.15)',
            black: '#2a2a2a',
            red: '#BF616A',
            green: '#A3BE8C',
            yellow: '#EBCB8B',
            blue: '#81A1C1',
            magenta: '#B48EAD',
            cyan: '#88C0D0',
            white: '#eeeeee',
            brightBlack: '#505050',
            brightRed: '#D08770',
            brightGreen: '#B4C99A',
            brightYellow: '#F5DDA0',
            brightBlue: '#8FAFD7',
            brightMagenta: '#C49BBF',
            brightCyan: '#9DD0DE',
            brightWhite: '#fafafa',
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
          const codexTabLine = detectPrPollHint(data)
          const newlineOnlyChunk = /^[\r\n]+$/.test(data)
          if (newlineOnlyChunk) {
            if (codexTabLine !== undefined) {
              console.log(TAB_TITLE_LOG, 'renderer: newline-only PTY write, bundling local line for main codex title path', {
                ptyId,
                preview: codexTabLine.slice(0, 72),
              })
            } else {
              console.log(TAB_TITLE_LOG, 'renderer: newline-only PTY write, no bundled line (short/empty/y-n prompt buffer)', {
                ptyId,
              })
            }
          }
          window.api.pty.write(
            ptyId,
            data,
            codexTabLine !== undefined ? { submittedLine: codexTabLine } : undefined,
          )
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

  // Focus terminal when this pane becomes the focused pane in a split (e.g. Ctrl+Tab)
  useEffect(() => {
    if (inSplit && isFocusedPane && termRef.current) {
      termRef.current.focus()
    }
  }, [inSplit, isFocusedPane])

  const handleMouseDown = () => {
    if (paneId && onFocus) onFocus(paneId)
  }

  const handleDragOver = (e: DragEvent) => {
    if (
      e.dataTransfer.types.includes(CONSTELLAGENT_PATH_MIME)
      || e.dataTransfer.types.includes('text/plain')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDrop = (e: DragEvent) => {
    const path =
      e.dataTransfer.getData(CONSTELLAGENT_PATH_MIME)
      || e.dataTransfer.getData('text/plain')
    if (!path?.trim()) return
    e.preventDefault()
    window.api.pty.write(ptyId, wrapBracketedPaste(path.trim()))
  }

  // In split mode: relative positioning, no visibility toggling (parent handles that)
  // In standalone mode: absolute-fill with visibility toggling
  const containerClass = inSplit
    ? `${styles.splitPane} ${isFocusedPane ? styles.focusedPane : ''}`
    : `${styles.terminalContainer} ${active ? styles.active : styles.hidden}`

  return (
    <div
      className={containerClass}
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Separate div for xterm — not managed by React. */}
      <div ref={termDivRef} className={styles.terminalInner} />
    </div>
  )
}

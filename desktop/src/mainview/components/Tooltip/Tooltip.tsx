import { useState, useRef, useCallback, useEffect, useLayoutEffect, cloneElement } from 'react'
import { createPortal } from 'react-dom'
import styles from './Tooltip.module.css'

interface Props {
  label: string
  shortcut?: string
  position?: 'top' | 'bottom'
  children: React.ReactElement<Record<string, unknown>>
}

const SHOW_DELAY = 400
const EDGE_PAD = 8
const GAP = 6
const TOOLTIP_HEIGHT_EST = 28

export function Tooltip({ label, shortcut, position = 'top', children }: Props) {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState({ x: 0, y: 0 })
  const [resolvedPos, setResolvedPos] = useState(position)
  const elRef = useRef<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const show = useCallback(() => {
    clearTimeout(showTimer.current)
    showTimer.current = setTimeout(() => {
      if (!elRef.current) return
      const rect = elRef.current.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return

      // Auto-flip if not enough space in preferred direction
      let pos = position
      if (pos === 'top' && rect.top - TOOLTIP_HEIGHT_EST - GAP < 0) {
        pos = 'bottom'
      } else if (pos === 'bottom' && rect.bottom + TOOLTIP_HEIGHT_EST + GAP > window.innerHeight) {
        pos = 'top'
      }

      setResolvedPos(pos)
      setCoords({
        x: rect.left + rect.width / 2,
        y: pos === 'top' ? rect.top - GAP : rect.bottom + GAP,
      })
      setVisible(true)
    }, SHOW_DELAY)
  }, [position])

  const hide = useCallback(() => {
    clearTimeout(showTimer.current)
    setVisible(false)
  }, [])

  useEffect(() => {
    return () => clearTimeout(showTimer.current)
  }, [])

  // Clamp tooltip to viewport left/right edges before paint
  useLayoutEffect(() => {
    if (!visible || !tooltipRef.current) return
    const tip = tooltipRef.current
    const rect = tip.getBoundingClientRect()

    if (rect.left < EDGE_PAD) {
      tip.style.left = `${coords.x + (EDGE_PAD - rect.left)}px`
    } else if (rect.right > window.innerWidth - EDGE_PAD) {
      tip.style.left = `${coords.x - (rect.right - window.innerWidth + EDGE_PAD)}px`
    }
  }, [visible, coords.x])

  // Merge our ref with any existing ref on the child
  const setRef = useCallback((node: HTMLElement | null) => {
    elRef.current = node
    const childRef = (children as { ref?: React.Ref<HTMLElement> }).ref
    if (typeof childRef === 'function') childRef(node)
    else if (childRef && typeof childRef === 'object') {
      (childRef as React.MutableRefObject<HTMLElement | null>).current = node
    }
  }, [children])

  const child = cloneElement(children, {
    ref: setRef,
    onMouseEnter: (e: React.MouseEvent) => {
      show()
      const orig = children.props.onMouseEnter as ((e: React.MouseEvent) => void) | undefined
      orig?.(e)
    },
    onMouseLeave: (e: React.MouseEvent) => {
      hide()
      const orig = children.props.onMouseLeave as ((e: React.MouseEvent) => void) | undefined
      orig?.(e)
    },
    onMouseDown: (e: React.MouseEvent) => {
      hide()
      const orig = children.props.onMouseDown as ((e: React.MouseEvent) => void) | undefined
      orig?.(e)
    },
  })

  return (
    <>
      {child}
      {visible && createPortal(
        <div
          ref={tooltipRef}
          className={`${styles.tooltip} ${resolvedPos === 'bottom' ? styles.bottom : styles.top}`}
          style={{ left: coords.x, top: coords.y }}
        >
          <span className={styles.label}>{label}</span>
          {shortcut && <kbd className={styles.kbd}>{shortcut}</kbd>}
        </div>,
        document.body,
      )}
    </>
  )
}

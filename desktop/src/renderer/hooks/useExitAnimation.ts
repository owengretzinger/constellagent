import { useState, useEffect, useRef } from 'react'

type AnimState = 'enter' | 'exit' | 'idle'

/**
 * Delays unmounting by `duration` ms so CSS exit keyframes can play.
 *
 * Usage:
 *   const { shouldRender, animating } = useExitAnimation(isOpen, 200)
 *   if (!shouldRender) return null
 *   return <div className={animating === 'exit' ? styles.exiting : ''}>…</div>
 */
export function useExitAnimation(visible: boolean, duration = 200) {
  const [shouldRender, setShouldRender] = useState(visible)
  const [animating, setAnimating] = useState<AnimState>(visible ? 'enter' : 'idle')
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    clearTimeout(timerRef.current)

    if (visible) {
      setShouldRender(true)
      setAnimating('enter')
    } else if (shouldRender) {
      setAnimating('exit')
      timerRef.current = setTimeout(() => {
        setShouldRender(false)
        setAnimating('idle')
      }, duration)
    }

    return () => clearTimeout(timerRef.current)
  }, [visible, duration]) // eslint-disable-line react-hooks/exhaustive-deps

  return { shouldRender, animating }
}

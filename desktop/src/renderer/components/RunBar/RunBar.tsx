import { useAppStore } from '../../store/app-store'
import styles from './RunBar.module.css'

export function RunBar() {
  const executeRunHook = useAppStore((s) => s.executeRunHook)

  return (
    <div className={styles.runBar}>
      <button className={styles.runButton} onClick={() => executeRunHook()}>
        <span className={styles.runIcon}>▶</span>
        <span>Run</span>
        <span className={styles.shortcut}>⌘R</span>
      </button>
    </div>
  )
}

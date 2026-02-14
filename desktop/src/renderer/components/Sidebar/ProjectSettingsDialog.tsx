import { useState, useCallback } from 'react'
import type { Project, PrLinkProvider, StartupCommand } from '../../store/types'
import styles from './ProjectSettingsDialog.module.css'

interface Props {
  project: Project
  onSave: (settings: { startupCommands: StartupCommand[]; prLinkProvider: PrLinkProvider }) => void
  onCancel: () => void
}

export function ProjectSettingsDialog({ project, onSave, onCancel }: Props) {
  const [commands, setCommands] = useState<StartupCommand[]>(
    project.startupCommands?.length ? [...project.startupCommands] : []
  )
  const [prLinkProvider, setPrLinkProvider] = useState<PrLinkProvider>(
    project.prLinkProvider ?? 'github'
  )

  const handleAdd = useCallback(() => {
    setCommands((prev) => [...prev, { name: '', command: '' }])
  }, [])

  const handleRemove = useCallback((index: number) => {
    setCommands((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleChange = useCallback((index: number, field: keyof StartupCommand, value: string) => {
    setCommands((prev) =>
      prev.map((cmd, i) => (i === index ? { ...cmd, [field]: value } : cmd))
    )
  }, [])

  const handleSave = useCallback(() => {
    // Filter out entries with no command
    const filtered = commands.filter((c) => c.command.trim())
    onSave({
      startupCommands: filtered.length > 0 ? filtered : [],
      prLinkProvider,
    })
  }, [commands, onSave, prLinkProvider])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    },
    [onCancel]
  )

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className={styles.title}>{project.name}</div>

        <label className={styles.label}>Startup Commands</label>
        <div className={styles.hint}>
          Run in separate terminals when creating a workspace.
        </div>

        <div className={styles.commandList}>
          {commands.map((cmd, i) => (
            <div key={i} className={styles.commandRow}>
              <input
                className={`${styles.input} ${styles.nameInput}`}
                value={cmd.name}
                onChange={(e) => handleChange(i, 'name', e.target.value)}
                placeholder="Tab name"
              />
              <input
                className={styles.input}
                value={cmd.command}
                onChange={(e) => handleChange(i, 'command', e.target.value)}
                placeholder="command"
                autoFocus={i === commands.length - 1}
              />
              <button
                className={styles.removeBtn}
                onClick={() => handleRemove(i)}
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}

          <button className={styles.addBtn} onClick={handleAdd}>
            <span>+</span>
            <span>Add command</span>
          </button>
        </div>

        <label className={styles.label}>PR Link Provider</label>
        <div className={styles.hint}>
          Where this project opens pull request links.
        </div>
        <select
          className={styles.selectInput}
          value={prLinkProvider}
          onChange={(e) => setPrLinkProvider(e.target.value as PrLinkProvider)}
        >
          <option value="github">GitHub</option>
          <option value="graphite">Graphite</option>
          <option value="devinreview">Devin Review</option>
        </select>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </button>
          <button className={styles.saveBtn} onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

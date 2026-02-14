import { useState, useCallback } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Project, PrLinkProvider, StartupCommand } from '../../store/types'
import styles from './ProjectSettingsDialog.module.css'

interface Props {
  project: Project
  onSave: (settings: { startupCommands: StartupCommand[]; prLinkProvider: PrLinkProvider }) => void
  onCancel: () => void
}

export function ProjectSettingsDialog({ project, onSave, onCancel }: Props) {
  const { settings, addToast } = useAppStore()
  const [commands, setCommands] = useState<StartupCommand[]>(
    project.startupCommands?.length ? [...project.startupCommands] : []
  )
  const [syncing, setSyncing] = useState(false)
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

        <label className={styles.label}>Skills & Subagents</label>
        <div className={styles.hint}>
          Sync enabled skills and subagents to this project's agent directories.
        </div>
        <div className={styles.commandList}>
          {settings.skills.filter((s) => s.enabled).length === 0 && settings.subagents.filter((s) => s.enabled).length === 0 ? (
            <div className={styles.hint}>No enabled skills or subagents. Configure them in Settings.</div>
          ) : (
            <>
              {settings.skills.filter((s) => s.enabled).map((s) => (
                <div key={s.id} className={styles.commandRow}>
                  <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)' }}>
                    {s.name} <span style={{ color: 'var(--text-ghost)' }}>(skill)</span>
                  </span>
                </div>
              ))}
              {settings.subagents.filter((s) => s.enabled).map((s) => (
                <div key={s.id} className={styles.commandRow}>
                  <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)' }}>
                    {s.name} <span style={{ color: 'var(--text-ghost)' }}>(subagent)</span>
                  </span>
                </div>
              ))}
            </>
          )}
          <button
            className={styles.addBtn}
            disabled={syncing}
            onClick={async () => {
              setSyncing(true)
              try {
                for (const skill of settings.skills.filter((s) => s.enabled)) {
                  await window.api.skills.sync(skill.sourcePath, project.repoPath)
                }
                for (const sa of settings.subagents.filter((s) => s.enabled)) {
                  await window.api.subagents.sync(sa.sourcePath, project.repoPath)
                }
                addToast({ id: crypto.randomUUID(), message: 'Skills & subagents synced to project', type: 'info' })
              } catch {
                addToast({ id: crypto.randomUUID(), message: 'Failed to sync skills', type: 'error' })
              } finally {
                setSyncing(false)
              }
            }}
          >
            <span>{syncing ? 'Syncing...' : 'Sync to Project'}</span>
          </button>
        </div>

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

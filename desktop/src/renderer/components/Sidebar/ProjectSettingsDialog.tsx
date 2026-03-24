import { useState, useCallback } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Project, PrLinkProvider, StartupCommand, WaitCondition } from '../../store/types'
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

  const handleWaitForChange = useCallback((index: number, waitFor: string) => {
    setCommands((prev) =>
      prev.map((cmd, i) => {
        if (i !== index) return cmd
        if (!waitFor) {
          const { waitFor: _wf, waitCondition: _wc, ...rest } = cmd
          return rest
        }
        return { ...cmd, waitFor, waitCondition: cmd.waitCondition ?? { type: 'delay', seconds: 3 } }
      })
    )
  }, [])

  const handleConditionChange = useCallback((index: number, condition: WaitCondition) => {
    setCommands((prev) =>
      prev.map((cmd, i) => (i === index ? { ...cmd, waitCondition: condition } : cmd))
    )
  }, [])

  const handleSave = useCallback(() => {
    // Filter out entries with no command
    const filtered = commands.filter((c) => c.command.trim())

    // Clean stale waitFor references
    const names = new Set(filtered.map((c) => c.name).filter(Boolean))
    const cleaned: StartupCommand[] = filtered.map((cmd) => {
      if (cmd.waitFor && !names.has(cmd.waitFor)) {
        const { waitFor: _wf, waitCondition: _wc, ...rest } = cmd
        return rest
      }
      return cmd
    })

    // Detect circular dependencies (DFS)
    const hasCycle = (): boolean => {
      const graph = new Map<string, string>()
      for (const cmd of cleaned) {
        if (cmd.name && cmd.waitFor) graph.set(cmd.name, cmd.waitFor)
      }
      for (const start of graph.keys()) {
        const visited = new Set<string>()
        let cur: string | undefined = start
        while (cur && graph.has(cur)) {
          if (visited.has(cur)) return true
          visited.add(cur)
          cur = graph.get(cur)
        }
      }
      return false
    }

    if (hasCycle()) {
      addToast({ id: crypto.randomUUID(), message: 'Circular dependency detected in startup commands', type: 'error' })
      return
    }

    onSave({
      startupCommands: cleaned.length > 0 ? cleaned : [],
      prLinkProvider,
    })
  }, [commands, onSave, prLinkProvider, addToast])

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
          {commands.map((cmd, i) => {
            const otherNames = commands
              .filter((_, j) => j !== i)
              .map((c) => c.name)
              .filter(Boolean)
            return (
              <div key={i} className={styles.commandBlock}>
                <div className={styles.commandRow}>
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
                {otherNames.length > 0 && (
                  <div className={styles.waitRow}>
                    <span className={styles.waitLabel}>Wait for</span>
                    <select
                      className={styles.waitSelect}
                      value={cmd.waitFor ?? ''}
                      onChange={(e) => handleWaitForChange(i, e.target.value)}
                    >
                      <option value="">None</option>
                      {otherNames.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    {cmd.waitFor && (
                      <>
                        <select
                          className={styles.waitSelect}
                          value={cmd.waitCondition?.type ?? 'delay'}
                          onChange={(e) => {
                            const t = e.target.value as 'delay' | 'output'
                            handleConditionChange(i, t === 'delay' ? { type: 'delay', seconds: 3 } : { type: 'output', pattern: '' })
                          }}
                        >
                          <option value="delay">Delay</option>
                          <option value="output">Output match</option>
                        </select>
                        {cmd.waitCondition?.type === 'delay' && (
                          <input
                            className={styles.conditionInput}
                            type="number"
                            min={1}
                            value={(cmd.waitCondition as { seconds: number }).seconds}
                            onChange={(e) => handleConditionChange(i, { type: 'delay', seconds: Math.max(1, parseInt(e.target.value) || 1) })}
                            title="Seconds to wait"
                          />
                        )}
                        {cmd.waitCondition?.type === 'output' && (
                          <input
                            className={styles.conditionInput}
                            value={(cmd.waitCondition as { pattern: string }).pattern}
                            onChange={(e) => handleConditionChange(i, { type: 'output', pattern: e.target.value })}
                            placeholder="pattern"
                          />
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}

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

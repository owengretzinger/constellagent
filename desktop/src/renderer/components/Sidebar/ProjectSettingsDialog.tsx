import { useState, useCallback } from 'react'
import { HookType } from '../../store/types'
import type { Project, StartupCommand, ProjectHook } from '../../store/types'
import styles from './ProjectSettingsDialog.module.css'

const ALL_HOOK_TYPES: { type: HookType; label: string }[] = [
  { type: HookType.Setup, label: 'Setup' },
  { type: HookType.Run, label: 'Run' },
  { type: HookType.Archive, label: 'Archive' },
]

interface Props {
  project: Project
  onSave: (commands: StartupCommand[], hooks: ProjectHook[]) => void
  onCancel: () => void
}

export function ProjectSettingsDialog({ project, onSave, onCancel }: Props) {
  const [commands, setCommands] = useState<StartupCommand[]>(
    project.startupCommands?.length ? [...project.startupCommands] : []
  )

  const [hooks, setHooks] = useState<ProjectHook[]>(
    project.hooks?.length ? [...project.hooks] : []
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

  const availableHookTypes = ALL_HOOK_TYPES.filter(
    ({ type }) => !hooks.some((h) => h.type === type)
  )

  const handleAddHook = useCallback(() => {
    setHooks((prev) => {
      const used = new Set(prev.map((h) => h.type))
      const next = ALL_HOOK_TYPES.find(({ type }) => !used.has(type))
      if (!next) return prev
      return [...prev, { type: next.type, command: '' }]
    })
  }, [])

  const handleRemoveHook = useCallback((index: number) => {
    setHooks((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleHookTypeChange = useCallback((index: number, type: HookType) => {
    setHooks((prev) =>
      prev.map((h, i) => (i === index ? { ...h, type } : h))
    )
  }, [])

  const handleHookCommandChange = useCallback((index: number, command: string) => {
    setHooks((prev) =>
      prev.map((h, i) => (i === index ? { ...h, command } : h))
    )
  }, [])

  const handleSave = useCallback(() => {
    const filtered = commands.filter((c) => c.command.trim())
    const filteredHooks = hooks.filter((h) => h.command.trim())
    onSave(filtered.length > 0 ? filtered : [], filteredHooks)
  }, [commands, hooks, onSave])

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

        <div className={styles.hookSection}>
          <label className={styles.label}>Hooks</label>
          <div className={styles.hint}>
            Commands that run at different stages of the workspace lifecycle.
          </div>

          <div className={styles.commandList}>
            {hooks.map((hook, i) => (
              <div key={i} className={styles.hookRow}>
                <select
                  className={styles.hookSelect}
                  value={hook.type}
                  onChange={(e) => handleHookTypeChange(i, e.target.value as HookType)}
                >
                  {ALL_HOOK_TYPES.map(({ type, label }) => (
                    <option
                      key={type}
                      value={type}
                      disabled={type !== hook.type && hooks.some((h) => h.type === type)}
                    >
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  className={styles.input}
                  value={hook.command}
                  onChange={(e) => handleHookCommandChange(i, e.target.value)}
                  placeholder="command"
                  autoFocus={i === hooks.length - 1}
                />
                <button
                  className={styles.removeBtn}
                  onClick={() => handleRemoveHook(i)}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}

            {availableHookTypes.length > 0 && (
              <button className={styles.addBtn} onClick={handleAddHook}>
                <span>+</span>
                <span>Add hook</span>
              </button>
            )}
          </div>
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

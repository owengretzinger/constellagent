import { useState, useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Project, PrLinkProvider, StartupCommand, WaitCondition } from '../../store/types'
import styles from './ProjectSettingsDialog.module.css'

interface CommandWithId extends StartupCommand {
  _id: number
}

interface Props {
  project: Project
  onSave: (settings: { startupCommands: StartupCommand[]; prLinkProvider: PrLinkProvider }) => void
  onCancel: () => void
}

function normalizeStartupCommands(list: StartupCommand[] | undefined): StartupCommand[] {
  if (!list?.length) return []
  return list
    .filter((c) => c.command?.trim())
    .map((c) => ({ name: c.name ?? '', command: c.command }))
}

interface StartupCommandRowProps {
  cmd: StartupCommand
  expanded: boolean
  autoFocusCommand: boolean
  isDragging: boolean
  isDropTarget: boolean
  onNameChange: (value: string) => void
  onCommandChange: (value: string) => void
  onRemove: () => void
  onToggleExpand: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

function StartupCommandRow({
  cmd,
  expanded,
  autoFocusCommand,
  isDragging,
  isDropTarget,
  onNameChange,
  onCommandChange,
  onRemove,
  onToggleExpand,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: StartupCommandRowProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const multilineLocked = cmd.command.includes('\n')
  const expandDisabled = expanded && multilineLocked

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el || !expanded) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 72), 280)}px`
  }, [expanded, cmd.command])

  const blockClass = [
    styles.commandBlock,
    isDragging ? styles.commandBlockDragging : '',
    isDropTarget ? styles.commandBlockDropTarget : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={blockClass}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className={styles.commandRowTop}>
        <span className={styles.dragHandle} aria-hidden>⠿</span>
        <input
          className={`${styles.input} ${styles.nameInput}`}
          value={cmd.name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Tab name"
        />
        {!expanded && (
          <input
            className={`${styles.input} ${styles.commandInput}`}
            value={cmd.command}
            onChange={(e) => onCommandChange(e.target.value)}
            placeholder="command"
            autoFocus={autoFocusCommand}
          />
        )}
        <button
          type="button"
          className={styles.expandCmdBtn}
          onClick={onToggleExpand}
          disabled={expandDisabled}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse command field' : 'Expand command field'}
          title={
            expandDisabled
              ? 'Remove line breaks to use single-line mode'
              : expanded
                ? 'Collapse to single line'
                : 'Expand for long or multi-line command'
          }
        >
          <span className={styles.expandCmdIcon} aria-hidden>
            {expanded ? '▴' : '▾'}
          </span>
        </button>
        <button className={styles.removeBtn} onClick={onRemove} title="Remove" type="button">
          ✕
        </button>
      </div>
      {expanded && (
        <textarea
          ref={textareaRef}
          className={styles.commandTextarea}
          value={cmd.command}
          onChange={(e) => onCommandChange(e.target.value)}
          placeholder="command"
          rows={3}
          spellCheck={false}
          autoFocus={autoFocusCommand}
        />
      )}
    </div>
  )
}

export function ProjectSettingsDialog({ project, onSave, onCancel }: Props) {
  const { settings, addToast } = useAppStore()
  const nextIdRef = useRef(0)

  const assignIds = useCallback((list: StartupCommand[]): CommandWithId[] => {
    return list.map((c) => ({ ...c, _id: nextIdRef.current++ }))
  }, [])

  const [commands, setCommands] = useState<CommandWithId[]>(() =>
    assignIds(normalizeStartupCommands(project.startupCommands)),
  )
  const [startupOpen, setStartupOpen] = useState(() => (project.startupCommands?.length ?? 0) > 0)
  const [syncing, setSyncing] = useState(false)
  const [prLinkProvider, setPrLinkProvider] = useState<PrLinkProvider>(
    project.prLinkProvider ?? 'github'
  )

  // Expanded rows keyed by stable _id
  const [expandedCommandRows, setExpandedCommandRows] = useState<Set<number>>(() => {
    const s = new Set<number>()
    // commands state is already initialized at this point via useState initializer above,
    // but we need to compute from the raw list since useState initializers run once
    const list = normalizeStartupCommands(project.startupCommands)
    // IDs are 0..n-1 from the assignIds call above
    list.forEach((c, i) => {
      if (c.command.includes('\n')) s.add(i)
    })
    return s
  })

  // Drag state
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [dropTargetId, setDropTargetId] = useState<number | null>(null)

  const handleAdd = useCallback(() => {
    setCommands((prev) => [...prev, { name: '', command: '', _id: nextIdRef.current++ }])
  }, [])

  const handleRemove = useCallback((id: number) => {
    setExpandedCommandRows((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setCommands((prev) => prev.filter((c) => c._id !== id))
  }, [])

  const toggleCommandExpand = useCallback((id: number, commandText: string) => {
    setExpandedCommandRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        if (commandText.includes('\n')) return prev
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const handleChange = useCallback((id: number, field: keyof StartupCommand, value: string) => {
    setCommands((prev) =>
      prev.map((cmd) => (cmd._id === id ? { ...cmd, [field]: value } : cmd))
    )
  }, [])

  const handleWaitForChange = useCallback((id: number, waitFor: string) => {
    setCommands((prev) =>
      prev.map((cmd) => {
        if (cmd._id !== id) return cmd
        if (!waitFor) {
          const { waitFor: _wf, waitCondition: _wc, ...rest } = cmd
          return rest as CommandWithId
        }
        return { ...cmd, waitFor, waitCondition: cmd.waitCondition ?? { type: 'delay', seconds: 3 } }
      })
    )
  }, [])

  const handleConditionChange = useCallback((id: number, condition: WaitCondition) => {
    setCommands((prev) =>
      prev.map((cmd) => (cmd._id === id ? { ...cmd, waitCondition: condition } : cmd))
    )
  }, [])

  const handleReorder = useCallback((fromId: number, toId: number) => {
    if (fromId === toId) return
    setCommands((prev) => {
      const fromIdx = prev.findIndex((c) => c._id === fromId)
      const toIdx = prev.findIndex((c) => c._id === toId)
      if (fromIdx === -1 || toIdx === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return next
    })
  }, [])

  const handleDragStart = useCallback((id: number, e: React.DragEvent) => {
    setDraggedId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(id))
  }, [])

  const handleDragEnd = useCallback(() => {
    setDraggedId(null)
    setDropTargetId(null)
  }, [])

  const handleDragOver = useCallback((id: number, e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetId(id)
  }, [])

  const handleDragLeave = useCallback((id: number) => {
    setDropTargetId((prev) => (prev === id ? null : prev))
  }, [])

  const handleDrop = useCallback((toId: number, e: React.DragEvent) => {
    e.preventDefault()
    const fromId = Number(e.dataTransfer.getData('text/plain'))
    if (!isNaN(fromId)) handleReorder(fromId, toId)
    setDraggedId(null)
    setDropTargetId(null)
  }, [handleReorder])

  const handleSave = useCallback(() => {
    // Strip _id before saving
    const stripped: StartupCommand[] = commands.map(({ _id, ...rest }) => rest)
    const normalized = normalizeStartupCommands(stripped)
    onSave({
      startupCommands: normalized.length > 0 ? normalized : [],
      prLinkProvider,
    })
  }, [commands, onSave, prLinkProvider])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    },
    [onCancel]
  )

  const configuredStartupCount = commands.filter((c) => c.command.trim()).length

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className={styles.title}>{project.name}</div>

        <button
          type="button"
          className={styles.sectionToggle}
          onClick={() => setStartupOpen((o) => !o)}
          aria-expanded={startupOpen}
        >
          <span className={styles.sectionToggleLabel}>Startup commands</span>
          <span className={styles.sectionToggleMeta}>
            {configuredStartupCount > 0 ? `${configuredStartupCount} configured` : 'optional'}
          </span>
          <span className={`${styles.sectionChevron} ${startupOpen ? styles.sectionChevronOpen : ''}`} aria-hidden>
            ▸
          </span>
        </button>

        {startupOpen && (
          <>
            <div className={styles.hint}>
              Each row opens its own tab. To run steps in order in one tab, use{' '}
              <code className={styles.inlineCode}>&&</code> (for example{' '}
              <code className={styles.inlineCode}>pnpm install && pnpm dev</code>).
            </div>

            <div className={styles.commandList}>
              {commands.map((cmd, i) => (
                <StartupCommandRow
                  key={cmd._id}
                  cmd={cmd}
                  expanded={expandedCommandRows.has(cmd._id)}
                  autoFocusCommand={draggedId === null && i === commands.length - 1}
                  isDragging={draggedId === cmd._id}
                  isDropTarget={dropTargetId === cmd._id && draggedId !== cmd._id}
                  onNameChange={(v) => handleChange(cmd._id, 'name', v)}
                  onCommandChange={(v) => handleChange(cmd._id, 'command', v)}
                  onRemove={() => handleRemove(cmd._id)}
                  onToggleExpand={() => toggleCommandExpand(cmd._id, cmd.command)}
                  onDragStart={(e) => handleDragStart(cmd._id, e)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => handleDragOver(cmd._id, e)}
                  onDragLeave={() => handleDragLeave(cmd._id)}
                  onDrop={(e) => handleDrop(cmd._id, e)}
                />
              ))}

              <button className={styles.addBtn} onClick={handleAdd}>
                <span>+</span>
                <span>Add command</span>
              </button>
            </div>
          </>
        )}

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

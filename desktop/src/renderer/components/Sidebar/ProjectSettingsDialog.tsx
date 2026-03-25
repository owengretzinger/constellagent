import { useState, useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Project, PrLinkProvider, StartupCommand } from '../../store/types'
import styles from './ProjectSettingsDialog.module.css'

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
  onNameChange: (value: string) => void
  onCommandChange: (value: string) => void
  onRemove: () => void
  onToggleExpand: () => void
}

function StartupCommandRow({
  cmd,
  expanded,
  autoFocusCommand,
  onNameChange,
  onCommandChange,
  onRemove,
  onToggleExpand,
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

  return (
    <div className={styles.commandBlock}>
      <div className={styles.commandRowTop}>
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
  const [commands, setCommands] = useState<StartupCommand[]>(() =>
    normalizeStartupCommands(project.startupCommands),
  )
  const [startupOpen, setStartupOpen] = useState(() => (project.startupCommands?.length ?? 0) > 0)
  const [syncing, setSyncing] = useState(false)
  const [prLinkProvider, setPrLinkProvider] = useState<PrLinkProvider>(
    project.prLinkProvider ?? 'github'
  )
  const [expandedCommandRows, setExpandedCommandRows] = useState<Set<number>>(() => {
    const list = normalizeStartupCommands(project.startupCommands)
    const s = new Set<number>()
    list.forEach((c, i) => {
      if (c.command.includes('\n')) s.add(i)
    })
    return s
  })

  const shiftExpandedIndices = useCallback((removedIndex: number) => {
    setExpandedCommandRows((prev) => {
      const next = new Set<number>()
      for (const idx of prev) {
        if (idx < removedIndex) next.add(idx)
        else if (idx > removedIndex) next.add(idx - 1)
      }
      return next
    })
  }, [])

  const handleAdd = useCallback(() => {
    setCommands((prev) => [...prev, { name: '', command: '' }])
  }, [])

  const handleRemove = useCallback(
    (index: number) => {
      shiftExpandedIndices(index)
      setCommands((prev) => prev.filter((_, i) => i !== index))
    },
    [shiftExpandedIndices],
  )

  const toggleCommandExpand = useCallback((index: number) => {
    setExpandedCommandRows((prev) => {
      const next = new Set(prev)
      const isOpen = next.has(index)
      if (isOpen) {
        const cmd = commands[index]
        if (cmd?.command.includes('\n')) return prev
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }, [commands])

  const handleChange = useCallback((index: number, field: keyof StartupCommand, value: string) => {
    setCommands((prev) =>
      prev.map((cmd, i) => (i === index ? { ...cmd, [field]: value } : cmd))
    )
  }, [])

  const handleSave = useCallback(() => {
    const normalized = normalizeStartupCommands(commands)
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
                  key={i}
                  cmd={cmd}
                  expanded={expandedCommandRows.has(i)}
                  autoFocusCommand={i === commands.length - 1}
                  onNameChange={(v) => handleChange(i, 'name', v)}
                  onCommandChange={(v) => handleChange(i, 'command', v)}
                  onRemove={() => handleRemove(i)}
                  onToggleExpand={() => toggleCommandExpand(i)}
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

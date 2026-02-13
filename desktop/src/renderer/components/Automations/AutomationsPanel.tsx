import { useState, useCallback, useEffect } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Automation } from '../../store/types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './AutomationsPanel.module.css'

const SCHEDULE_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Weekly on Monday', cron: '0 9 * * 1' },
  { label: 'Custom', cron: '' },
]

function formatLastRun(timestamp?: number): string {
  if (!timestamp) return 'Never run'
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ── List View ──

function AutomationList({
  onNew,
  onEdit,
}: {
  onNew: () => void
  onEdit: (a: Automation) => void
}) {
  const automations = useAppStore((s) => s.automations)
  const projects = useAppStore((s) => s.projects)
  const updateAutomation = useAppStore((s) => s.updateAutomation)
  const removeAutomation = useAppStore((s) => s.removeAutomation)
  const showConfirmDialog = useAppStore((s) => s.showConfirmDialog)
  const dismissConfirmDialog = useAppStore((s) => s.dismissConfirmDialog)
  const workspaces = useAppStore((s) => s.workspaces)
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace)

  const handleToggleEnabled = useCallback(async (automation: Automation) => {
    const newEnabled = !automation.enabled
    updateAutomation(automation.id, { enabled: newEnabled })
    const project = projects.find((p) => p.id === automation.projectId)
    if (!project) return
    if (newEnabled) {
      await window.api.automations.create({ ...automation, enabled: true, repoPath: project.repoPath })
    } else {
      await window.api.automations.delete(automation.id)
    }
  }, [projects, updateAutomation])

  const handleRunNow = useCallback(async (automation: Automation) => {
    const project = projects.find((p) => p.id === automation.projectId)
    if (!project) return
    await window.api.automations.runNow({ ...automation, repoPath: project.repoPath })
  }, [projects])

  const handleDelete = useCallback((automation: Automation) => {
    showConfirmDialog({
      title: 'Delete Automation',
      message: `Delete automation "${automation.name}"? This will remove it and all its run workspaces.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        const runWs = workspaces.filter((w) => w.automationId === automation.id)
        for (const ws of runWs) deleteWorkspace(ws.id)
        window.api.automations.delete(automation.id)
        removeAutomation(automation.id)
        dismissConfirmDialog()
      },
    })
  }, [showConfirmDialog, dismissConfirmDialog, workspaces, deleteWorkspace, removeAutomation])

  const statusDotClass = (status?: Automation['lastRunStatus']) => {
    if (status === 'success') return styles.statusSuccess
    if (status === 'failed' || status === 'timeout') return styles.statusFailed
    return styles.statusNever
  }

  return (
    <>
      {automations.length === 0 ? (
        <div className={styles.emptyState}>
          <span>No automations yet</span>
          <button className={styles.emptyBtn} onClick={onNew}>+ Create your first automation</button>
        </div>
      ) : (
        automations.map((automation) => {
          const project = projects.find((p) => p.id === automation.projectId)
          return (
            <div
              key={automation.id}
              className={`${styles.automationRow} ${!automation.enabled ? styles.disabled : ''}`}
            >
              <span className={`${styles.statusDot} ${statusDotClass(automation.lastRunStatus)}`} />
              <div className={styles.rowInfo} onClick={() => onEdit(automation)}>
                <div className={styles.rowName}>{automation.name}</div>
                <div className={styles.rowMeta}>
                  <span>{project?.name ?? 'Unknown project'}</span>
                  <span>·</span>
                  <span>{automation.cronExpression}</span>
                  <span>·</span>
                  <span>{formatLastRun(automation.lastRunAt)}</span>
                </div>
              </div>
              <div className={styles.rowActions}>
                <Tooltip label="Run now">
                  <button className={styles.runBtn} onClick={() => handleRunNow(automation)}>
                    Run
                  </button>
                </Tooltip>
                <Tooltip label={automation.enabled ? 'Disable' : 'Enable'}>
                  <button
                    className={`${styles.toggle} ${automation.enabled ? styles.toggleOn : ''}`}
                    onClick={() => handleToggleEnabled(automation)}
                  >
                    <span className={styles.toggleKnob} />
                  </button>
                </Tooltip>
                <Tooltip label="Delete">
                  <button className={styles.deleteBtn} onClick={() => handleDelete(automation)}>
                    ✕
                  </button>
                </Tooltip>
              </div>
            </div>
          )
        })
      )}
    </>
  )
}

// ── Form View ──

function AutomationForm({
  editingAutomation,
  onBack,
}: {
  editingAutomation: Automation | null
  onBack: () => void
}) {
  const projects = useAppStore((s) => s.projects)
  const addAutomation = useAppStore((s) => s.addAutomation)
  const updateAutomation = useAppStore((s) => s.updateAutomation)
  const isEditing = !!editingAutomation

  const [projectId, setProjectId] = useState(editingAutomation?.projectId || projects[0]?.id || '')
  const [prompt, setPrompt] = useState(editingAutomation?.prompt || '')
  const [name, setName] = useState(editingAutomation?.name || '')
  const [nameManuallySet, setNameManuallySet] = useState(isEditing)
  const [selectedPreset, setSelectedPreset] = useState(() => {
    if (!editingAutomation) return 0
    const idx = SCHEDULE_PRESETS.findIndex((p) => p.cron === editingAutomation.cronExpression)
    return idx >= 0 ? idx : SCHEDULE_PRESETS.length - 1
  })
  const [customCron, setCustomCron] = useState(
    editingAutomation ? editingAutomation.cronExpression : ''
  )
  useEffect(() => {
    if (!nameManuallySet && prompt) {
      setName(prompt.slice(0, 40))
    }
  }, [prompt, nameManuallySet])

  const cronExpression = selectedPreset === SCHEDULE_PRESETS.length - 1
    ? customCron
    : SCHEDULE_PRESETS[selectedPreset].cron

  const isValid = projectId && prompt.trim() && name.trim() && cronExpression

  const handleSubmit = useCallback(async () => {
    if (!isValid) return
    const project = projects.find((p) => p.id === projectId)
    if (!project) return

    if (isEditing && editingAutomation) {
      updateAutomation(editingAutomation.id, {
        name: name.trim(),
        projectId,
        prompt: prompt.trim(),
        cronExpression,
      })
      await window.api.automations.update({
        ...editingAutomation,
        name: name.trim(),
        projectId,
        prompt: prompt.trim(),
        cronExpression,
        repoPath: project.repoPath,
      })
    } else {
      const automation: Automation = {
        id: crypto.randomUUID(),
        name: name.trim(),
        projectId,
        prompt: prompt.trim(),
        cronExpression,
        enabled: true,
        createdAt: Date.now(),
      }
      addAutomation(automation)
      await window.api.automations.create({
        ...automation,
        repoPath: project.repoPath,
      })
    }

    onBack()
  }, [isValid, projectId, prompt, name, cronExpression, isEditing, editingAutomation, projects, addAutomation, updateAutomation, onBack])

  return (
    <>
      <button className={styles.backLink} onClick={onBack}>← Back</button>
      <div className={styles.formTitle}>{isEditing ? 'Edit Automation' : 'New Automation'}</div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => { setName(e.target.value); setNameManuallySet(true) }}
          placeholder="Automation name"
          autoFocus
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Project</label>
        <select
          className={styles.input}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Prompt</label>
        <textarea
          className={styles.textarea}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Review the codebase for security issues..."
          rows={3}
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Schedule</label>
        <div className={styles.presetGrid}>
          {SCHEDULE_PRESETS.map((preset, i) => (
            <button
              key={preset.label}
              className={`${styles.presetBtn} ${selectedPreset === i ? styles.presetActive : ''}`}
              onClick={() => setSelectedPreset(i)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <input
          className={styles.input}
          value={selectedPreset === SCHEDULE_PRESETS.length - 1 ? customCron : SCHEDULE_PRESETS[selectedPreset].cron}
          onChange={(e) => { setCustomCron(e.target.value); setSelectedPreset(SCHEDULE_PRESETS.length - 1) }}
          placeholder="*/5 * * * *"
          style={{ marginTop: 'var(--space-2)' }}
        />
      </div>

      <div className={styles.formActions}>
        <button className={styles.cancelBtn} onClick={onBack}>Cancel</button>
        <button className={styles.submitBtn} onClick={handleSubmit} disabled={!isValid}>
          {isEditing ? 'Save' : 'Create'}
        </button>
      </div>
    </>
  )
}

// ── Panel ──

export function AutomationsPanel() {
  const toggleAutomations = useAppStore((s) => s.toggleAutomations)
  const [view, setView] = useState<'list' | 'form'>('list')
  const [editingAutomation, setEditingAutomation] = useState<Automation | null>(null)

  const handleNew = useCallback(() => {
    setEditingAutomation(null)
    setView('form')
  }, [])

  const handleEdit = useCallback((automation: Automation) => {
    setEditingAutomation(automation)
    setView('form')
  }, [])

  const handleBack = useCallback(() => {
    setEditingAutomation(null)
    setView('list')
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (view === 'form') {
          handleBack()
        } else {
          toggleAutomations()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, handleBack, toggleAutomations])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <Tooltip label="Back">
              <button className={styles.backBtn} onClick={toggleAutomations}>‹</button>
            </Tooltip>
            <h2 className={styles.title}>Automations</h2>
          </div>
          {view === 'list' && (
            <button className={styles.newBtn} onClick={handleNew}>+ New</button>
          )}
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.inner}>
          {view === 'list' ? (
            <AutomationList onNew={handleNew} onEdit={handleEdit} />
          ) : (
            <AutomationForm editingAutomation={editingAutomation} onBack={handleBack} />
          )}
        </div>
      </div>
    </div>
  )
}

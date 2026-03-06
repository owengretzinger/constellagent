import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CreateSkillInput, Skill } from '@shared/skill-types'
import { useAppStore } from '../../store/app-store'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './SkillsPanel.module.css'

function formatUpdatedAt(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Updated just now'
  if (mins < 60) return `Updated ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Updated ${hours}h ago`
  const days = Math.floor(hours / 24)
  return `Updated ${days}d ago`
}

function SkillsList({
  skills,
  loading,
  error,
  onRefresh,
  onNew,
  onEdit,
  onDelete,
  onToggleEnabled,
}: {
  skills: Skill[]
  loading: boolean
  error: string | null
  onRefresh: () => Promise<void>
  onNew: () => void
  onEdit: (skill: Skill) => void
  onDelete: (skill: Skill) => void
  onToggleEnabled: (skill: Skill) => Promise<void>
}) {
  if (loading) {
    return <div className={styles.status}>Loading skills...</div>
  }
  if (error) {
    return (
      <div className={styles.statusError}>
        <span>{error}</span>
        <button className={styles.inlineActionBtn} onClick={() => void onRefresh()}>
          Retry
        </button>
      </div>
    )
  }
  if (skills.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span>No skills yet</span>
        <button className={styles.emptyBtn} onClick={onNew}>+ Create your first skill</button>
      </div>
    )
  }

  return (
    <>
      {skills.map((skill) => (
        <div key={skill.id} className={`${styles.skillRow} ${!skill.enabled ? styles.disabled : ''}`}>
          <div className={styles.skillInfo} onClick={() => onEdit(skill)}>
            <div className={styles.skillTitleRow}>
              <span className={`${styles.statusDot} ${skill.enabled ? styles.statusEnabled : styles.statusDisabled}`} />
              <span className={styles.skillName}>{skill.name}</span>
            </div>
            <div className={styles.skillDescription}>
              {skill.description || 'No description'}
            </div>
            <div className={styles.skillMeta}>{formatUpdatedAt(skill.updatedAt)}</div>
          </div>
          <div className={styles.rowActions}>
            <Tooltip label={skill.enabled ? 'Disable' : 'Enable'}>
              <button
                className={`${styles.toggle} ${skill.enabled ? styles.toggleOn : ''}`}
                onClick={() => void onToggleEnabled(skill)}
              >
                <span className={styles.toggleKnob} />
              </button>
            </Tooltip>
            <Tooltip label="Delete">
              <button className={styles.deleteBtn} onClick={() => onDelete(skill)}>✕</button>
            </Tooltip>
          </div>
        </div>
      ))}
    </>
  )
}

function SkillsForm({
  editingSkill,
  onBack,
  onSubmit,
  saving,
}: {
  editingSkill: Skill | null
  onBack: () => void
  onSubmit: (input: CreateSkillInput, skillId?: string) => Promise<void>
  saving: boolean
}) {
  const isEditing = !!editingSkill
  const [name, setName] = useState(editingSkill?.name ?? '')
  const [description, setDescription] = useState(editingSkill?.description ?? '')
  const [instruction, setInstruction] = useState(editingSkill?.instruction ?? '')
  const [enabled, setEnabled] = useState(editingSkill?.enabled ?? true)

  const isValid = useMemo(() => {
    return name.trim().length > 0 && instruction.trim().length > 0
  }, [name, instruction])

  const handleSave = useCallback(async () => {
    if (!isValid || saving) return
    await onSubmit(
      {
        name: name.trim(),
        description: description.trim(),
        instruction: instruction.trim(),
        enabled,
      },
      editingSkill?.id,
    )
  }, [name, description, instruction, enabled, editingSkill, isValid, onSubmit, saving])

  return (
    <>
      <button className={styles.backLink} onClick={onBack}>← Back</button>
      <div className={styles.formTitle}>{isEditing ? 'Edit Skill' : 'New Skill'}</div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='Triage support tickets'
          autoFocus
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Description</label>
        <textarea
          className={styles.textarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder='When and why this skill should be used'
          rows={2}
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Instruction</label>
        <textarea
          className={styles.textarea}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder='Steps the messaging agent should follow...'
          rows={6}
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Status</label>
        <button
          className={`${styles.toggleRow} ${enabled ? styles.toggleRowOn : ''}`}
          onClick={() => setEnabled((prev) => !prev)}
        >
          <span>{enabled ? 'Enabled' : 'Disabled'}</span>
          <span className={`${styles.toggle} ${enabled ? styles.toggleOn : ''}`}>
            <span className={styles.toggleKnob} />
          </span>
        </button>
      </div>

      <div className={styles.formActions}>
        <button className={styles.cancelBtn} onClick={onBack} disabled={saving}>Cancel</button>
        <button className={styles.submitBtn} onClick={() => void handleSave()} disabled={!isValid || saving}>
          {saving ? (isEditing ? 'Saving...' : 'Creating...') : (isEditing ? 'Save' : 'Create')}
        </button>
      </div>
    </>
  )
}

export function SkillsPanel() {
  const toggleSkills = useAppStore((s) => s.toggleSkills)
  const showConfirmDialog = useAppStore((s) => s.showConfirmDialog)
  const dismissConfirmDialog = useAppStore((s) => s.dismissConfirmDialog)
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<'list' | 'form'>('list')
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null)

  const loadSkills = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await window.api.skills.list()
      setSkills(rows)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load skills'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const handleNew = useCallback(() => {
    setEditingSkill(null)
    setView('form')
  }, [])

  const handleEdit = useCallback((skill: Skill) => {
    setEditingSkill(skill)
    setView('form')
  }, [])

  const handleBack = useCallback(() => {
    setEditingSkill(null)
    setView('list')
  }, [])

  const handleDelete = useCallback((skill: Skill) => {
    showConfirmDialog({
      title: 'Delete Skill',
      message: `Delete skill "${skill.name}"?`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          await window.api.skills.delete(skill.id)
          setSkills((prev) => prev.filter((row) => row.id !== skill.id))
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to delete skill'
          setError(message)
        } finally {
          dismissConfirmDialog()
        }
      },
    })
  }, [dismissConfirmDialog, showConfirmDialog])

  const handleToggleEnabled = useCallback(async (skill: Skill) => {
    try {
      const updated = await window.api.skills.update(skill.id, { enabled: !skill.enabled })
      setSkills((prev) => prev.map((row) => (row.id === updated.id ? updated : row)))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update skill'
      setError(message)
    }
  }, [])

  const handleSubmit = useCallback(async (input: CreateSkillInput, skillId?: string) => {
    setSaving(true)
    setError(null)
    try {
      if (skillId) {
        const updated = await window.api.skills.update(skillId, input)
        setSkills((prev) => prev.map((row) => (row.id === updated.id ? updated : row)))
      } else {
        const created = await window.api.skills.create(input)
        setSkills((prev) => [created, ...prev])
      }
      handleBack()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save skill'
      setError(message)
    } finally {
      setSaving(false)
    }
  }, [handleBack])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (view === 'form') handleBack()
      else toggleSkills()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, handleBack, toggleSkills])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <Tooltip label="Back">
              <button className={styles.backBtn} onClick={toggleSkills}>‹</button>
            </Tooltip>
            <h2 className={styles.title}>Skills Admin</h2>
          </div>
          {view === 'list' && (
            <div className={styles.headerActions}>
              <button className={styles.ghostBtn} onClick={() => void loadSkills()}>Refresh</button>
              <button className={styles.newBtn} onClick={handleNew}>+ New</button>
            </div>
          )}
        </div>
      </div>
      <div className={styles.content}>
        <div className={styles.inner}>
          {view === 'list' ? (
            <SkillsList
              skills={skills}
              loading={loading}
              error={error}
              onRefresh={loadSkills}
              onNew={handleNew}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggleEnabled={handleToggleEnabled}
            />
          ) : (
            <SkillsForm
              editingSkill={editingSkill}
              onBack={handleBack}
              onSubmit={handleSubmit}
              saving={saving}
            />
          )}
        </div>
      </div>
    </div>
  )
}

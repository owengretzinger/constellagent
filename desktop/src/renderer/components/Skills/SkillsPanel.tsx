import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Skill } from '../../../shared/skill-types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from '../Automations/AutomationsPanel.module.css'

function SkillList({
  skills,
  loading,
  error,
  onNew,
  onEdit,
  onDelete,
}: {
  skills: Skill[]
  loading: boolean
  error: string | null
  onNew: () => void
  onEdit: (skill: Skill) => void
  onDelete: (skill: Skill) => void
}) {
  if (loading && skills.length === 0) {
    return <div className={styles.emptyState}>Loading skills...</div>
  }

  if (skills.length === 0) {
    return (
      <div className={styles.emptyState}>
        {error && (
          <div style={{ color: 'var(--accent-red)', textAlign: 'center' }}>{error}</div>
        )}
        <span>No skills yet</span>
        <button className={styles.emptyBtn} onClick={onNew}>+ Create your first skill</button>
      </div>
    )
  }

  return (
    <>
      {error && (
        <div style={{ color: 'var(--accent-red)', marginBottom: 'var(--space-4)' }}>
          {error}
        </div>
      )}
      {skills.map((skill) => (
        <div key={skill.name} className={styles.automationRow}>
          <div className={styles.rowInfo} onClick={() => onEdit(skill)}>
            <div className={styles.rowName}>{skill.name}</div>
            <div className={styles.rowMeta}>
              <span>{skill.description}</span>
            </div>
            <div className={styles.rowMeta}>
              <span>{skill.metadata.author || 'unknown author'}</span>
              <span>·</span>
              <span>{skill.metadata.version || 'no version'}</span>
              {skill.compatibility && (
                <>
                  <span>·</span>
                  <span>{skill.compatibility}</span>
                </>
              )}
            </div>
          </div>
          <div className={styles.rowActions}>
            <Tooltip label="Edit">
              <button className={styles.runBtn} onClick={() => onEdit(skill)}>
                Edit
              </button>
            </Tooltip>
            <Tooltip label="Delete">
              <button className={styles.deleteBtn} onClick={() => onDelete(skill)}>
                ✕
              </button>
            </Tooltip>
          </div>
        </div>
      ))}
    </>
  )
}

function SkillForm({
  editingSkill,
  onBack,
  onSaved,
}: {
  editingSkill: Skill | null
  onBack: () => void
  onSaved: () => Promise<void>
}) {
  const addToast = useAppStore((s) => s.addToast)
  const isEditing = !!editingSkill

  const [name, setName] = useState(editingSkill?.name || '')
  const [description, setDescription] = useState(editingSkill?.description || '')
  const [license, setLicense] = useState(editingSkill?.license || 'MIT')
  const [compatibility, setCompatibility] = useState(editingSkill?.compatibility || '')
  const [author, setAuthor] = useState(editingSkill?.metadata.author || 'constellagent')
  const [version, setVersion] = useState(editingSkill?.metadata.version || '1.0')
  const [content, setContent] = useState(editingSkill?.content || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isValid = name.trim() && description.trim() && content.trim()

  const handleSubmit = useCallback(async () => {
    if (!isValid || saving) return

    setSaving(true)
    setError(null)

    try {
      const payload: Skill = {
        name: name.trim(),
        description: description.trim(),
        license: license.trim() || 'MIT',
        compatibility: compatibility.trim(),
        metadata: {
          ...editingSkill?.metadata,
          author: author.trim() || 'constellagent',
          version: version.trim() || '1.0',
        },
        content: content.trim(),
      }

      if (editingSkill) {
        await window.api.skills.update({
          previousName: editingSkill.name,
          ...payload,
        })
      } else {
        await window.api.skills.create(payload)
      }

      await onSaved()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save skill'
      setError(message)
      addToast({ id: crypto.randomUUID(), message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }, [isValid, saving, name, description, license, compatibility, author, version, content, editingSkill, onSaved, addToast])

  return (
    <>
      <button className={styles.backLink} onClick={onBack}>← Back</button>
      <div className={styles.formTitle}>{isEditing ? 'Edit Skill' : 'New Skill'}</div>

      {error && (
        <div style={{ color: 'var(--accent-red)', marginBottom: 'var(--space-5)' }}>
          {error}
        </div>
      )}

      <div className={styles.formGroup}>
        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="message-routing"
          autoFocus
        />
        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>
          Use kebab-case. This becomes the skill folder name.
        </div>
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Description</label>
        <textarea
          className={styles.textarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Route customer messages to the right agent..."
          rows={3}
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Compatibility</label>
        <input
          className={styles.input}
          value={compatibility}
          onChange={(e) => setCompatibility(e.target.value)}
          placeholder="Optional runtime requirements"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>License</label>
        <input
          className={styles.input}
          value={license}
          onChange={(e) => setLicense(e.target.value)}
          placeholder="MIT"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Author</label>
        <input
          className={styles.input}
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="constellagent"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Version</label>
        <input
          className={styles.input}
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="1.0"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Content</label>
        <textarea
          className={styles.textarea}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Describe how the agent should use this skill..."
          rows={16}
        />
      </div>

      <div className={styles.formActions}>
        <button className={styles.cancelBtn} onClick={onBack}>Cancel</button>
        <button className={styles.submitBtn} onClick={handleSubmit} disabled={!isValid || saving}>
          {saving ? 'Saving...' : isEditing ? 'Save' : 'Create'}
        </button>
      </div>
    </>
  )
}

export function SkillsPanel() {
  const toggleSkills = useAppStore((s) => s.toggleSkills)
  const showConfirmDialog = useAppStore((s) => s.showConfirmDialog)
  const dismissConfirmDialog = useAppStore((s) => s.dismissConfirmDialog)
  const addToast = useAppStore((s) => s.addToast)
  const [view, setView] = useState<'list' | 'form'>('list')
  const [skills, setSkills] = useState<Skill[]>([])
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    setLoading(true)
    try {
      setSkills(await window.api.skills.list())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills')
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

  const handleSaved = useCallback(async () => {
    await loadSkills()
    handleBack()
  }, [loadSkills, handleBack])

  const handleDelete = useCallback((skill: Skill) => {
    showConfirmDialog({
      title: 'Delete Skill',
      message: `Delete skill "${skill.name}"? This removes its SKILL.md file from disk.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        void (async () => {
          try {
            await window.api.skills.delete(skill.name)
            setSkills((current) => current.filter((item) => item.name !== skill.name))
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to delete skill'
            addToast({ id: crypto.randomUUID(), message, type: 'error' })
          } finally {
            dismissConfirmDialog()
          }
        })()
      },
    })
  }, [showConfirmDialog, dismissConfirmDialog, addToast])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (view === 'form') {
          handleBack()
        } else {
          toggleSkills()
        }
      }
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
            <h2 className={styles.title}>Skills</h2>
          </div>
          {view === 'list' && (
            <button className={styles.newBtn} onClick={handleNew}>+ New</button>
          )}
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.inner}>
          {view === 'list' ? (
            <SkillList
              skills={skills}
              loading={loading}
              error={error}
              onNew={handleNew}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ) : (
            <SkillForm editingSkill={editingSkill} onBack={handleBack} onSaved={handleSaved} />
          )}
        </div>
      </div>
    </div>
  )
}

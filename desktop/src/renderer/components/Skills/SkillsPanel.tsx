import { useState, useCallback, useEffect, type KeyboardEvent } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Skill } from '@shared/skill-types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './SkillsPanel.module.css'

// ── List View ──

function SkillList({
  onNew,
  onEdit,
}: {
  onNew: () => void
  onEdit: (s: Skill) => void
}) {
  const skills = useAppStore((s) => s.skills)
  const updateSkill = useAppStore((s) => s.updateSkill)
  const removeSkill = useAppStore((s) => s.removeSkill)
  const showConfirmDialog = useAppStore((s) => s.showConfirmDialog)
  const dismissConfirmDialog = useAppStore((s) => s.dismissConfirmDialog)

  const handleToggleEnabled = useCallback(async (skill: Skill) => {
    const newEnabled = !skill.enabled
    updateSkill(skill.id, { enabled: newEnabled, updatedAt: Date.now() })
    await window.api.skills.update({ ...skill, enabled: newEnabled, updatedAt: Date.now() })
  }, [updateSkill])

  const handleDelete = useCallback((skill: Skill) => {
    showConfirmDialog({
      title: 'Delete Skill',
      message: `Delete skill "${skill.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        window.api.skills.delete(skill.id)
        removeSkill(skill.id)
        dismissConfirmDialog()
      },
    })
  }, [showConfirmDialog, dismissConfirmDialog, removeSkill])

  return (
    <>
      {skills.length === 0 ? (
        <div className={styles.emptyState}>
          <span>No skills yet</span>
          <button className={styles.emptyBtn} onClick={onNew}>+ Create your first skill</button>
        </div>
      ) : (
        skills.map((skill) => (
          <div
            key={skill.id}
            className={`${styles.skillRow} ${!skill.enabled ? styles.disabled : ''}`}
          >
            <div className={styles.rowInfo} onClick={() => onEdit(skill)}>
              <div className={styles.rowName}>{skill.name}</div>
              {skill.description && (
                <div className={styles.rowDescription}>{skill.description}</div>
              )}
              {skill.tags.length > 0 && (
                <div className={styles.rowMeta}>
                  {skill.tags.map((tag) => (
                    <span key={tag} className={styles.tag}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
            <div className={styles.rowActions}>
              <Tooltip label={skill.enabled ? 'Disable' : 'Enable'}>
                <button
                  className={`${styles.toggle} ${skill.enabled ? styles.toggleOn : ''}`}
                  onClick={() => handleToggleEnabled(skill)}
                >
                  <span className={styles.toggleKnob} />
                </button>
              </Tooltip>
              <Tooltip label="Delete">
                <button className={styles.deleteBtn} onClick={() => handleDelete(skill)}>
                  ✕
                </button>
              </Tooltip>
            </div>
          </div>
        ))
      )}
    </>
  )
}

// ── Form View ──

function SkillForm({
  editingSkill,
  onBack,
}: {
  editingSkill: Skill | null
  onBack: () => void
}) {
  const addSkill = useAppStore((s) => s.addSkill)
  const updateSkill = useAppStore((s) => s.updateSkill)
  const isEditing = !!editingSkill

  const [name, setName] = useState(editingSkill?.name || '')
  const [description, setDescription] = useState(editingSkill?.description || '')
  const [instructions, setInstructions] = useState(editingSkill?.instructions || '')
  const [tags, setTags] = useState<string[]>(editingSkill?.tags || [])
  const [tagInput, setTagInput] = useState('')

  const isValid = name.trim() && instructions.trim()

  const handleAddTag = useCallback(() => {
    const tag = tagInput.trim().toLowerCase()
    if (tag && !tags.includes(tag)) {
      setTags((prev) => [...prev, tag])
    }
    setTagInput('')
  }, [tagInput, tags])

  const handleTagKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      handleAddTag()
    } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      setTags((prev) => prev.slice(0, -1))
    }
  }, [handleAddTag, tagInput, tags.length])

  const handleRemoveTag = useCallback((tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag))
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!isValid) return
    const now = Date.now()

    if (isEditing && editingSkill) {
      const updated: Skill = {
        ...editingSkill,
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        tags,
        updatedAt: now,
      }
      updateSkill(editingSkill.id, updated)
      await window.api.skills.update(updated)
    } else {
      const skill: Skill = {
        id: crypto.randomUUID(),
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        tags,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }
      addSkill(skill)
      await window.api.skills.create(skill)
    }

    onBack()
  }, [isValid, name, description, instructions, tags, isEditing, editingSkill, addSkill, updateSkill, onBack])

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
          placeholder="e.g. Code Review"
          autoFocus
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Description</label>
        <input
          className={styles.input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description of what this skill does"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Instructions</label>
        <textarea
          className={styles.textarea}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Detailed instructions for the agent when using this skill..."
          rows={5}
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Tags</label>
        <div className={styles.tagInput}>
          {tags.map((tag) => (
            <span key={tag} className={styles.tagChip}>
              {tag}
              <button className={styles.tagRemove} onClick={() => handleRemoveTag(tag)}>✕</button>
            </span>
          ))}
          <input
            className={styles.tagField}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleTagKeyDown}
            onBlur={handleAddTag}
            placeholder={tags.length === 0 ? 'Type and press Enter' : ''}
          />
        </div>
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

export function SkillsPanel() {
  const toggleSkills = useAppStore((s) => s.toggleSkills)
  const setSkills = useAppStore((s) => s.setSkills)
  const [view, setView] = useState<'list' | 'form'>('list')
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!loaded) {
      window.api.skills.list().then((skills) => {
        setSkills(skills)
        setLoaded(true)
      })
    }
  }, [loaded, setSkills])

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

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
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
            <SkillList onNew={handleNew} onEdit={handleEdit} />
          ) : (
            <SkillForm editingSkill={editingSkill} onBack={handleBack} />
          )}
        </div>
      </div>
    </div>
  )
}

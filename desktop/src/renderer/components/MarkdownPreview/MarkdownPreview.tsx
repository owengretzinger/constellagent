import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAppStore } from '../../store/app-store'
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer'
import { AddToChatMarkdownSurface } from '../AddToChat/AddToChatMarkdownSurface'
import {
  isAgentPlanPath,
  agentForPlanPath,
  AGENT_TO_PLAN_DIR,
  pathsEqualOrAlias,
  relativePathInWorktree,
} from '../../../shared/agent-plan-path'
import type { PlanMeta, PlanAgent } from '../../../shared/agent-plan-path'
import {
  BUILD_HARNESS_OPTIONS,
  PLAN_MODEL_PRESETS,
  buildPlanAgentCommand,
  canonicalPlanModelValue,
  effectivePlanHarness,
  findPlanModelPreset,
  isModelLabelFromOtherHarness,
  planAgentToPtyAgentType,
} from '../../../shared/plan-build-command'
import type { AgentType } from '../../store/types'
import styles from './MarkdownPreview.module.css'

const BUILD_TIMEOUT_MS = 5 * 60 * 1000

const RELOCATE_TARGETS: { agent: PlanAgent; label: string }[] = [
  { agent: 'cursor', label: 'Cursor' },
  { agent: 'claude-code', label: 'Claude' },
  { agent: 'codex', label: 'Codex' },
  { agent: 'gemini', label: 'Gemini' },
]

interface Props {
  filePath: string
  worktreePath?: string
}

export function MarkdownPreview({ filePath, worktreePath }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<PlanMeta>({ built: false, codingAgent: null, buildHarness: null })
  const [relocateOpen, setRelocateOpen] = useState(false)
  const [customAgent, setCustomAgent] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [building, setBuilding] = useState(false)
  const [userHome, setUserHome] = useState<string | undefined>(undefined)
  const relocateRef = useRef<HTMLDivElement>(null)
  const openFileTab = useAppStore((s) => s.openFileTab)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const removeTab = useAppStore((s) => s.removeTab)
  const addToast = useAppStore((s) => s.addToast)
  const showConfirmDialog = useAppStore((s) => s.showConfirmDialog)
  const dismissConfirmDialog = useAppStore((s) => s.dismissConfirmDialog)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const launchAgentTerminal = useAppStore((s) => s.launchAgentTerminalWithCommand)
  const retargetMarkdownPreviewTab = useAppStore((s) => s.retargetMarkdownPreviewTab)
  const workspace = useAppStore((s) =>
    s.workspaces.find((w) => w.worktreePath === worktreePath),
  )

  useEffect(() => {
    void window.api.app.getHomeDir().then(setUserHome).catch(() => {})
  }, [])

  const isPlan = isAgentPlanPath(worktreePath ?? '', filePath, userHome)
  const currentAgent = agentForPlanPath(worktreePath ?? '', filePath, userHome)

  const effectiveHarness = useMemo(
    () => effectivePlanHarness(meta.buildHarness, currentAgent as PlanAgent | null),
    [meta.buildHarness, currentAgent],
  )

  const agentPresets = useMemo(() => {
    if (!effectiveHarness) return []
    return PLAN_MODEL_PRESETS[effectiveHarness] ?? []
  }, [effectiveHarness])
  const modelSelectValue = useMemo(() => {
    if (!effectiveHarness || !meta.codingAgent) return ''
    return canonicalPlanModelValue(effectiveHarness, meta.codingAgent)
  }, [effectiveHarness, meta.codingAgent])

  const folderHarnessLabel = useMemo(
    () => RELOCATE_TARGETS.find((t) => t.agent === currentAgent)?.label ?? 'folder',
    [currentAgent],
  )

  const loadContent = useCallback(async () => {
    try {
      const text = await window.api.fs.readFile(filePath)
      if (text === null) {
        setError('File not found')
        setContent(null)
      } else {
        setContent(text)
        setError(null)
      }
    } catch {
      setError('Failed to read file')
      setContent(null)
    }
  }, [filePath])

  const loadMeta = useCallback(async () => {
    if (!isPlan) return
    try {
      const m = await window.api.fs.readPlanMeta(filePath)
      setMeta(m)
    } catch { /* ignore — file may have been moved */ }
  }, [filePath, isPlan])

  useEffect(() => { loadContent() }, [loadContent])
  useEffect(() => { loadMeta() }, [loadMeta])

  useEffect(() => {
    const watchRoots: string[] = []
    if (worktreePath) watchRoots.push(worktreePath)
    if (isPlan && filePath) {
      const i = filePath.lastIndexOf('/')
      if (i > 0) watchRoots.push(filePath.slice(0, i))
    }
    const unique = [...new Set(watchRoots)]
    if (unique.length === 0) return
    for (const d of unique) void window.api.fs.watchDir(d)
    const cleanup = window.api.fs.onDirChanged((changedDir) => {
      if (!unique.some((w) => pathsEqualOrAlias(changedDir, w))) return
      loadContent()
      loadMeta()
    })
    return () => {
      for (const d of unique) void window.api.fs.unwatchDir(d)
      cleanup()
    }
  }, [worktreePath, filePath, isPlan, loadContent, loadMeta])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!worktreePath || detail?.worktreePath !== worktreePath) return
      loadContent()
      loadMeta()
    }
    window.addEventListener('git:files-changed', handler)
    return () => window.removeEventListener('git:files-changed', handler)
  }, [worktreePath, loadContent, loadMeta])

  // Close relocate dropdown on outside click
  useEffect(() => {
    if (!relocateOpen) return
    const handler = (e: MouseEvent) => {
      if (relocateRef.current && !relocateRef.current.contains(e.target as Node)) {
        setRelocateOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [relocateOpen])

  const handleBuild = useCallback(async () => {
    if (!worktreePath || !workspace) return

    const harness = effectivePlanHarness(meta.buildHarness, currentAgent as PlanAgent | null)
    if (!harness) {
      addToast({ id: crypto.randomUUID(), message: 'Could not determine build harness for this plan', type: 'error' })
      return
    }

    if (!meta.codingAgent) {
      addToast({ id: crypto.randomUUID(), message: 'Select a model before building', type: 'error' })
      return
    }

    const matchesHarnessPreset = !!findPlanModelPreset(harness, meta.codingAgent)
    const modelOkForHarness =
      matchesHarnessPreset || !isModelLabelFromOtherHarness(harness, meta.codingAgent)
    if (!modelOkForHarness) {
      addToast({
        id: crypto.randomUUID(),
        message: 'This model name is for another harness; choose a model for the selected harness (or Custom… with a raw CLI id).',
        type: 'error',
      })
      return
    }

    let planAbsPath = filePath
    const onDiskAgent = agentForPlanPath(worktreePath, filePath, userHome) as PlanAgent | null
    const planInActiveWorkspace =
      !!worktreePath && relativePathInWorktree(worktreePath, filePath) !== null
    if (onDiskAgent && onDiskAgent !== harness && planInActiveWorkspace) {
      try {
        planAbsPath = await window.api.fs.relocateAgentPlan(worktreePath, filePath, harness, 'move')
        if (activeTabId) retargetMarkdownPreviewTab(activeTabId, planAbsPath)
        const harnessLabel = BUILD_HARNESS_OPTIONS.find((o) => o.agent === harness)?.label ?? harness
        addToast({
          id: crypto.randomUUID(),
          message: `Plan moved to ${AGENT_TO_PLAN_DIR[harness]} for ${harnessLabel}`,
          type: 'info',
        })
      } catch (err) {
        addToast({
          id: crypto.randomUUID(),
          message: `Failed to move plan: ${err instanceof Error ? err.message : 'unknown error'}`,
          type: 'error',
        })
        return
      }
    }

    const { command } = buildPlanAgentCommand(harness, worktreePath, planAbsPath, meta.codingAgent)

    try {
      const planName = planAbsPath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'Plan'
      const tabId = await launchAgentTerminal({
        workspaceId: workspace.id,
        worktreePath,
        title: `Build: ${planName}`,
        command,
        agentType: planAgentToPtyAgentType(harness) as AgentType,
      })
      setBuilding(true)
      setActiveTab(tabId)
    } catch {
      addToast({ id: crypto.randomUUID(), message: 'Failed to launch build terminal', type: 'error' })
    }
  }, [
    worktreePath,
    workspace,
    currentAgent,
    meta.buildHarness,
    meta.codingAgent,
    filePath,
    userHome,
    activeTabId,
    retargetMarkdownPreviewTab,
    launchAgentTerminal,
    setActiveTab,
    addToast,
  ])

  // When building, subscribe to workspace notify to detect agent completion.
  // Caveats: fires on any agent notify for this workspace — not correlated to a specific plan build.
  useEffect(() => {
    if (!building || !workspace) return

    const unsub = window.api.claude.onNotifyWorkspace((wsId) => {
      if (wsId !== workspace.id) return
      setBuilding(false)
      window.api.fs.updatePlanMeta(filePath, { built: true }).then((updated) => {
        setMeta(updated)
        addToast({ id: crypto.randomUUID(), message: 'Plan build complete', type: 'info' })
      }).catch(() => {})
    })

    const timeout = setTimeout(() => setBuilding(false), BUILD_TIMEOUT_MS)

    return () => { unsub(); clearTimeout(timeout) }
  }, [building, workspace, filePath, addToast])

  const handleUnsetBuilt = useCallback(async () => {
    try {
      const updated = await window.api.fs.updatePlanMeta(filePath, { built: false })
      setMeta(updated)
    } catch {
      addToast({ id: crypto.randomUUID(), message: 'Failed to update plan meta', type: 'error' })
    }
  }, [filePath, addToast])

  const handleHarnessSelect = useCallback(async (value: string) => {
    const nextHarness = value === '__auto' ? null : (value as PlanAgent)
    const prevEffective = effectivePlanHarness(meta.buildHarness, currentAgent as PlanAgent | null)
    const nextEffective = effectivePlanHarness(nextHarness, currentAgent as PlanAgent | null)
    try {
      const patch: Partial<PlanMeta> = { buildHarness: nextHarness }
      if (prevEffective !== nextEffective) patch.codingAgent = null
      const updated = await window.api.fs.updatePlanMeta(filePath, patch)
      setMeta(updated)
    } catch {
      addToast({ id: crypto.randomUUID(), message: 'Failed to update build harness', type: 'error' })
    }
  }, [filePath, meta.buildHarness, currentAgent, addToast])

  const handleAgentSelect = useCallback(async (value: string) => {
    if (value === '__custom') {
      setCustomAgent(true)
      setCustomInput(meta.codingAgent ?? '')
      return
    }
    try {
      const updated = await window.api.fs.updatePlanMeta(filePath, { codingAgent: value || null })
      setMeta(updated)
    } catch {
      addToast({ id: crypto.randomUUID(), message: 'Failed to update coding agent', type: 'error' })
    }
  }, [filePath, meta.codingAgent, addToast])

  const handleCustomAgentSubmit = useCallback(async () => {
    setCustomAgent(false)
    const val = customInput.trim() || null
    try {
      const updated = await window.api.fs.updatePlanMeta(filePath, { codingAgent: val })
      setMeta(updated)
    } catch {
      addToast({ id: crypto.randomUUID(), message: 'Failed to update coding agent', type: 'error' })
    }
  }, [filePath, customInput, addToast])

  const handleRelocate = useCallback(async (targetAgent: PlanAgent, mode: 'copy' | 'move') => {
    if (!worktreePath) return
    setRelocateOpen(false)

    const execute = async () => {
      try {
        const newPath = await window.api.fs.relocateAgentPlan(worktreePath, filePath, targetAgent, mode)
        addToast({
          id: crypto.randomUUID(),
          message: `Plan ${mode === 'move' ? 'moved' : 'copied'} to ${AGENT_TO_PLAN_DIR[targetAgent]}`,
          type: 'info',
        })
        if (mode === 'move' && activeTabId) {
          removeTab(activeTabId)
        }
        openMarkdownPreview(newPath)
      } catch (err) {
        addToast({
          id: crypto.randomUUID(),
          message: `Failed to ${mode} plan: ${err instanceof Error ? err.message : 'unknown error'}`,
          type: 'error',
        })
      }
    }

    if (mode === 'move') {
      showConfirmDialog({
        title: 'Move plan file',
        message: `Move this plan to ${AGENT_TO_PLAN_DIR[targetAgent]}? The original file will be deleted.`,
        confirmLabel: 'Move',
        destructive: true,
        onConfirm: () => {
          dismissConfirmDialog()
          execute()
        },
      })
    } else {
      execute()
    }
  }, [worktreePath, filePath, activeTabId, addToast, openMarkdownPreview, removeTab, showConfirmDialog, dismissConfirmDialog])

  const fileName = filePath.split('/').pop() || filePath
  const dirPath = filePath.split('/').slice(0, -1).join('/')

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.errorState}>
          <span>{error}</span>
          <span className={styles.errorPath}>{filePath}</span>
        </div>
      </div>
    )
  }

  if (content === null) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading...</div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <span className={styles.breadcrumb}>
          <span className={styles.breadcrumbDir}>{dirPath}/</span>
          {fileName}
        </span>
        <div className={styles.toolbarActions}>
          {isPlan && (
            <>
              {/* Coding agent selector */}
              <select
                className={styles.harnessSelect}
                value={meta.buildHarness === null ? '__auto' : meta.buildHarness}
                onChange={(e) => handleHarnessSelect(e.target.value)}
                title="CLI agent for Build (moves plan into this harness folder if needed)"
              >
                <option value="__auto">Match folder ({folderHarnessLabel})</option>
                {BUILD_HARNESS_OPTIONS.map(({ agent, label }) => (
                  <option key={agent} value={agent}>{label}</option>
                ))}
              </select>
              {customAgent ? (
                <input
                  className={styles.customAgentInput}
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCustomAgentSubmit(); if (e.key === 'Escape') setCustomAgent(false) }}
                  onBlur={handleCustomAgentSubmit}
                  placeholder="Model name…"
                  autoFocus
                />
              ) : (
                <select
                  className={styles.agentSelect}
                  value={modelSelectValue}
                  onChange={(e) => handleAgentSelect(e.target.value)}
                  title="Model for selected harness (value is the CLI --model id)"
                >
                  <option value="">No model</option>
                  {agentPresets.map((p) => (
                    <option key={p.cliModel} value={p.cliModel}>
                      {p.label} ({p.cliModel})
                    </option>
                  ))}
                  {effectiveHarness && meta.codingAgent
                    && !findPlanModelPreset(effectiveHarness, meta.codingAgent) && (
                    <option value={modelSelectValue}>{meta.codingAgent}</option>
                  )}
                  <option value="__custom">Custom…</option>
                </select>
              )}

              {/* Built status / Build button */}
              {meta.built ? (
                <button
                  className={`${styles.builtBadge} ${styles.builtBadgeYes}`}
                  onClick={handleUnsetBuilt}
                  title="Click to mark as not built"
                >
                  Built ✓
                </button>
              ) : building ? (
                <span className={styles.buildSpinner} title="Building…">
                  <span className={styles.buildSpinnerDot} />
                </span>
              ) : (
                <button
                  className={styles.buildButton}
                  onClick={handleBuild}
                  title="Launch agent to build this plan"
                >
                  Build
                </button>
              )}

              {/* Relocate dropdown */}
              <div className={styles.relocateWrap} ref={relocateRef}>
                <button
                  className={styles.relocateButton}
                  onClick={() => setRelocateOpen(!relocateOpen)}
                  title="Copy or move to another agent's plan folder"
                >
                  ↗
                </button>
                {relocateOpen && (
                  <div className={styles.relocateDropdown}>
                    {RELOCATE_TARGETS.filter((t) => t.agent !== currentAgent).map((t) => (
                      <div key={t.agent} className={styles.relocateGroup}>
                        <button
                          className={styles.relocateItem}
                          onClick={() => handleRelocate(t.agent, 'copy')}
                        >
                          Copy to {t.label}
                        </button>
                        <button
                          className={styles.relocateItem}
                          onClick={() => handleRelocate(t.agent, 'move')}
                        >
                          Move to {t.label}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          <button
            className={styles.editButton}
            onClick={() => openFileTab(filePath)}
            title="Open in editor"
          >
            ✎ Edit
          </button>
        </div>
      </div>
      <div className={styles.scrollArea}>
        <AddToChatMarkdownSurface filePath={filePath} className={styles.content}>
          <MarkdownRenderer>{content}</MarkdownRenderer>
        </AddToChatMarkdownSurface>
      </div>
    </div>
  )
}

import { useEffect, useState, useCallback, useRef } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '../../store/app-store'
import { useGitGutter } from '../../hooks/useGitGutter'
import styles from './Editor.module.css'

// Disable TS/JS semantic diagnostics globally once — Monaco can't resolve project modules
let diagnosticsConfigured = false
loader.init().then((monaco) => {
  if (diagnosticsConfigured) return
  diagnosticsConfigured = true
  const diagnosticsOff = {
    noSemanticValidation: true,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
  }
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOff)
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOff)
})

interface Props {
  tabId: string
  filePath: string
  active: boolean
  worktreePath?: string
}

// Map file extensions to Monaco language IDs
function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    py: 'python',
    rs: 'rust',
    go: 'go',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    toml: 'ini',
  }
  return map[ext || ''] || 'plaintext'
}

export function FileEditor({ tabId, filePath, active, worktreePath }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState(false)
  const [editorInstance, setEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const currentContentRef = useRef<string>('')
  const setTabUnsaved = useAppStore((s) => s.setTabUnsaved)
  const setTabDeleted = useAppStore((s) => s.setTabDeleted)
  const notifyTabSaved = useAppStore((s) => s.notifyTabSaved)
  const addToast = useAppStore((s) => s.addToast)
  const settings = useAppStore((s) => s.settings)

  // Git gutter decorations (no-op when worktreePath is undefined or editor not mounted)
  useGitGutter(editorInstance, filePath, worktreePath)

  // Load file content
  useEffect(() => {
    let cancelled = false
    window.api.fs.readFile(filePath).then((text) => {
      if (cancelled) return
      if (text === null) {
        // File doesn't exist (e.g. restored tab for a deleted file)
        setTabDeleted(tabId, true)
        setContent('')
        return
      }
      setContent(text)
      currentContentRef.current = text
      setUnsaved(false)
      setTabUnsaved(tabId, false)
    })
    return () => { cancelled = true }
  }, [filePath, tabId, setTabUnsaved, setTabDeleted])

  // Reload file content when in-app git operations (discard, commit) affect this file
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!worktreePath || detail?.worktreePath !== worktreePath) return
      const relPath = filePath.startsWith(worktreePath)
        ? filePath.slice(worktreePath.length).replace(/^\//, '')
        : null
      if (!relPath || !detail.paths?.includes(relPath)) return

      window.api.fs.readFile(filePath).then((text) => {
        if (text === null) {
          // File deleted (untracked discard) — mark tab as deleted
          setTabDeleted(tabId, true)
          return
        }
        setContent(text)
        currentContentRef.current = text
        setUnsaved(false)
        setTabUnsaved(tabId, false)
        setTabDeleted(tabId, false)
      })
    }
    window.addEventListener('git:files-changed', handler)
    return () => window.removeEventListener('git:files-changed', handler)
  }, [filePath, worktreePath, tabId, setTabUnsaved, setTabDeleted])

  // Watch for external file changes (terminal git operations, branch switches)
  useEffect(() => {
    if (!worktreePath) return

    const cleanup = window.api.fs.onDirChanged((changedDir) => {
      if (changedDir !== worktreePath) return

      window.api.fs.readFile(filePath).then((diskContent) => {
        if (diskContent === null) {
          if (!unsaved) {
            setTabDeleted(tabId, true)
          }
          return
        }
        if (diskContent === currentContentRef.current) return
        if (unsaved) {
          addToast({
            id: `file-changed-${tabId}`,
            message: `${filePath.split('/').pop()} changed on disk`,
            type: 'info',
          })
        } else {
          setContent(diskContent)
          currentContentRef.current = diskContent
          setTabDeleted(tabId, false)
        }
      })
    })

    return cleanup
  }, [filePath, worktreePath, tabId, unsaved, setTabUnsaved, setTabDeleted, addToast])

  const handleChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      currentContentRef.current = value
      if (!unsaved) {
        setUnsaved(true)
        setTabUnsaved(tabId, true)
      }
    }
  }, [unsaved, tabId, setTabUnsaved])

  const handleSave = useCallback(async () => {
    await window.api.fs.writeFile(filePath, currentContentRef.current)
    setUnsaved(false)
    setTabUnsaved(tabId, false)
    notifyTabSaved(tabId)
  }, [filePath, tabId, setTabUnsaved, notifyTabSaved])

  // Auto-save on blur when setting is enabled
  const prevActiveRef = useRef(active)
  useEffect(() => {
    if (prevActiveRef.current && !active && unsaved && settings.autoSaveOnBlur) {
      handleSave()
    }
    prevActiveRef.current = active
  }, [active, unsaved, settings.autoSaveOnBlur, handleSave])

  // Cmd+S handler
  const handleEditorMount = useCallback((ed: editor.IStandaloneCodeEditor) => {
    editorRef.current = ed
    setEditorInstance(ed)
    ed.addCommand(
      // Monaco.KeyMod.CtrlCmd | Monaco.KeyCode.KeyS
      2048 | 49,
      () => handleSave()
    )
  }, [handleSave])

  if (content === null) {
    return (
      <div className={styles.editorContainer}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-sm)',
        }}>
          Loading...
        </div>
      </div>
    )
  }

  return (
    <div className={styles.editorContainer}>
      <Editor
        height="100%"
        language={getLanguage(filePath)}
        value={content}
        theme="vs-dark"
        onChange={handleChange}
        onMount={handleEditorMount}
        options={{
          fontFamily: "'SF Mono', Menlo, 'Cascadia Code', monospace",
          fontSize: settings.editorFontSize,
          lineHeight: 20,
          minimap: { enabled: false },
          scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: 'line',
          cursorBlinking: 'smooth',
          smoothScrolling: true,
          tabSize: 2,
          wordWrap: 'off',
          automaticLayout: true,
        }}
      />
    </div>
  )
}

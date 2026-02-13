import { useEffect, useState, useCallback, useRef } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '../../store/app-store'
import { useResolvedTheme } from '../../hooks/useResolvedTheme'
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

export function FileEditor({ tabId, filePath, active }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState(false)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const currentContentRef = useRef<string>('')
  const setTabUnsaved = useAppStore((s) => s.setTabUnsaved)
  const notifyTabSaved = useAppStore((s) => s.notifyTabSaved)
  const settings = useAppStore((s) => s.settings)
  const resolvedTheme = useResolvedTheme()

  // Map resolved theme to Monaco theme
  const monacoTheme = resolvedTheme === 'dark' ? 'vs-dark' : 'vs'

  // Load file content
  useEffect(() => {
    let cancelled = false
    window.api.fs.readFile(filePath).then((text) => {
      if (!cancelled) {
        setContent(text)
        currentContentRef.current = text
        setUnsaved(false)
        setTabUnsaved(tabId, false)
      }
    })
    return () => { cancelled = true }
  }, [filePath, tabId, setTabUnsaved])

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
  const handleEditorMount = useCallback((editorInstance: editor.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance
    editorInstance.addCommand(
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
        theme={monacoTheme}
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

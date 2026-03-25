import { useEffect, useState, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '../../store/app-store'
import { useGitGutter } from '../../hooks/useGitGutter'
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer'
import { AddToChatMarkdownSurface } from '../AddToChat/AddToChatMarkdownSurface'
import { sendAddToChatText } from '../../utils/add-to-chat'
import {
  setMonacoAddToChatHandler,
  clearMonacoAddToChatHandler,
} from '../../utils/add-to-chat-monaco-bridge'
import styles from './Editor.module.css'

import { isLspLanguage, getOrCreateClient, notifyDidOpen, notifyDidClose } from '../../services/lsp-client-manager'

// Configure TS/JS built-in language features
let diagnosticsConfigured = false
loader.init().then((monaco) => {
  if (diagnosticsConfigured) return
  diagnosticsConfigured = true

  const diagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  }
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)

  const compilerOptions: import('monaco-editor').languages.typescript.CompilerOptions = {
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    allowNonTsExtensions: true,
  }
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions)
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

export interface FileEditorHandle {
  focus(): void
}

export const FileEditor = forwardRef<FileEditorHandle, Props>(function FileEditor({ tabId, filePath, active, worktreePath }, ref) {
  const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.mdx')
  /** Prefer rendered view for agent-written plans when opening a markdown file tab. */
  const [previewMode, setPreviewMode] = useState(() =>
    filePath.endsWith('.md') || filePath.endsWith('.mdx'),
  )
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
  const runAddToChatRef = useRef<() => void>(() => {})

  // Git gutter decorations (no-op when worktreePath is undefined or editor not mounted)
  useGitGutter(editorInstance, filePath, worktreePath)

  useImperativeHandle(ref, () => ({
    focus() {
      editorRef.current?.focus()
    },
  }), [])

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

  // LSP lifecycle: connect on mount, notify didClose on unmount
  const lspLanguageRef = useRef<string | null>(null)
  const lspWorkspaceRef = useRef<string | null>(null)

  useEffect(() => {
    const language = getLanguage(filePath)
    if (!isLspLanguage(language) || !worktreePath) return

    lspLanguageRef.current = language
    lspWorkspaceRef.current = worktreePath
    const fileUri = `file://${filePath}`

    // Fire-and-forget: never blocks editor rendering
    getOrCreateClient(language, worktreePath).then((client) => {
      if (client && content !== null) {
        notifyDidOpen(language, worktreePath!, fileUri, content, language)
      }
    }).catch(() => {})

    return () => {
      if (lspLanguageRef.current && lspWorkspaceRef.current) {
        notifyDidClose(lspLanguageRef.current, lspWorkspaceRef.current, fileUri)
      }
    }
  }, [filePath, worktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd+S + Cmd+L fallback (2048 = CtrlCmd). Primary ⌘L path: useShortcuts capture + monaco bridge.
  const handleEditorMount = useCallback((ed: editor.IStandaloneCodeEditor) => {
    editorRef.current = ed
    setEditorInstance(ed)
    ed.addCommand(2048 | 49, () => handleSave())
    ed.addCommand(2048 | 42, () => runAddToChatRef.current())
  }, [handleSave])

  useEffect(() => {
    const ed = editorInstance
    if (!ed) return

    runAddToChatRef.current = () => {
      const selection = ed.getSelection()
      const model = ed.getModel()
      if (!selection || !model || selection.isEmpty()) {
        addToast({
          id: crypto.randomUUID(),
          message: 'Select text to add to the terminal',
          type: 'info',
        })
        return
      }
      const text = model.getValueInRange(selection)
      sendAddToChatText(filePath, getLanguage(filePath), text)
    }

    const subFocus = ed.onDidFocusEditorWidget(() => {
      setMonacoAddToChatHandler(ed, () => runAddToChatRef.current())
    })
    const subBlur = ed.onDidBlurEditorWidget(() => {
      clearMonacoAddToChatHandler(ed)
    })

    if (ed.hasTextFocus()) {
      setMonacoAddToChatHandler(ed, () => runAddToChatRef.current())
    }

    return () => {
      subFocus.dispose()
      subBlur.dispose()
      clearMonacoAddToChatHandler(ed)
    }
  }, [editorInstance, filePath, addToast])

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
      {isMarkdown && (
        <div className={styles.diffToolbar}>
          <span className={styles.diffLabel}>{filePath.split('/').pop()}</span>
          <div className={styles.diffToggle}>
            <button
              className={`${styles.diffToggleOption} ${!previewMode ? styles.active : ''}`}
              onClick={() => setPreviewMode(false)}
            >
              Source
            </button>
            <button
              className={`${styles.diffToggleOption} ${previewMode ? styles.active : ''}`}
              onClick={() => setPreviewMode(true)}
            >
              Preview
            </button>
          </div>
        </div>
      )}
      {previewMode && isMarkdown ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
          <AddToChatMarkdownSurface filePath={filePath}>
            <div style={{ maxWidth: 760, margin: '0 auto' }}>
              <MarkdownRenderer>{content}</MarkdownRenderer>
            </div>
          </AddToChatMarkdownSurface>
        </div>
      ) : (
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
      )}
    </div>
  )
})

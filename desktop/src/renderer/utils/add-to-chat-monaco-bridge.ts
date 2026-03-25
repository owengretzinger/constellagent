import type { editor } from 'monaco-editor'

type Run = () => void

let focused: { ed: editor.IStandaloneCodeEditor; run: Run } | null = null

export function setMonacoAddToChatHandler(ed: editor.IStandaloneCodeEditor, run: Run) {
  focused = { ed, run }
}

export function clearMonacoAddToChatHandler(ed: editor.IStandaloneCodeEditor) {
  if (focused?.ed === ed) focused = null
}

/** Invoked from capture-phase ⌘L when focus is inside Monaco. */
export function runMonacoAddToChatIfFocused(): boolean {
  if (!focused) return false
  focused.run()
  return true
}

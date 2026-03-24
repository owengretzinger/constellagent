/** Map file extensions to Monaco language IDs / markdown fence tags. */
const EXT_MAP: Record<string, string> = {
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

export function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  return EXT_MAP[ext || ''] || 'plaintext'
}

/** Short fence tag for markdown code blocks (e.g. "ts" not "typescript"). */
const FENCE_MAP: Record<string, string> = {
  typescript: 'ts',
  typescriptreact: 'tsx',
  javascript: 'js',
  javascriptreact: 'jsx',
  python: 'py',
  shell: 'sh',
}

export function getFenceTag(path: string): string {
  const lang = getLanguage(path)
  return FENCE_MAP[lang] || lang
}

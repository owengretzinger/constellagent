import type { ChatSnippet } from '../store/types'
import { getFenceTag } from './language-map'

const MAX_CONTEXT_CHARS = 10_000

export function formatChatContext(snippets: ChatSnippet[]): string {
  const parts: string[] = []

  for (const s of snippets) {
    let header = ''
    if (s.filePath) {
      header = `@${s.filePath}`
      if (s.startLine != null) {
        header += `:${s.startLine}`
        if (s.endLine != null && s.endLine !== s.startLine) {
          header += `-${s.endLine}`
        }
      }
    }

    const fence = s.filePath ? getFenceTag(s.filePath) : ''
    const block = fence
      ? `\`\`\`${fence}\n${s.text}\n\`\`\``
      : s.text

    parts.push(header ? `${header}\n${block}` : block)
  }

  let result = parts.join('\n\n')

  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.slice(0, MAX_CONTEXT_CHARS) + '\n\n[...truncated]'
  }

  return result
}

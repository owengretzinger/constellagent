// Annotation types for human review comments on PR diffs

export interface Annotation {
  id: string
  file: string           // relative path within worktree
  line: number           // line number in the diff
  side: 'additions' | 'deletions'
  body: string           // the review comment
  author: string         // 'human' or username
  resolved: boolean
  createdAt: string      // ISO timestamp
}

let _counter = 0

export function generateAnnotationId(): string {
  _counter++
  return `ann_${Date.now()}_${_counter}_${Math.random().toString(36).slice(2, 8)}`
}

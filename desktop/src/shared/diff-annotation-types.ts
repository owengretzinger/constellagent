/**
 * Human review comments on diffs, persisted at `{worktree}/.constellagent/annotations.json`.
 * Agents and hooks should read that JSON file as the canonical store.
 */

export const ANNOTATIONS_FILE_VERSION = 1 as const

/** Matches @pierre/diffs AnnotationSide */
export type DiffAnnotationSide = 'additions' | 'deletions'

export interface DiffAnnotation {
  id: string
  /** Repo-relative path (same as git status / DiffFileData.filePath) */
  filePath: string
  side: DiffAnnotationSide
  /** First line of the comment range (inclusive), as shown in the diff gutter for `side`. */
  lineNumber: number
  /** Last line of the range (inclusive). Omit when the comment is a single line. */
  lineEnd?: number
  body: string
  createdAt: string
  resolved: boolean
}

export interface DiffAnnotationsFile {
  version: typeof ANNOTATIONS_FILE_VERSION
  annotations: DiffAnnotation[]
}

export function generateAnnotationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `da_${crypto.randomUUID()}`
  }
  return `da_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

export type DiffAnnotationAddInput = Pick<DiffAnnotation, 'filePath' | 'side' | 'lineNumber' | 'body'> & {
  lineEnd?: number
}

/** Inclusive end line for display / agents (defaults to lineNumber). */
export function annotationLineEnd(a: Pick<DiffAnnotation, 'lineNumber' | 'lineEnd'>): number {
  const end = a.lineEnd
  return end != null && Number.isFinite(end) ? end : a.lineNumber
}

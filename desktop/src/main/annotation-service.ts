import { join } from 'path'
import { watch, type FSWatcher } from 'fs'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { loadJsonFile, saveJsonFile } from './claude-config'
import {
  ANNOTATIONS_FILE_VERSION,
  type DiffAnnotation,
  type DiffAnnotationAddInput,
  type DiffAnnotationsFile,
  generateAnnotationId,
} from '../shared/diff-annotation-types'

function constellagentDir(worktreePath: string): string {
  return join(worktreePath, '.constellagent')
}

function annotationsPath(worktreePath: string): string {
  return join(constellagentDir(worktreePath), 'annotations.json')
}

let notifyFn: ((worktreePath: string) => void) | null = null

const debouncers = new Map<string, ReturnType<typeof setTimeout>>()
const watchers = new Map<string, FSWatcher>()

export function setAnnotationNotify(fn: (worktreePath: string) => void): void {
  notifyFn = fn
}

function scheduleNotify(worktreePath: string): void {
  const prev = debouncers.get(worktreePath)
  if (prev) clearTimeout(prev)
  debouncers.set(
    worktreePath,
    setTimeout(() => {
      debouncers.delete(worktreePath)
      notifyFn?.(worktreePath)
    }, 150),
  )
}

function isValidAnnotation(x: unknown): x is DiffAnnotation {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (
    typeof o.id !== 'string' ||
    typeof o.filePath !== 'string' ||
    (o.side !== 'additions' && o.side !== 'deletions') ||
    typeof o.lineNumber !== 'number' ||
    !Number.isFinite(o.lineNumber) ||
    typeof o.body !== 'string' ||
    typeof o.createdAt !== 'string' ||
    typeof o.resolved !== 'boolean'
  ) {
    return false
  }
  if (o.lineEnd !== undefined) {
    if (typeof o.lineEnd !== 'number' || !Number.isFinite(o.lineEnd)) return false
    if (o.lineEnd < o.lineNumber) return false
  }
  return true
}

function normalizeDoc(raw: unknown): DiffAnnotationsFile {
  if (!raw || typeof raw !== 'object') {
    return { version: ANNOTATIONS_FILE_VERSION, annotations: [] }
  }
  const r = raw as Record<string, unknown>
  const list = Array.isArray(r.annotations) ? r.annotations.filter(isValidAnnotation) : []
  return { version: ANNOTATIONS_FILE_VERSION, annotations: list }
}

function ensureWatch(worktreePath: string): void {
  if (watchers.has(worktreePath)) return
  const dir = constellagentDir(worktreePath)
  if (!existsSync(dir)) return
  try {
    const w = watch(dir, (_event, filename) => {
      if (filename !== 'annotations.json') return
      scheduleNotify(worktreePath)
    })
    w.on('error', () => {})
    watchers.set(worktreePath, w)
  } catch {
    // ignore
  }
}

export function cleanupAnnotationWatchers(): void {
  for (const w of watchers.values()) {
    w.close()
  }
  watchers.clear()
  for (const t of debouncers.values()) {
    clearTimeout(t)
  }
  debouncers.clear()
}

export const AnnotationService = {
  async load(worktreePath: string): Promise<DiffAnnotation[]> {
    ensureWatch(worktreePath)
    const path = annotationsPath(worktreePath)
    const doc = normalizeDoc(await loadJsonFile(path, null))
    return doc.annotations
  },

  async add(worktreePath: string, input: DiffAnnotationAddInput): Promise<DiffAnnotation> {
    const body = input.body.trim()
    if (!body) {
      throw new Error('Annotation body is empty')
    }
    if (input.lineEnd != null) {
      if (!Number.isFinite(input.lineEnd) || input.lineEnd < input.lineNumber) {
        throw new Error('Invalid line range')
      }
    }
    await mkdir(constellagentDir(worktreePath), { recursive: true })
    ensureWatch(worktreePath)
    const path = annotationsPath(worktreePath)
    const doc = normalizeDoc(await loadJsonFile(path, null))
    const ann: DiffAnnotation = {
      id: generateAnnotationId(),
      filePath: input.filePath,
      side: input.side,
      lineNumber: input.lineNumber,
      ...(input.lineEnd != null && input.lineEnd > input.lineNumber ? { lineEnd: input.lineEnd } : {}),
      body,
      createdAt: new Date().toISOString(),
      resolved: false,
    }
    doc.annotations.push(ann)
    await saveJsonFile(path, doc)
    scheduleNotify(worktreePath)
    return ann
  },

  async resolve(worktreePath: string, id: string): Promise<void> {
    const path = annotationsPath(worktreePath)
    const doc = normalizeDoc(await loadJsonFile(path, null))
    const ann = doc.annotations.find((a) => a.id === id)
    if (ann) ann.resolved = true
    await saveJsonFile(path, doc)
    ensureWatch(worktreePath)
    scheduleNotify(worktreePath)
  },

  async delete(worktreePath: string, id: string): Promise<void> {
    const path = annotationsPath(worktreePath)
    const doc = normalizeDoc(await loadJsonFile(path, null))
    doc.annotations = doc.annotations.filter((a) => a.id !== id)
    await saveJsonFile(path, doc)
    ensureWatch(worktreePath)
    scheduleNotify(worktreePath)
  },
}

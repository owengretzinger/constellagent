import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { watch, type FSWatcher } from 'fs'
import type { Annotation } from '../shared/diff-annotation-types'

const ANNOTATIONS_DIR = '.constellagent'
const ANNOTATIONS_FILE = 'annotations.json'

function annotationsPath(worktreePath: string): string {
  return join(worktreePath, ANNOTATIONS_DIR, ANNOTATIONS_FILE)
}

export async function loadAnnotations(worktreePath: string): Promise<Annotation[]> {
  const filePath = annotationsPath(worktreePath)
  if (!existsSync(filePath)) return []
  try {
    const raw = await readFile(filePath, 'utf-8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

async function writeAnnotations(worktreePath: string, annotations: Annotation[]): Promise<void> {
  const dir = join(worktreePath, ANNOTATIONS_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(annotationsPath(worktreePath), JSON.stringify(annotations, null, 2), 'utf-8')
}

export async function saveAnnotation(worktreePath: string, annotation: Annotation): Promise<Annotation[]> {
  const annotations = await loadAnnotations(worktreePath)
  annotations.push(annotation)
  await writeAnnotations(worktreePath, annotations)
  return annotations
}

export async function resolveAnnotation(worktreePath: string, id: string): Promise<Annotation[]> {
  const annotations = await loadAnnotations(worktreePath)
  const target = annotations.find((a) => a.id === id)
  if (target) target.resolved = true
  await writeAnnotations(worktreePath, annotations)
  return annotations
}

export async function deleteAnnotation(worktreePath: string, id: string): Promise<Annotation[]> {
  let annotations = await loadAnnotations(worktreePath)
  annotations = annotations.filter((a) => a.id !== id)
  await writeAnnotations(worktreePath, annotations)
  return annotations
}

// File watcher for external changes (e.g. agent resolves an annotation)
const watchers = new Map<string, FSWatcher>()

export function watchAnnotations(
  worktreePath: string,
  onChange: () => void,
): () => void {
  const filePath = annotationsPath(worktreePath)
  // Ensure the directory exists so we can watch
  const dir = join(worktreePath, ANNOTATIONS_DIR)
  if (!existsSync(dir)) {
    try { require('fs').mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  }

  // Debounce to avoid duplicate events
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const key = worktreePath

  if (watchers.has(key)) {
    watchers.get(key)!.close()
  }

  try {
    // Watch the directory for changes to the annotations file
    const watcher = watch(dir, (eventType, filename) => {
      if (filename === ANNOTATIONS_FILE) {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(onChange, 200)
      }
    })
    watchers.set(key, watcher)
    return () => {
      watcher.close()
      watchers.delete(key)
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  } catch {
    // If watch fails, return a no-op cleanup
    return () => {}
  }
}

export function closeAllAnnotationWatchers(): void {
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
}

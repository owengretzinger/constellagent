import {
  readdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
  rename as fsRename,
  rm,
} from 'fs/promises'
import { dirname, join, relative } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

function isEnvFile(name: string): boolean {
  return /^\.env($|\.)/.test(name)
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  gitStatus?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
}

// Directories to always skip
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.DS_Store', 'dist', 'build',
  '.next', '.cache', '__pycache__', '.venv', 'venv',
  'coverage', '.nyc_output',
])

interface TreeEntry {
  path: string
  type: 'file' | 'directory'
}

function shouldIncludeDirectory(name: string): boolean {
  return !name.startsWith('.') && !SKIP_DIRS.has(name)
}

function shouldIncludeFile(name: string): boolean {
  return (!name.startsWith('.') || name === '.gitignore' || isEnvFile(name)) && !SKIP_DIRS.has(name)
}

export class FileService {
  static async getTree(dirPath: string, depth = 0): Promise<FileNode[]> {
    if (depth > 8) return [] // prevent infinite recursion

    // Use git ls-files if in a git repo for gitignore respect
    if (depth === 0) {
      try {
        return await this.getGitTree(dirPath)
      } catch {
        // Fall back to manual traversal
      }
    }

    const entries = await readdir(dirPath, { withFileTypes: true })
    const nodes: FileNode[] = []

    const sorted = entries
      .filter((e) => e.isDirectory() ? shouldIncludeDirectory(e.name) : shouldIncludeFile(e.name))
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

    for (const entry of sorted) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        const children = await this.getTree(fullPath, depth + 1)
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        })
      } else {
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'file',
        })
      }
    }

    return nodes
  }

  private static async getGitTree(dirPath: string): Promise<FileNode[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--cached', '--exclude-standard'],
      { cwd: dirPath }
    )

    const files = stdout.trim().split('\n').filter(Boolean).map((filePath) => ({
      path: filePath,
      type: 'file' as const,
    }))
    const envFiles = await this.findEnvFiles(dirPath)
    const directories = await this.findVisibleDirectories(dirPath)
    const merged = new Map<string, TreeEntry>()

    for (const entry of [...files, ...envFiles.map((filePath) => ({ path: filePath, type: 'file' as const })), ...directories.map((directoryPath) => ({ path: directoryPath, type: 'directory' as const }))]) {
      merged.set(`${entry.type}:${entry.path}`, entry)
    }

    return this.buildTreeFromEntries(dirPath, Array.from(merged.values()))
  }

  private static async findEnvFiles(basePath: string, currentPath = basePath, depth = 0): Promise<string[]> {
    if (depth > 8) return []

    const entries = await readdir(currentPath, { withFileTypes: true })
    const files: string[] = []

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue

      const fullPath = join(currentPath, entry.name)
      if (entry.isDirectory()) {
        if (!shouldIncludeDirectory(entry.name)) continue
        files.push(...await this.findEnvFiles(basePath, fullPath, depth + 1))
        continue
      }

      if (!entry.isFile() || !isEnvFile(entry.name)) continue

      files.push(relative(basePath, fullPath).replaceAll('\\', '/'))
    }

    return files
  }

  private static async findVisibleDirectories(basePath: string, currentPath = basePath, depth = 0): Promise<string[]> {
    if (depth > 8) return []

    const entries = await readdir(currentPath, { withFileTypes: true })
    const directories: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory() || !shouldIncludeDirectory(entry.name)) continue

      const fullPath = join(currentPath, entry.name)
      directories.push(relative(basePath, fullPath).replaceAll('\\', '/'))
      directories.push(...await this.findVisibleDirectories(basePath, fullPath, depth + 1))
    }

    return directories
  }

  private static buildTreeFromEntries(basePath: string, entries: TreeEntry[]): FileNode[] {
    const root: FileNode = { name: '', path: basePath, type: 'directory', children: [] }

    for (const entry of entries) {
      const parts = entry.path.split('/').filter(Boolean)
      if (parts.length === 0) continue
      let current = root

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isLeaf = i === parts.length - 1
        const nodeType: FileNode['type'] = isLeaf ? entry.type : 'directory'
        const fullPath = join(basePath, ...parts.slice(0, i + 1))
        const existing = current.children!.find(
          (child) => child.name === part && child.type === nodeType
        )

        if (nodeType === 'file') {
          if (!existing) {
            current.children!.push({ name: part, path: fullPath, type: 'file' })
          }
        } else {
          let dir = existing
          if (!dir) {
            dir = { name: part, path: fullPath, type: 'directory', children: [] }
            current.children!.push(dir)
          }
          current = dir
        }
      }
    }

    // Sort: directories first, then alphabetical
    const sortNodes = (nodes: FileNode[]): FileNode[] => {
      nodes.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      })
      for (const node of nodes) {
        if (node.children) sortNodes(node.children)
      }
      return nodes
    }

    return sortNodes(root.children || [])
  }

  static async readFile(filePath: string): Promise<string> {
    return fsReadFile(filePath, 'utf-8')
  }

  static async writeFile(filePath: string, content: string): Promise<void> {
    await fsWriteFile(filePath, content, 'utf-8')
  }

  static async createFile(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    await fsWriteFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
  }

  static async createDirectory(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: false })
  }

  static async renamePath(oldPath: string, newPath: string): Promise<void> {
    await fsRename(oldPath, newPath)
  }

  static async deletePath(targetPath: string): Promise<void> {
    await rm(targetPath, { recursive: true, force: false })
  }
}

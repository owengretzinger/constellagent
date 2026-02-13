import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, stat, rm } from 'fs/promises'
import { join, relative } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

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
      .filter((e) => !e.name.startsWith('.') || e.name === '.gitignore')
      .filter((e) => !SKIP_DIRS.has(e.name))
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

    const files = stdout.trim().split('\n').filter(Boolean)
    return this.buildTreeFromPaths(dirPath, files)
  }

  private static buildTreeFromPaths(basePath: string, paths: string[]): FileNode[] {
    const root: FileNode = { name: '', path: basePath, type: 'directory', children: [] }

    for (const filePath of paths) {
      const parts = filePath.split('/')
      let current = root

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isFile = i === parts.length - 1
        const fullPath = join(basePath, ...parts.slice(0, i + 1))

        if (isFile) {
          current.children!.push({ name: part, path: fullPath, type: 'file' })
        } else {
          let dir = current.children!.find(
            (c) => c.name === part && c.type === 'directory'
          )
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

  static async deleteFile(filePath: string): Promise<void> {
    const info = await stat(filePath)
    await rm(filePath, { recursive: info.isDirectory(), force: false })
  }
}

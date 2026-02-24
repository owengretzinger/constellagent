import { readdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises'
import { join, posix, relative } from 'path'
import { execInPath, execSshScript, formatTargetPath, parsePathTarget } from './remote-exec'

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

const MAX_DEPTH = 8

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

export class FileService {
  static async getTree(dirPath: string, depth = 0): Promise<FileNode[]> {
    const target = parsePathTarget(dirPath)
    if (target.kind === 'ssh') {
      if (depth > 0) return []
      try {
        return await this.getGitTree(dirPath)
      } catch {
        return []
      }
    }

    if (depth > MAX_DEPTH) return [] // prevent infinite recursion

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
      .filter((e) => !e.name.startsWith('.') || e.name === '.gitignore' || isEnvFile(e.name))
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
    const { stdout } = await execInPath(
      dirPath,
      'git',
      ['ls-files', '--others', '--cached', '--exclude-standard'],
      { maxBuffer: 20 * 1024 * 1024 }
    )

    const files = stdout.trim().split('\n').filter(Boolean)
    const envFiles = await this.findEnvFiles(dirPath)
    const merged = Array.from(new Set([...files, ...envFiles]))
    return this.buildTreeFromPaths(dirPath, merged)
  }

  private static async findEnvFiles(basePath: string, currentPath = basePath, depth = 0): Promise<string[]> {
    const target = parsePathTarget(basePath)
    if (target.kind === 'ssh') {
      const findArgs = ['.', '-maxdepth', String(MAX_DEPTH + 1), '(']
      const skipDirs = Array.from(SKIP_DIRS)
      for (let i = 0; i < skipDirs.length; i++) {
        findArgs.push('-name', skipDirs[i])
        if (i < skipDirs.length - 1) findArgs.push('-o')
      }
      findArgs.push(')', '-type', 'd', '-prune', '-o', '-type', 'f', '-name', '.env*', '-print')

      const { stdout } = await execInPath(basePath, 'find', findArgs, {
        maxBuffer: 20 * 1024 * 1024,
      })
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^\.\//, ''))
    }

    if (depth > MAX_DEPTH) return []

    const entries = await readdir(currentPath, { withFileTypes: true })
    const files: string[] = []

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue

      const fullPath = join(currentPath, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        files.push(...await this.findEnvFiles(basePath, fullPath, depth + 1))
        continue
      }

      if (!entry.isFile() || !isEnvFile(entry.name)) continue

      files.push(relative(basePath, fullPath).replaceAll('\\', '/'))
    }

    return files
  }

  private static buildTreeFromPaths(basePath: string, paths: string[]): FileNode[] {
    const target = parsePathTarget(basePath)
    const root: FileNode = { name: '', path: basePath, type: 'directory', children: [] }

    for (const filePath of paths) {
      const parts = filePath.split('/').filter(Boolean)
      if (parts.length === 0) continue
      let current = root

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isFile = i === parts.length - 1
        const relPath = parts.slice(0, i + 1).join('/')
        const fullPath = target.kind === 'ssh'
          ? formatTargetPath(target, posix.join(target.path, relPath))
          : join(basePath, ...parts.slice(0, i + 1))

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
    const target = parsePathTarget(filePath)
    if (target.kind === 'ssh') {
      const fileName = posix.basename(target.path)
      const cwd = formatTargetPath(target, posix.dirname(target.path))
      const { stdout } = await execInPath(cwd, 'cat', [fileName], {
        maxBuffer: 20 * 1024 * 1024,
      })
      return stdout
    }
    return fsReadFile(filePath, 'utf-8')
  }

  static async writeFile(filePath: string, content: string): Promise<void> {
    const target = parsePathTarget(filePath)
    if (target.kind === 'ssh') {
      const remoteDir = posix.dirname(target.path)
      const encoded = Buffer.from(content, 'utf-8').toString('base64')
      const pyScript = `import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode(sys.argv[2]))`
      const script = [
        `mkdir -p ${shellQuote(remoteDir)}`,
        `python3 -c ${shellQuote(pyScript)} ${shellQuote(target.path)} ${shellQuote(encoded)}`,
      ].join(' && ')
      await execSshScript(target.host, script, {
        maxBuffer: 512 * 1024,
      })
      return
    }
    await fsWriteFile(filePath, content, 'utf-8')
  }
}

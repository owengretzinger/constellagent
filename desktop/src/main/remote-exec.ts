import { execFile } from 'child_process'
import { formatSshPath, parseSshPath } from '../shared/ssh-path'

const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024
const DEFAULT_SSH_TIMEOUT = 300_000

interface ExecOptions {
  timeout?: number
  maxBuffer?: number
  input?: string | Buffer
}

type ExecFileResult = { stdout: string | Buffer; stderr: string | Buffer }

export type PathTarget =
  | { kind: 'local'; path: string }
  | { kind: 'ssh'; host: string; path: string }

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function resolveExecOptions(options?: ExecOptions): ExecOptions {
  return {
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
    input: options?.input,
  }
}

function resolveSshExecOptions(options?: ExecOptions): ExecOptions {
  const resolved = resolveExecOptions(options)
  return {
    ...resolved,
    timeout: resolved.timeout ?? DEFAULT_SSH_TIMEOUT,
  }
}

async function execFileWithOptionalInput(
  file: string,
  args: string[],
  options?: ExecOptions & { cwd?: string }
): Promise<ExecFileResult> {
  const { input, ...execOptions } = options ?? {}

  return new Promise<ExecFileResult>((resolve, reject) => {
    const child = execFile(file, args, execOptions, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr: stderr ?? '' })
    })

    if (child.stdin) {
      child.stdin.on('error', () => {
        // Ignore broken pipe when a command exits before consuming stdin.
      })
      if (input !== undefined) child.stdin.end(input)
      else child.stdin.end()
    }
  })
}

export function parsePathTarget(path: string): PathTarget {
  const parsed = parseSshPath(path)
  if (!parsed) return { kind: 'local', path }
  return { kind: 'ssh', host: parsed.host, path: parsed.remotePath }
}

export function formatTargetPath(target: PathTarget, path: string): string {
  return target.kind === 'local' ? path : formatSshPath(target.host, path)
}

export function unwrapPathForTarget(target: PathTarget, candidate: string): string {
  if (target.kind === 'local') return candidate

  const parsed = parseSshPath(candidate)
  if (!parsed) return candidate
  if (parsed.host !== target.host) {
    throw new Error(`Path host mismatch: expected "${target.host}", got "${parsed.host}"`)
  }
  return parsed.remotePath
}

export async function execInPath(
  cwdPath: string,
  command: string,
  args: string[],
  options?: ExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const target = parsePathTarget(cwdPath)
  const execOptions = resolveExecOptions(options)

  if (target.kind === 'local') {
    const { stdout, stderr } = await execFileWithOptionalInput(command, args, {
      cwd: target.path,
      ...execOptions,
    })
    return {
      stdout: String(stdout),
      stderr: String(stderr ?? ''),
    }
  }

  return execSshInDir(target.host, target.path, command, args, execOptions)
}

export async function execSshInDir(
  host: string,
  dirPath: string,
  command: string,
  args: string[],
  options?: ExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const script = `cd ${shellQuote(dirPath)} && ${[command, ...args].map(shellQuote).join(' ')}`
  return execSshScript(host, script, options)
}

export async function execSshScript(
  host: string,
  script: string,
  options?: ExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const execOptions = resolveSshExecOptions(options)
  const remoteCommand = `sh -lc ${shellQuote(script)}`
  const { stdout, stderr } = await execFileWithOptionalInput('ssh', [host, '--', remoteCommand], execOptions)
  return {
    stdout: String(stdout),
    stderr: String(stderr ?? ''),
  }
}

export async function remotePathExists(host: string, remotePath: string): Promise<boolean> {
  try {
    await execSshScript(host, `test -e ${shellQuote(remotePath)}`, { timeout: 5000, maxBuffer: 64 * 1024 })
    return true
  } catch {
    return false
  }
}

export async function removeRemotePath(host: string, remotePath: string): Promise<void> {
  await execSshScript(host, `rm -rf ${shellQuote(remotePath)}`, { timeout: 30_000, maxBuffer: 512 * 1024 })
}

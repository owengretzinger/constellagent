import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { request } from 'http'

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const req = request(url, { method: 'GET', timeout: 5000 }, (res) => {
        res.resume()
        const code = res.statusCode ?? 0
        if (code >= 200 && code < 500) {
          resolve()
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('T3 Code HTTP did not respond in time'))
        } else {
          setTimeout(tryOnce, 200)
        }
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error('T3 Code HTTP did not respond in time'))
        } else {
          setTimeout(tryOnce, 200)
        }
      })
      req.end()
    }
    tryOnce()
  })
}

type Managed = { proc: ChildProcess; port: number }

class T3CodeService {
  private byCwd = new Map<string, Managed>()
  private starting = new Map<string, Promise<string>>()

  async start(cwd: string): Promise<string> {
    const existing = this.byCwd.get(cwd)
    if (existing) {
      return `http://127.0.0.1:${existing.port}`
    }

    const pending = this.starting.get(cwd)
    if (pending) return pending

    const p = this.startImpl(cwd).finally(() => {
      this.starting.delete(cwd)
    })
    this.starting.set(cwd, p)
    return p
  }

  private async startImpl(cwd: string): Promise<string> {
    const port = await getFreePort()
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const args = [
      '--yes',
      't3',
      '--no-browser',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--mode',
      'desktop',
    ]

    const proc = spawn(npx, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let buf = ''

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.stdout?.off('data', onReady)
        proc.stderr?.off('data', onReady)
        proc.removeListener('exit', onExitEarly)
        proc.kill('SIGTERM')
        reject(new Error('T3 Code server startup timed out (60s). Is `npx t3` available?'))
      }, 60_000)

      const onReady = (d: Buffer): void => {
        buf += d.toString()
        if (buf.length > 120_000) buf = buf.slice(-60_000)
        if (buf.includes('T3 Code running')) {
          clearTimeout(timer)
          proc.stdout?.off('data', onReady)
          proc.stderr?.off('data', onReady)
          proc.removeListener('exit', onExitEarly)
          resolve()
        }
      }

      const onExitEarly = (code: number | null, signal: NodeJS.Signals | null): void => {
        clearTimeout(timer)
        proc.stdout?.off('data', onReady)
        proc.stderr?.off('data', onReady)
        reject(
          new Error(
            `T3 Code exited before ready (${signal || `code ${code}`}). ${buf.slice(-1200)}`
          )
        )
      }

      proc.stdout?.on('data', onReady)
      proc.stderr?.on('data', onReady)
      proc.once('exit', onExitEarly)
    })

    const url = `http://127.0.0.1:${port}`
    await waitForHttpOk(url, 20_000)

    proc.once('exit', () => {
      this.byCwd.delete(cwd)
    })

    this.byCwd.set(cwd, { proc, port })
    return url
  }

  stop(cwd: string): void {
    const m = this.byCwd.get(cwd)
    if (!m) return
    m.proc.kill('SIGTERM')
    this.byCwd.delete(cwd)
  }

  stopAll(): void {
    for (const cwd of [...this.byCwd.keys()]) {
      this.stop(cwd)
    }
  }
}

export const t3codeService = new T3CodeService()

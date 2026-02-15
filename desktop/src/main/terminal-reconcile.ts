import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { app } from 'electron'
import { join } from 'path'
import { getTerminalHostClient } from './lib/terminal-host/client'

interface PersistedTab {
  type?: string
  ptyId?: string
}

interface PersistedState {
  tabs?: PersistedTab[]
}

function stateFilePath(): string {
  return join(app.getPath('userData'), 'constellagent-state.json')
}

export async function reconcileTerminalSessionsOnStartup(): Promise<void> {
  const client = getTerminalHostClient()
  let state: PersistedState = {}

  try {
    const path = stateFilePath()
    if (existsSync(path)) {
      const raw = await readFile(path, 'utf8')
      state = JSON.parse(raw) as PersistedState
    }
  } catch {
    state = {}
  }

  const validSessionIds = new Set(
    (state.tabs || [])
      .filter((tab) => tab.type === 'terminal')
      .map((tab) => tab.ptyId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )

  try {
    const listed = await client.listSessions()
    for (const session of listed.sessions) {
      if (!validSessionIds.has(session.sessionId)) {
        await client.kill({ sessionId: session.sessionId }).catch(() => {})
      }
    }
  } catch {
    // Best-effort reconcile.
  }
}

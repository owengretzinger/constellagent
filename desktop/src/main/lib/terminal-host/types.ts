export const TERMINAL_HOST_PROTOCOL_VERSION = 1

export interface TerminalHostHelloRequest {
  token: string
  protocolVersion: number
  clientId: string
  role: 'control' | 'stream'
}

export interface TerminalHostCreateOrAttachRequest {
  sessionId: string
  workspaceId: string
  cwd: string
  cols: number
  rows: number
  shell?: string
  env?: Record<string, string>
  useLoginShell?: boolean
}

export interface TerminalHostWriteRequest {
  sessionId: string
  data: string
}

export interface TerminalHostResizeRequest {
  sessionId: string
  cols: number
  rows: number
}

export interface TerminalHostDetachRequest {
  sessionId: string
}

export interface TerminalHostKillRequest {
  sessionId: string
}

export interface TerminalHostSessionInfo {
  sessionId: string
  workspaceId: string
  cols: number
  rows: number
  pid: number
  attachedClients: number
}

export interface TerminalHostListSessionsResponse {
  sessions: TerminalHostSessionInfo[]
}

export interface TerminalHostSnapshot {
  snapshotAnsi: string
  cols: number
  rows: number
}

export interface TerminalHostCreateOrAttachResponse {
  isNew: boolean
  snapshot: TerminalHostSnapshot
  pid: number
}

export interface TerminalHostEmptyResponse {
  success: true
}

export interface TerminalHostHelloResponse {
  protocolVersion: number
  daemonPid: number
}

export interface TerminalHostShutdownRequest {
  killSessions?: boolean
}

export interface TerminalHostRequest {
  id: string
  type: string
  payload: unknown
}

export interface TerminalHostSuccessResponse {
  id: string
  ok: true
  payload: unknown
}

export interface TerminalHostErrorResponse {
  id: string
  ok: false
  error: {
    code: string
    message: string
  }
}

export type TerminalHostResponse = TerminalHostSuccessResponse | TerminalHostErrorResponse

export interface TerminalHostEventEnvelope {
  type: 'event'
  event: 'data' | 'exit' | 'error'
  sessionId: string
  payload:
    | { type: 'data'; data: string }
    | { type: 'exit'; exitCode: number }
    | { type: 'error'; error: string }
}

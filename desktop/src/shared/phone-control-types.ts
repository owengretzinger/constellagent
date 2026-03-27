export interface PhoneControlSettings {
  enabled: boolean
  contactId: string
  notifyOnStart: boolean
  notifyOnFinish: boolean
  streamOutput: boolean
  streamIntervalSec: number
}

export const DEFAULT_PHONE_CONTROL_SETTINGS: PhoneControlSettings = {
  enabled: false,
  contactId: '',
  notifyOnStart: true,
  notifyOnFinish: true,
  streamOutput: false,
  streamIntervalSec: 10,
}

/** Returned by main process for Phone Control UI (permissions, dev vs release binary path). */
export interface PhoneControlStatus {
  running: boolean
  contactId: string
  sessionCount: number
  /** macOS path to the running executable — add this app in Full Disk Access (dev: Electron.app). */
  executablePathForPermissions: string
  /** Set when Messages DB cannot be read (usually missing Full Disk Access). */
  permissionError: string | null
}

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

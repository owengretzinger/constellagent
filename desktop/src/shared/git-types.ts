export interface GitLogEntry {
  hash: string
  parents: string[]
  message: string
  refs: string[]       // e.g. ["HEAD -> main", "origin/main"]
  author: string
  relativeDate: string // e.g. "2 days ago"
}

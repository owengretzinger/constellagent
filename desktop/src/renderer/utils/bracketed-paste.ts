export function wrapBracketedPaste(body: string): string {
  return `\x1b[200~${body}\x1b[201~`
}

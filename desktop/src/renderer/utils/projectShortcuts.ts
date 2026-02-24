export function getProjectShortcutDigitForIndex(
  projectIndex: number,
  totalProjects: number,
): number | null {
  if (projectIndex < 0 || projectIndex >= totalProjects) return null

  // First eight projects map directly to 1-8.
  if (projectIndex < 8) return projectIndex + 1

  // Shortcut 9 always targets the final project.
  if (projectIndex === totalProjects - 1) return 9

  return null
}

export function getProjectIndexForShortcutDigit(
  shortcutDigit: number,
  totalProjects: number,
): number | null {
  if (totalProjects === 0) return null

  if (shortcutDigit === 9) return totalProjects - 1
  if (shortcutDigit < 1 || shortcutDigit > 8) return null

  const index = shortcutDigit - 1
  return index < totalProjects ? index : null
}

export function runtimeUserDataPath(defaultUserDataPath: string, isPackaged: boolean): string {
  if (isPackaged || defaultUserDataPath.endsWith('-dev')) return defaultUserDataPath
  return `${defaultUserDataPath}-dev`
}

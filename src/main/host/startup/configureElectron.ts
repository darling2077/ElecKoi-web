import { app } from 'electron'
import type { StartupProfile } from '@shared/contracts/startup/schema'
import { runtimeUserDataPath } from './runtimeUserDataPath'

export function configureRuntimeUserData(): void {
  const currentPath = app.getPath('userData')
  const runtimePath = runtimeUserDataPath(currentPath, app.isPackaged)
  if (runtimePath !== currentPath) app.setPath('userData', runtimePath)
}

export function configureElectron(profile: StartupProfile): void {
  if (profile.userDataPath.trim().length > 0) app.setPath('userData', profile.userDataPath)
  if (profile.disableHardwareAcceleration) app.disableHardwareAcceleration()
}

import { describe, expect, it } from 'vitest'
import { runtimeUserDataPath } from '../src/main/host/startup/runtimeUserDataPath'

describe('runtime user data path', () => {
  it('keeps the packaged application on the established product directory', () => {
    expect(runtimeUserDataPath('C:\\Users\\User\\AppData\\Roaming\\eleckoi-desktop', true))
      .toBe('C:\\Users\\User\\AppData\\Roaming\\eleckoi-desktop')
  })

  it('isolates development data from the packaged application', () => {
    expect(runtimeUserDataPath('C:\\Users\\User\\AppData\\Roaming\\eleckoi-desktop', false))
      .toBe('C:\\Users\\User\\AppData\\Roaming\\eleckoi-desktop-dev')
  })

  it('does not append the development suffix twice', () => {
    expect(runtimeUserDataPath('C:\\Users\\User\\AppData\\Roaming\\eleckoi-desktop-dev', false))
      .toBe('C:\\Users\\User\\AppData\\Roaming\\eleckoi-desktop-dev')
  })
})

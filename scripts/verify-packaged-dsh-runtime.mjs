import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const unpacked = process.env.ELECKOI_UNPACKED_DIR ?? join(process.cwd(), 'release', 'win-unpacked')
const executable = join(unpacked, 'ElecKoi.exe')
const appAsar = join(unpacked, 'resources', 'app.asar')

if (!existsSync(executable) || !existsSync(appAsar)) {
  throw new Error(`找不到已解包的 ElecKoi：${unpacked}`)
}

const probe = `
  import('node:fs/promises').then(async ({ access, mkdtemp, readFile, rm }) => {
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { pathToFileURL } = await import('node:url')
    const appAsar = ${JSON.stringify(appAsar)}
    const mainSource = await readFile(join(appAsar, 'out', 'main', 'main.js'), 'utf8')
    const externalUpdaterDependencies = ['electron-updater', 'builder-util-runtime', 'debug', 'sax']
    for (const dependency of externalUpdaterDependencies) {
      const loadMarkers = ['require("' + dependency, "require('" + dependency]
      if (loadMarkers.some((marker) => mainSource.includes(marker))) {
        throw new Error('Packaged main process still loads ' + dependency + ' as an external dependency.')
      }
    }
    if (!mainSource.includes('class AppUpdater') || !mainSource.includes('NsisUpdater')) {
      throw new Error('Packaged main process does not contain the bundled updater runtime.')
    }
    process.stdout.write('Packaged updater runtime check passed.\\n')
    const buildTimeBrowserPackages = [
      '@fortawesome/fontawesome-free',
      '@tailwindcss/browser',
      'jquery',
      'jquery-ui-dist',
      'jquery-ui-touch-punch',
      'lodash',
      'pixi.js',
      'showdown',
      'toastr',
      'vue',
      'vue-router'
    ]
    for (const dependency of buildTimeBrowserPackages) {
      try {
        await access(join(appAsar, 'node_modules', ...dependency.split('/')))
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      throw new Error('Build-time browser package leaked into app.asar: ' + dependency)
    }
    process.stdout.write('Packaged browser dependency boundary check passed.\\n')
    const runtimeUrl = pathToFileURL(join(appAsar, 'node_modules', '@eleckoi', 'dsh-runtime', 'dist', 'index.mjs')).href
    const { DshRuntime } = await import(runtimeUrl)
    const root = await mkdtemp(join(tmpdir(), 'eleckoi-packaged-dsh-'))
    const runtime = new DshRuntime({
      configPath: join(appAsar, 'resources', 'dsh', 'cordis.yml'),
      presetTemplatePath: join(appAsar, 'resources', 'dsh', 'agent-preset-template', 'agent.cordis.yml'),
      workspaceRoot: join(root, 'workspace'),
      runtimeDataRoot: join(root, 'runtime'),
      executablePath: process.execPath
    })
    try {
      await runtime.verify()
      process.stdout.write('Packaged DSH runtime handshake passed.\\n')
    } finally {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    }
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
`

const result = spawnSync(executable, ['-e', probe], {
  cwd: unpacked,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 30_000
})

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'Packaged DSH runtime handshake failed.\n')
  process.exit(result.status ?? 1)
}

process.stdout.write(result.stdout)

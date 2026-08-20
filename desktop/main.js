'use strict'

/**
 * Harness Desktop — DeepSeek Harness packaged as a desktop app.
 *
 * What this launcher does:
 *   1. Resolves the app-managed DSH_HOME (override with --dsh-home or
 *      DSH_DESKTOP_HOME; default: <userData>/dsh-home — official ~/.dsh is
 *      never touched, so official `dsh web` stays stock).
 *   2. Installs the built-in plugins (Aqua glass theme + archive manager)
 *      into that home (self-healing on every launch): each plugin package is
 *      copied to $DSH_HOME/plugins/<id> and linked into
 *      $DSH_HOME/profiles/node_modules, exactly like the official installer.
 *   3. Starts the bundled DeepSeek Harness web server with a bundled Node
 *      runtime, passing the built-in plugins as a --patch overlay (so they
 *      are always on in this app and cannot be removed from the UI).
 *   4. Opens the web UI in an Electron window and shuts the server down when
 *      the window closes.
 */

const { app, BrowserWindow, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

// Read the app's own version from the packaged/working package.json so dev
// launches report the real version too (app.getVersion() in dev mode returns
// the Electron runtime version instead).
let APP_VERSION = ''
try {
  APP_VERSION = require('./package.json').version || ''
} catch {
  APP_VERSION = ''
}

// Optional test hook: point Electron's userData (localStorage, IndexedDB,
// cache) at a throwaway directory so a dev/test launch never touches the
// real user profile. Production launches leave this unset.
if (process.env.DSH_DESKTOP_USERDATA) {
  try {
    app.setPath('userData', path.resolve(process.env.DSH_DESKTOP_USERDATA))
  } catch {
    // setPath must run before ready; ignore failures and use the default.
  }
}

const DEFAULT_PORT = 3080
const STARTUP_TIMEOUT_MS = 150_000
const BUILTIN_PLUGINS = [
  {
    id: '@deepseek-ai/dsh-client-ui-aqua',
    bundle: 'lib/client.js',
  },
  {
    id: '@deepseek-ai/dsh-desktop-archive',
    bundle: 'lib/index.js',
  },
]
const PATCH_FILENAME = 'desktop.patch.yml'
const SMOKE = process.argv.includes('--smoke')
const ARCHIVE_CHECK = process.argv.includes('--archive-check')
const ARCHIVE_REAL_CHECK = process.argv.includes('--archive-real-check')
const WALLPAPER_CHECK = process.argv.includes('--wallpaper-check')
const WALLPAPER_SEED = process.argv.includes('--wallpaper-seed')
const WALLPAPER_SEED_KIND = argAfter('--wallpaper-seed') === 'video' ? 'video' : 'image'
const UI_CHECK = process.argv.includes('--ui-check')
const DEFAULTS_CHECK = process.argv.includes('--defaults-check')
const SETTINGS_DUMP = process.argv.includes('--settings-dump')
const UPDATE_CHECK = process.argv.includes('--update-check')
const VISION_CHECK = process.argv.includes('--vision-check')
const IMAGE_CHECK = process.argv.includes('--image-check')
const IMAGE_CHECK_WORKSPACE = argAfter('--image-workspace')
const SETUP_CHECK = process.argv.includes('--setup-check')
const SETUP_CREDS = argAfter('--setup-creds')
const SETUP_WORKSPACE = argAfter('--setup-workspace')
let archiveRealStarted = false
let archiveRealPhase = 0
let archiveRealResult = {}
let archiveRealDone = false
let settingsDumpStarted = false
let updateCheckStarted = false
let visionCheckStarted = false
let imageCheckStarted = false
let setupCheckStarted = false

/** Console output that can never take the app down (e.g. EPIPE when the
 *  parent console closes while a self-check is running). */
function safeLog(method, ...args) {
  try {
    console[method](...args)
  } catch {
    // stdout/stderr may be closed — diagnostics still go to the log file.
  }
}

process.on('uncaughtException', (error) => {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'crash.log'),
      `${new Date().toISOString()}  ${error && error.stack ? error.stack : String(error)}\n`,
    )
  } catch {
    // ignore
  }
  safeLog('error', `UNCAUGHT ${error && error.stack ? error.stack : String(error)}`)
  app.exit(1)
})

let mainWindow = null
let serverChild = null
let chosenPort = 0
let dshHome = ''
let wallpaperCheckStarted = false
let defaultsCheckStarted = false

// ---- single instance -------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// ---- paths -----------------------------------------------------------------

function resourceRoot() {
  // Packaged: extraResources are mapped to <resources>/resources.
  // Dev: the checked-in desktop/resources directory.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'resources')
    : path.join(__dirname, 'resources')
}

function argAfter(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

function resolveDshHome() {
  const cliHome = argAfter('--dsh-home')
  if (cliHome !== undefined) return path.resolve(cliHome)
  if (process.env.DSH_DESKTOP_HOME) return path.resolve(process.env.DSH_DESKTOP_HOME)
  return path.join(app.getPath('userData'), 'dsh-home')
}

// ---- logging ----------------------------------------------------------------

function appendLog(line) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'dsh-server.log'),
      `${new Date().toISOString()}  ${line}\n`,
    )
  } catch {
    // Logging must never take the app down.
  }
}

// ---- built-in plugin install (self-healing) --------------------------------

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(from, to)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
    }
  }
}

function removePath(target) {
  // Only ever called on paths inside the app-managed DSH_HOME.
  if (!target.startsWith(dshHome)) {
    throw new Error(`refusing to remove path outside DSH_HOME: ${target}`)
  }
  fs.rmSync(target, { recursive: true, force: true })
}

/**
 * Ensure the built-in plugins exist in DSH_HOME and are resolvable by the
 * dsh loader. Runs at every launch; any manual removal is repaired on
 * restart.
 */
function installPlugin(resources) {
  for (const plugin of BUILTIN_PLUGINS) {
    const pluginSrc = path.join(resources, 'plugins', ...plugin.id.split('/'))
    const bundledBundle = path.join(pluginSrc, plugin.bundle)
    if (!fs.existsSync(bundledBundle)) {
      throw new Error(`built-in plugin bundle missing: ${bundledBundle}`)
    }

    // 1. Persistent copy under $DSH_HOME/plugins (same pattern as the
    //    official installer), refreshed only when the bundled version changes.
    const pluginDest = path.join(dshHome, 'plugins', ...plugin.id.split('/'))
    const installedBundle = path.join(pluginDest, plugin.bundle)
    const bundledSize = fs.statSync(bundledBundle).size
    const installedSize = fs.existsSync(installedBundle) ? fs.statSync(installedBundle).size : -1
    if (installedSize !== bundledSize) {
      appendLog(`installing built-in plugin into ${pluginDest}`)
      removePath(pluginDest)
      copyDir(pluginSrc, pluginDest)
    }

    // 2. Module fallback link the dsh loader resolves through:
    //    $DSH_HOME/profiles/node_modules/<plugin id>
    const linkPath = path.join(dshHome, 'profiles', 'node_modules', ...plugin.id.split('/'))
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })

    const wants = path.resolve(pluginDest)
    let existing
    try {
      existing = fs.lstatSync(linkPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      existing = undefined
    }

    if (existing !== undefined && existing.isSymbolicLink()) {
      try {
        const target = path.resolve(fs.readlinkSync(linkPath))
        if (target === wants) continue
      } catch {
        // dangling link — replace below
      }
      fs.unlinkSync(linkPath)
    } else if (existing !== undefined) {
      // A plain directory/file from an older install: replace it.
      removePath(linkPath)
    }
    fs.symlinkSync(wants, linkPath, 'junction')
    appendLog(`plugin link ready: ${linkPath} -> ${wants}`)
  }
}

// ---- built-in skills + credential sync --------------------------------------

const VISION_SKILL_ID = 'ds-vision-skill'
const IMAGE_SKILL_ID = 'ds-image-skill'
const VISION_SKILL_CONFIG_FILE = 'config.json'
const VISION_GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const TOKENRHYTHM_BASE_URL = 'https://tokenrhythm.studio/v1'

/**
 * Ensure a built-in skill is discoverable by the harness:
 *   - $DSH_HOME/skills/<skillId> (the app-managed user root);
 *   - ~/.agents/skills/<skillId> when that agents home exists (it ranks
 *     above the dsh root, so on machines with an existing ~/.agents copy the
 *     app refreshes that copy too and the built-in version stays authoritative).
 * config.json (runtime credentials) is never overwritten during refresh.
 */
function installBuiltinSkill(resources, skillId) {
  const bundled = path.join(resources, 'skills', skillId)
  if (!fs.existsSync(path.join(bundled, 'SKILL.md'))) {
    appendLog(`built-in skill missing: ${bundled}`)
    return
  }
  const targets = [path.join(dshHome, 'skills', skillId)]
  const agentsHome = path.join(app.getPath('home'), '.agents', 'skills')
  if (fs.existsSync(agentsHome)) targets.push(path.join(agentsHome, skillId))
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      appendLog(`installing built-in skill into ${target}`)
      copyDir(bundled, target)
      continue
    }
    syncSkillFiles(bundled, target)
  }
}

/** Refresh non-config skill files so app updates reach the installed copy. */
function syncSkillFiles(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.name === VISION_SKILL_CONFIG_FILE) continue
    if (entry.isDirectory()) {
      syncSkillFiles(from, to)
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      const same = fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to))
      if (!same) fs.copyFileSync(from, to)
    }
  }
}

/** Read the official credentials document ($DSH_HOME/.credentials.yaml). */
function readCredentialsFile() {
  const credsPath = path.join(dshHome, '.credentials.yaml')
  if (!fs.existsSync(credsPath)) return {}
  try {
    const result = {}
    for (const line of fs.readFileSync(credsPath, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim())
      if (match) result[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    }
    return result
  } catch {
    return {}
  }
}

/**
 * Write the configured GLM vision key into the built-in ds-vision-skill's
 * config.json so the skill never asks the user again. Runs at every launch
 * and again whenever the credentials document changes.
 */
function syncVisionSkillConfig() {
  try {
    const creds = readCredentialsFile()
    const key = creds.ZHIPU_API_KEY || creds.GLM_API_KEY || ''
    // 凭据被清除时同样把技能配置清空,避免残留旧 Key。
    const next = key === ''
      ? '{}\n'
      : JSON.stringify({ glm: { apiKey: key, baseUrl: VISION_GLM_BASE_URL } }, null, 2)
    const homeSkill = path.join(dshHome, 'skills', VISION_SKILL_ID)
    const writeIfNeeded = (dir) => {
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return
      const configPath = path.join(dir, VISION_SKILL_CONFIG_FILE)
      const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
      if (current !== next) {
        fs.writeFileSync(configPath, next, 'utf8')
        appendLog(key === ''
          ? `vision skill GLM key cleared in ${dir}`
          : `vision skill GLM key synced into ${dir}`)
      }
    }
    writeIfNeeded(homeSkill)
    const agentsSkill = path.join(app.getPath('home'), '.agents', 'skills', VISION_SKILL_ID)
    writeIfNeeded(agentsSkill)
  } catch (error) {
    appendLog(`vision skill config sync failed: ${error && error.message ? error.message : String(error)}`)
  }
}

/** Watch the credentials document so a key saved from 设置 → 模型 is synced. */
function watchCredentialsSync() {
  try {
    fs.watch(dshHome, { persistent: false }, (eventType, filename) => {
      if (filename !== undefined && String(filename).toLowerCase() !== '.credentials.yaml') return
      setTimeout(() => {
        syncVisionSkillConfig()
        syncImageSkillConfig()
      }, 300)
    })
  } catch (error) {
    appendLog(`credentials watcher unavailable: ${error && error.message ? error.message : String(error)}`)
  }
}

/**
 * Open generated images from the desktop main process.
 *
 * The image skill's PowerShell scripts run inside the harness sandbox, where
 * ShellExecute reports success but viewer windows land in an invisible
 * context. Instead the script drops a small marker JSON into
 * %TEMP%\hd-image-open\<nonce>.json (the sandbox may write to %TEMP%) and this
 * watcher opens the path with Electron's shell.openPath — the app's own
 * interactive process — then removes the marker.
 */
function watchImageOpenRequests() {
  try {
    const dir = path.join(os.tmpdir(), 'hd-image-open')
    fs.mkdirSync(dir, { recursive: true })

    const openMarker = async (file, parsed) => {
      try {
        const target = String(parsed.path || '')
        if (target !== '' && fs.existsSync(target)) {
          const error = await shell.openPath(target)
          if (error) appendLog(`open generated image failed: ${error}`)
        }
      } catch (error) {
        appendLog(`open generated image error: ${error && error.message ? error.message : String(error)}`)
      } finally {
        try {
          fs.unlinkSync(file)
        } catch {
          // marker already gone — fine
        }
      }
    }

    const processMarker = (file) => {
      let parsed = null
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        // File may still be mid-write; retry once shortly after.
        setTimeout(() => {
          try {
            const retry = JSON.parse(fs.readFileSync(file, 'utf8'))
            void openMarker(file, retry)
          } catch {
            try {
              fs.unlinkSync(file)
            } catch {
              // stale marker — leave for next sweep
            }
          }
        }, 600)
        return
      }
      void openMarker(file, parsed)
    }

    // Handle markers left over from a previous session (e.g. app closed right
    // after generation) before watching for new ones.
    for (const name of fs.readdirSync(dir)) {
      if (String(name).endsWith('.json')) processMarker(path.join(dir, name))
    }
    fs.watch(dir, { persistent: false }, (eventType, filename) => {
      if (filename !== undefined && String(filename).endsWith('.json')) {
        processMarker(path.join(dir, filename))
      }
    })
    appendLog('generated-image opener watcher ready')
  } catch (error) {
    appendLog(`generated-image opener watcher unavailable: ${error && error.message ? error.message : String(error)}`)
  }
}

/**
 * Write the configured TokenRhythm key into the built-in ds-image-skill's
 * config.json so the skill never asks the user again. Runs at every launch
 * and again whenever the credentials document changes. Reuses the same key a
 * TokenRhythm chat provider already stores (OPENSQUILLA_API_KEY) or the
 * dedicated image key (TOKENRHYTHM_API_KEY); cleared credentials clear it too.
 */
function syncImageSkillConfig() {
  try {
    const creds = readCredentialsFile()
    const key = creds.OPENSQUILLA_API_KEY || creds.TOKENRHYTHM_API_KEY || ''
    const next = key === ''
      ? '{}\n'
      : JSON.stringify({ tokenrhythm: { apiKey: key, baseUrl: TOKENRHYTHM_BASE_URL } }, null, 2)
    const writeIfNeeded = (dir) => {
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return
      const configPath = path.join(dir, VISION_SKILL_CONFIG_FILE)
      const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
      if (current !== next) {
        fs.writeFileSync(configPath, next, 'utf8')
        appendLog(key === ''
          ? `image skill TokenRhythm key cleared in ${dir}`
          : `image skill TokenRhythm key synced into ${dir}`)
      }
    }
    writeIfNeeded(path.join(dshHome, 'skills', IMAGE_SKILL_ID))
    const agentsSkill = path.join(app.getPath('home'), '.agents', 'skills', IMAGE_SKILL_ID)
    writeIfNeeded(agentsSkill)
  } catch (error) {
    appendLog(`image skill config sync failed: ${error && error.message ? error.message : String(error)}`)
  }
}

// ---- port selection ---------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
    socket.setTimeout(800, () => {
      socket.destroy()
      resolve(true)
    })
  })
}

/**
 * PIDs currently listening on a TCP port (Windows netstat output).
 */
function pidsOnPort(port) {
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, encoding: 'utf8' })
    if (out.status !== 0) return []
    const pids = new Set()
    for (const line of String(out.stdout).split(/\r?\n/)) {
      const match = line.match(/\s(\d+\.\d+\.\d+\.\d+):(\d+)\s+\S+:\S+\s+LISTENING\s+(\d+)/)
      if (match !== null && match[2] === String(port)) pids.add(Number(match[3]))
    }
    return [...pids]
  } catch {
    return []
  }
}

/**
 * Whether a PID is one of this app's own orphaned dsh servers: its command
 * line must reference the bundled dsh bin, the same port, and the desktop
 * patch overlay (desktop.patch.yml) that only Harness Desktop passes. This
 * keeps the official `dsh web` server (which also uses port 3080 by default
 * or via an explicit --port flag) from ever being mistaken for our own
 * leftover process and terminated.
 */
function isOwnServerPid(pid, port) {
  try {
    const script = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`
    const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
    })
    const line = String(out.stdout || '')
    return (
      line.includes('@deepseek-ai\\dsh\\lib\\bin.js') &&
      line.includes(`--port ${port}`) &&
      line.includes('desktop.patch.yml')
    )
  } catch {
    return false
  }
}

function killPid(pid) {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
  } catch {
    // ignore
  }
}

async function waitPortFree(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return isPortFree(port)
}

/**
 * Pick the server port. The default port is preferred so the web origin
 * (and therefore localStorage / IndexedDB, which the Aqua wallpaper relies
 * on) stays stable across launches. If the default port is occupied by one
 * of our own orphaned servers (from a previous crash or force-kill), that
 * orphan is terminated and the port reclaimed. Only an unrelated external
 * process triggers the deterministic fallback range.
 */
async function pickPort() {
  if (await isPortFree(DEFAULT_PORT)) return DEFAULT_PORT

  appendLog(`port ${DEFAULT_PORT} is busy; looking for orphaned Harness Desktop servers`)
  for (const pid of pidsOnPort(DEFAULT_PORT)) {
    if (isOwnServerPid(pid, DEFAULT_PORT)) {
      appendLog(`killing orphaned server pid ${pid} on port ${DEFAULT_PORT}`)
      killPid(pid)
    }
  }
  if (await waitPortFree(DEFAULT_PORT)) {
    appendLog(`port ${DEFAULT_PORT} reclaimed`)
    return DEFAULT_PORT
  }

  for (let port = DEFAULT_PORT + 1; port < DEFAULT_PORT + 100; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port found in range ${DEFAULT_PORT}–${DEFAULT_PORT + 99}`)
}

// ---- dsh server -------------------------------------------------------------

function serverReady(url) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (serverChild !== null && serverChild.exitCode !== null) {
        reject(new Error(`dsh server exited early (code ${serverChild.exitCode})`))
        return
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
        if (response.ok) {
          resolve(url)
          return
        }
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        reject(new Error('timed out waiting for the dsh web server to start'))
        return
      }
      setTimeout(tick, 400)
    }
    void tick()
  })
}

async function startServer(resources) {
  const nodeExe = path.join(resources, 'node', 'node.exe')
  const binPath = path.join(resources, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const patchPath = path.join(resources, PATCH_FILENAME)
  const hostDir = path.join(resources, 'host')

  for (const [label, file] of [['Node runtime', nodeExe], ['dsh runtime', binPath], ['plugin patch', patchPath]]) {
    if (!fs.existsSync(file)) throw new Error(`${label} missing: ${file}`)
  }

  chosenPort = await pickPort()
  const args = ['web', '--patch', patchPath, '--port', String(chosenPort)]
  appendLog(`starting server: ${nodeExe} ${[binPath, ...args].join(' ')}`)
  appendLog(`DSH_HOME=${dshHome}`)

  serverChild = spawn(nodeExe, [binPath, ...args], {
    cwd: hostDir,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_DESKTOP_ASSETS: resources,
      DSH_DESKTOP_APP_VERSION: process.env.DSH_DESKTOP_APP_VERSION || APP_VERSION || app.getVersion(),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const onStdout = (data) => {
    const text = String(data).trim()
    if (text !== '') {
      appendLog(`[server] ${text}`)
      safeLog('log', `[server] ${text}`)
    }
  }
  const onStderr = (data) => {
    const text = String(data).trim()
    if (text !== '') {
      appendLog(`[server:err] ${text}`)
      safeLog('error', `[server:err] ${text}`)
    }
  }
  serverChild.stdout.on('data', onStdout)
  serverChild.stderr.on('data', onStderr)
  serverChild.on('exit', (code, signal) => {
    appendLog(`server exited (code=${code}, signal=${signal})`)
  })

  return serverReady(`http://127.0.0.1:${chosenPort}`)
}

function stopServer() {
  if (serverChild === null || serverChild.exitCode !== null) return
  const pid = serverChild.pid
  appendLog(`stopping dsh server (pid ${pid})`)
  try {
    // taskkill /T also terminates every child of the server (worker threads,
    // shell helpers). Synchronous so shutdown completes before app exit.
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
  } catch {
    try {
      serverChild.kill()
    } catch {
      // already gone
    }
  }
  serverChild = null
}

// ---- window ------------------------------------------------------------------

function createWindow() {
  const iconPath = app.isPackaged
    ? undefined
    : path.join(__dirname, 'build', 'icon.png')

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: SMOKE,
    autoHideMenuBar: true,
    backgroundColor: '#0C121B',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // Keep the app window on the local dsh origin only; anything else opens in
  // the user's default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${chosenPort}`) || url.startsWith('http://localhost:')) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (chosenPort > 0 && !url.startsWith(`http://127.0.0.1:${chosenPort}`)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    const current = mainWindow.webContents.getURL()
    if (current.startsWith(`http://127.0.0.1:${chosenPort}`)) {
      injectDesktopUi()
      if (SMOKE) void runSmokeCheck()
      if (ARCHIVE_CHECK) void runArchiveCheck()
      if (ARCHIVE_REAL_CHECK) {
        if (!archiveRealStarted) {
          archiveRealStarted = true
          void runArchiveRealPhase1()
        } else if (archiveRealPhase === 1) {
          archiveRealPhase = 2
          void runArchiveRealPhase2()
        } else if (archiveRealPhase === 2) {
          archiveRealPhase = 3
          void runArchiveRealPhase3()
        }
      }
      if (WALLPAPER_CHECK && !wallpaperCheckStarted) {
        wallpaperCheckStarted = true
        void runWallpaperCheck()
      }
      if (WALLPAPER_SEED && !wallpaperCheckStarted) {
        wallpaperCheckStarted = true
        void runWallpaperSeed()
      }
      if (UI_CHECK && !wallpaperCheckStarted) {
        wallpaperCheckStarted = true
        void runUiCheck()
      }
      if (DEFAULTS_CHECK && !defaultsCheckStarted) {
        defaultsCheckStarted = true
        // The first launch seeds defaults and reloads the page; give the
        // post-reload page time to settle before verifying.
        setTimeout(() => void runDefaultsCheck(), 6000)
      }
      if (SETTINGS_DUMP && !settingsDumpStarted) {
        settingsDumpStarted = true
        void runSettingsDump()
      }
      if (UPDATE_CHECK && !updateCheckStarted) {
        updateCheckStarted = true
        void runUpdateCheck()
      }
      if (VISION_CHECK && !visionCheckStarted) {
        visionCheckStarted = true
        void runVisionCheck()
      }
      if (IMAGE_CHECK && !imageCheckStarted) {
        imageCheckStarted = true
        void runImageCheck()
      }
      if (SETUP_CHECK && !setupCheckStarted) {
        setupCheckStarted = true
        void runSetupCheck()
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

/**
 * Inject the desktop-only UI into the official dsh web UI:
 *   - archive-panel.js:  the bottom-right "恢复归档" manager (talks to the
 *     bundled desktop-archive host plugin over same-origin
 *     `/api/desktop-archive.*` endpoints);
 *   - model-vision-hint.js: the DeepSeek 识图 reminder in 设置 → 模型.
 *   - model-image-hint.js: the TokenRhythm 生图能力 card below it.
 *   - aqua-overrides.css: Aqua 玻璃补充覆盖（轨迹面板、设置选中态按钮）。
 * The official UI code is never modified.
 */
function injectDesktopUi() {
  if (mainWindow === null) return
  const resources = resourceRoot()
  const cssPath = path.join(resources, 'aqua-overrides.css')
  if (fs.existsSync(cssPath)) {
    const css = fs.readFileSync(cssPath, 'utf8')
    mainWindow.webContents
      .executeJavaScript(
        `(() => {
          const id = 'hd-aqua-overrides'
          const old = document.getElementById(id)
          if (old !== null) old.remove()
          const style = document.createElement('style')
          style.id = id
          style.textContent = ${JSON.stringify(css)}
          document.head.appendChild(style)
        })()`,
        true,
      )
      .then(() => appendLog('aqua overrides injected'))
      .catch((error) => appendLog(`aqua overrides injection failed: ${error && error.message ? error.message : String(error)}`))
  } else {
    appendLog(`aqua overrides missing: ${cssPath}`)
  }

  // Self-checks other than --defaults-check use a throwaway profile; skip
  // the first-run defaults seed so its one-time page reload cannot interrupt
  // an in-flight check.
  const skipDefaultsSeed = (SMOKE || ARCHIVE_CHECK || ARCHIVE_REAL_CHECK || WALLPAPER_CHECK || WALLPAPER_SEED || UI_CHECK || SETTINGS_DUMP || UPDATE_CHECK || VISION_CHECK || IMAGE_CHECK || SETUP_CHECK) && !DEFAULTS_CHECK
  const scripts = ['archive-panel.js', 'model-vision-hint.js', 'model-image-hint.js', 'update-check.js']
  if (!skipDefaultsSeed) scripts.push('defaults-seed.js')
  for (const name of scripts) {
    const scriptPath = path.join(resources, name)
    if (!fs.existsSync(scriptPath)) {
      appendLog(`desktop UI script missing: ${scriptPath}`)
      continue
    }
    const script = fs.readFileSync(scriptPath, 'utf8')
    mainWindow.webContents
      .executeJavaScript(script, true)
      .then(() => appendLog(`${name} injected`))
      .catch((error) => appendLog(`${name} injection failed: ${error && error.message ? error.message : String(error)}`))
  }
}

async function runSmokeCheck() {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const boot = window.__DSH_BOOT__;
      const hasAqua = JSON.stringify(boot || {}).indexOf('dsh-client-ui-aqua') !== -1;
      const t0 = Date.now();
      const mounted = await new Promise((resolve) => {
        const check = () => {
          const root = document.getElementById('root');
          const ok = root !== null && root.children.length > 0;
          if (ok || Date.now() - t0 > 45000) resolve(ok);
          else setTimeout(check, 250);
        };
        check();
      });
      const aquaActive = document.documentElement.getAttribute('data-dsh-aqua') !== null;
      return {
        hasAqua,
        mounted,
        aquaActive,
        title: document.title,
        bodyText: document.body.innerText.slice(0, 300),
      };
    })()`)
    safeLog('log', `SMOKE_RESULT ${JSON.stringify(result)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'smoke-result.json'), JSON.stringify(result, null, 2))
    } catch {
      // diagnostics only
    }
    const shotPath = argAfter('--shot')
    if (shotPath !== undefined && result.mounted) {
      const image = await mainWindow.webContents.capturePage()
      fs.writeFileSync(shotPath, image.toPNG())
      safeLog('log', `SMOKE_SHOT ${shotPath}`)
    }
    stopServer()
    app.exit(result.hasAqua && result.mounted ? 0 : 1)
  } catch (error) {
    safeLog('error', `SMOKE_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/**
 * Self-check for the built-in archive manager: exercises list / restore /
 * delete against the bundled host plugin through the live web UI. Used by
 * the developer smoke pipeline with a throwaway DSH_HOME only.
 */
async function runArchiveCheck() {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const call = async (path, body) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        return { status: response.status, data: await response.json() }
      }
      const list1 = await call('/api/desktop-archive.list', {})
      const restore = await call('/api/desktop-archive.restore', { sessionIds: ['session-test-1'] })
      const list2 = await call('/api/desktop-archive.list', {})
      const del = await call('/api/desktop-archive.delete', { sessionIds: ['session-test-2'] })
      const list3 = await call('/api/desktop-archive.list', {})
      const panel = document.getElementById('hd-archive-root') !== null
      return { list1, restore, list2, del, list3, panel }
    })()`)
    safeLog('log', `ARCHIVE_RESULT ${JSON.stringify(result)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'archive-check.json'), JSON.stringify(result, null, 2))
    } catch {
      // diagnostics only
    }
    stopServer()
    app.exit(0)
  } catch (error) {
    safeLog('error', `ARCHIVE_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/**
 * End-to-end self-check for the archive manager's delete flow against REAL
 * archived sessions (registry state + on-disk session logs). Requires a
 * DSH_HOME fixture that already contains archived sessions; drives the actual
 * injected panel UI (row delete -> confirm modal -> reload; select-all ->
 * batch delete -> confirm -> reload) and then verifies, from the main
 * process, that only the deleted session directories were removed and the
 * workspace accounting was updated without touching any other session.
 */
function archiveRealFsState() {
  const home = dshHome
  const sessionsRoot = path.join(home, 'sessions')
  const dirs = []
  try {
    for (const project of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      for (const entry of fs.readdirSync(path.join(sessionsRoot, project.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = path.join(sessionsRoot, project.name, entry.name)
        let hasLog = false
        try {
          hasLog = fs.readdirSync(dir).some((name) => name === 'session.jsonl' || name === 'session.jsonl.zstd')
        } catch {
          // dir vanished mid-scan
        }
        dirs.push({ sessionId: entry.name, dir, hasLog })
      }
    }
  } catch {
    // report as-is
  }
  let workspaceJson = null
  try {
    workspaceJson = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
  } catch {
    // missing
  }
  const firstWorkspace = workspaceJson?.tables?.workspaces ? Object.values(workspaceJson.tables.workspaces)[0] : null
  return {
    dirs,
    archivedSessionIds: workspaceJson?.global?.archivedSessionIds ?? null,
    sessionIds: firstWorkspace?.sessionIds ?? null,
  }
}

function archiveRealFinalize(ok, message) {
  if (archiveRealDone) return
  archiveRealDone = true
  archiveRealResult.fsAfter = archiveRealFsState()
  archiveRealResult.message = message
  archiveRealResult.passed = ok
  safeLog('log', `ARCHIVE_REAL_RESULT ${JSON.stringify(archiveRealResult)}`)
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'archive-real-check.json'), JSON.stringify(archiveRealResult, null, 2))
  } catch {
    // diagnostics only
  }
  stopServer()
  app.exit(ok ? 0 : 1)
}

function archiveRealArmWatchdog(phase) {
  setTimeout(() => {
    if (archiveRealDone) return
    safeLog('error', `ARCHIVE_REAL_TIMEOUT at phase ${phase}`)
    archiveRealFinalize(false, `timed out waiting for reload after phase ${phase}`)
  }, 20000)
}

async function runArchiveRealPhase1() {
  try {
    const info = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.getElementById('root')
      const t0 = Date.now()
      while (root === null || root.children.length === 0) {
        if (Date.now() - t0 > 45000) break
        await waitFor(250)
      }
      const call = async (path, body) => {
        const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        return { status: response.status, data: await response.json() }
      }
      // Archive the first real session through the OFFICIAL archive API, then
      // the injected panel must list it.
      const firstId = 'session-2ea86967-5946-402e-9de3-15536b74436d'
      const archive = await call('/api/workspace.archiveSession', {
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'workspace.archiveSession',
        payload: { sessionId: firstId },
      })
      const listBefore = await call('/api/desktop-archive.list', {})
      document.getElementById('hd-archive-fab')?.click()
      await waitFor(700)
      const list1 = await call('/api/desktop-archive.list', {})
      const rows = [...document.querySelectorAll('.hd-archive-row')].map((row) => ({
        sessionId: row.getAttribute('data-session-id'),
        title: row.querySelector('.hd-archive-row-title')?.textContent ?? null,
        delDisabled: row.querySelector('.hd-archive-btn-soft-danger')?.disabled ?? null,
        restoreDisabled: row.querySelector('.hd-archive-btn-soft')?.disabled ?? null,
      }))
      const batchDel = document.getElementById('hd-archive-delete-all')
      const batchInfo = { disabled: batchDel?.disabled ?? null, text: batchDel?.textContent ?? null }
      const firstRealRow = document.querySelector('.hd-archive-row[data-session-id="' + firstId + '"]')
      firstRealRow?.querySelector('.hd-archive-btn-soft-danger')?.click()
      await waitFor(200)
      const modal = document.getElementById('hd-archive-modal')
      return {
        archive,
        listBefore,
        list1,
        rows,
        batchInfo,
        modalOpened: modal !== null,
        modalTitle: modal?.querySelector('.hd-archive-modal-title')?.textContent ?? null,
        modalText: modal?.querySelector('.hd-archive-modal-text')?.textContent ?? null,
      }
    })()`)
    archiveRealResult.phase1 = info
    if (!info.modalOpened) return archiveRealFinalize(false, 'row delete modal did not open')
    if (!info.archive?.data?.result?.ok) return archiveRealFinalize(false, `official archive call failed: ${JSON.stringify(info.archive)}`)
    if (!(info.list1?.data?.items ?? []).some((item) => item.sessionId === 'session-2ea86967-5946-402e-9de3-15536b74436d')) {
      return archiveRealFinalize(false, 'archived session not listed in panel after official archive')
    }
    archiveRealPhase = 1
    archiveRealArmWatchdog(1)
    mainWindow.webContents
      .executeJavaScript(`document.getElementById('hd-archive-modal')?.querySelector('.hd-archive-btn-danger')?.click()`)
      .catch(() => {})
  } catch (error) {
    safeLog('error', `ARCHIVE_REAL_PHASE1_FAILED ${error && error.stack ? error.stack : String(error)}`)
    archiveRealFinalize(false, `phase1 failed: ${String(error && error.message ? error.message : error)}`)
  }
}

async function runArchiveRealPhase2() {
  try {
    const info = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.getElementById('root')
      const t0 = Date.now()
      while (root === null || root.children.length === 0) {
        if (Date.now() - t0 > 45000) break
        await waitFor(250)
      }
      const call = async (path, body) => {
        const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        return { status: response.status, data: await response.json() }
      }
      // Archive the second real session through the OFFICIAL API too, then
      // select all and batch-delete it from the panel.
      const secondId = 'session-a51a3972-42e0-4734-9fc3-9f2d402da359'
      const archive2 = await call('/api/workspace.archiveSession', {
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'workspace.archiveSession',
        payload: { sessionId: secondId },
      })
      document.getElementById('hd-archive-fab')?.click()
      await waitFor(700)
      const list2 = await call('/api/desktop-archive.list', {})
      const selectAll = document.getElementById('hd-archive-select-all')
      selectAll?.click()
      await waitFor(150)
      const batchDel = document.getElementById('hd-archive-delete-all')
      const batchEnabled = batchDel !== null && !batchDel.disabled
      batchDel?.click()
      await waitFor(200)
      const modal = document.getElementById('hd-archive-modal')
      return {
        archive2,
        list2,
        batchEnabled,
        selectAllChecked: selectAll?.checked ?? null,
        modalOpened: modal !== null,
        modalText: modal?.querySelector('.hd-archive-modal-text')?.textContent ?? null,
      }
    })()`)
    archiveRealResult.phase2 = info
    if (!info.modalOpened) return archiveRealFinalize(false, 'batch delete modal did not open')
    if (!info.archive2?.data?.result?.ok) return archiveRealFinalize(false, `official archive 2 failed: ${JSON.stringify(info.archive2)}`)
    if (!(info.list2?.data?.items ?? []).some((item) => item.sessionId === 'session-a51a3972-42e0-4734-9fc3-9f2d402da359')) {
      return archiveRealFinalize(false, 'second archived session not listed in panel')
    }
    archiveRealPhase = 2
    archiveRealArmWatchdog(2)
    mainWindow.webContents
      .executeJavaScript(`document.getElementById('hd-archive-modal')?.querySelector('.hd-archive-btn-danger')?.click()`)
      .catch(() => {})
  } catch (error) {
    safeLog('error', `ARCHIVE_REAL_PHASE2_FAILED ${error && error.stack ? error.stack : String(error)}`)
    archiveRealFinalize(false, `phase2 failed: ${String(error && error.message ? error.message : error)}`)
  }
}

async function runArchiveRealPhase3() {
  try {
    const info = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.getElementById('root')
      const t0 = Date.now()
      while (root === null || root.children.length === 0) {
        if (Date.now() - t0 > 45000) break
        await waitFor(250)
      }
      const call = async (path, body) => {
        const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        return { status: response.status, data: await response.json() }
      }
      const list3 = await call('/api/desktop-archive.list', {})
      return { list3 }
    })()`)
    archiveRealResult.phase3 = info
    const state = archiveRealFsState()
    const dirs = state.dirs
    const firstGone = !dirs.some((d) => d.sessionId === 'session-2ea86967-5946-402e-9de3-15536b74436d')
    const secondGone = !dirs.some((d) => d.sessionId === 'session-a51a3972-42e0-4734-9fc3-9f2d402da359')
    const rootMarkerIntact = fs.existsSync(path.join(dshHome, 'sessions', 'root-marker.txt'))
    const projectMarkerIntact = fs.existsSync(path.join(dshHome, 'sessions', '--D-DeepseekHarness--', 'project-marker.txt'))
    let projCacheOk = false
    try {
      projCacheOk = JSON.parse(fs.readFileSync(path.join(dshHome, 'storages', 'session_projcache.json'), 'utf8'))?.tables?.sessions !== undefined
    } catch {
      projCacheOk = false
    }
    const list3Ids = (info.list3?.data?.items ?? []).map((item) => item.sessionId)
    const archivedEmpty = (state.archivedSessionIds ?? []).length === 0
    const workspaceUpdated =
      !(state.sessionIds ?? []).includes('session-2ea86967-5946-402e-9de3-15536b74436d') &&
      !(state.sessionIds ?? []).includes('session-a51a3972-42e0-4734-9fc3-9f2d402da359')
    const ok = firstGone && secondGone && rootMarkerIntact && projectMarkerIntact && projCacheOk && list3Ids.length === 0 && archivedEmpty && workspaceUpdated
    archiveRealFinalize(
      ok,
      ok
        ? 'all delete flows verified'
        : `firstGone=${firstGone} secondGone=${secondGone} rootMarker=${rootMarkerIntact} projectMarker=${projectMarkerIntact} projCache=${projCacheOk} listEmpty=${list3Ids.length === 0} archivedEmpty=${archivedEmpty} workspaceUpdated=${workspaceUpdated}`,
    )
  } catch (error) {
    safeLog('error', `ARCHIVE_REAL_PHASE3_FAILED ${error && error.stack ? error.stack : String(error)}`)
    archiveRealFinalize(false, `phase3 failed: ${String(error && error.message ? error.message : error)}`)
  }
}

/**
 * Self-check for the Aqua wallpaper persistence fix. Sets an image wallpaper
 * (localStorage data URL) and a video wallpaper (IndexedDB blob marker),
 * reloads the web UI, then verifies both are restored automatically without
 * any user interaction. Uses a throwaway userData only.
 */
/** Seed persisted wallpaper state (image data URL + video blob marker) and
 *  exit. A separate fresh launch then verifies both restore automatically —
 *  exactly the user's close-and-reopen scenario. */
async function runWallpaperSeed() {
  try {
    const kind = WALLPAPER_SEED_KIND
    const seeded = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.getElementById('root')
      const t0 = Date.now()
      while (root === null || root.children.length === 0) {
        if (Date.now() - t0 > 45000) break
        await waitFor(250)
      }
      localStorage.setItem('dsh.ui-aqua.background', 'wallpaper')
      let seeded = {}
      if (${JSON.stringify(kind)} === 'video') {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('dsh-aqua-media', 1)
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('wallpaper')) request.result.createObjectStore('wallpaper')
          }
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const blob = new Blob(['fakemedia'], { type: 'video/mp4' })
        const videoId = 'vtest' + Date.now().toString(36)
        await new Promise((resolve, reject) => {
          const tx = db.transaction('wallpaper', 'readwrite')
          tx.objectStore('wallpaper').put(blob, videoId)
          tx.oncomplete = resolve
          tx.onerror = () => reject(tx.error)
        })
        localStorage.setItem('dsh.ui-aqua.wallpaper', 'idb:' + videoId)
        seeded.videoId = videoId
      } else {
        localStorage.setItem('dsh.ui-aqua.wallpaper', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
      }
      seeded.wallpaper = localStorage.getItem('dsh.ui-aqua.wallpaper')
      return seeded
    })()`)
    safeLog('log', `WALLPAPER_SEED ${JSON.stringify(seeded)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'wallpaper-seed.json'), JSON.stringify(seeded, null, 2))
    } catch {
      // diagnostics only
    }
    stopServer()
    app.exit(0)
  } catch (error) {
    safeLog('error', `WALLPAPER_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/**
 * Self-check for the injected desktop UI: mounts a synthetic settings dialog
 * (模型 tab with a DeepSeek provider) and verifies the vision hint card
 * appears. Uses a throwaway userData only.
 */
async function runUiCheck() {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const t0 = Date.now()
      const root = document.getElementById('root')
      while (root === null || root.children.length === 0) {
        if (Date.now() - t0 > 45000) break
        await waitFor(250)
      }
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      const title = document.createElement('h2')
      title.textContent = '模型'
      const intro = document.createElement('p')
      intro.textContent = '填入各提供方的 API 密钥即可使用其模型。DeepSeek deepseek-chat'
      dialog.appendChild(title)
      dialog.appendChild(intro)
      // Synthetic settings nav cell (selected state).
      const navCell = document.createElement('div')
      navCell.className = 'x-navCell'
      navCell.setAttribute('aria-current', 'true')
      navCell.textContent = '模型'
      dialog.appendChild(navCell)
      document.body.appendChild(dialog)
      // Synthetic trajectory panel (rc.6 layout: split > tablePane[data-trajectory-scroll]).
      const split = document.createElement('div')
      split.id = 'hd-synthetic-trajectory'
      const pane = document.createElement('div')
      pane.setAttribute('data-trajectory-scroll', '')
      split.appendChild(pane)
      document.body.appendChild(split)
      // Synthetic conversation with inline code + code block (markdown glass).
      const conv = document.createElement('div')
      conv.setAttribute('data-conversation-scroll', '')
      const inlineCode = document.createElement('code')
      inlineCode.textContent = '~\\\\.codex\\\\skills'
      const pre = document.createElement('pre')
      pre.textContent = 'main.js + prepare-resources.ps1'
      conv.appendChild(inlineCode)
      conv.appendChild(pre)
      document.body.appendChild(conv)
      // Synthetic new-session button.
      const newSession = document.createElement('button')
      newSession.className = 'x-newSession'
      newSession.textContent = '新会话'
      document.body.appendChild(newSession)
      // Synthetic settings dialog (mask + panel + button).
      const settingsOverlay = document.createElement('div')
      settingsOverlay.setAttribute('role', 'presentation')
      const settingsMask = document.createElement('div')
      settingsMask.className = 'x-mask'
      const settingsPanel = document.createElement('div')
      settingsPanel.setAttribute('role', 'dialog')
      settingsPanel.setAttribute('aria-modal', 'true')
      const settingsButton = document.createElement('button')
      settingsButton.className = 'x-secondaryButton'
      settingsButton.textContent = '按钮'
      settingsPanel.appendChild(settingsButton)
      // Synthetic native select (provider / API-protocol dropdown).
      const select = document.createElement('select')
      select.className = 'x-select'
      const optionA = document.createElement('option')
      optionA.textContent = 'DeepSeek'
      const optionB = document.createElement('option')
      optionB.textContent = 'OpenAI'
      select.appendChild(optionA)
      select.appendChild(optionB)
      settingsPanel.appendChild(select)
      settingsOverlay.appendChild(settingsMask)
      settingsOverlay.appendChild(settingsPanel)
      document.body.appendChild(settingsOverlay)
      // Synthetic message bubble under video-wallpaper mode.
      document.documentElement.setAttribute('data-dsh-aqua-wallpaper', '')
      document.documentElement.setAttribute('data-dsh-aqua-media', 'video')
      const bubble = document.createElement('div')
      bubble.className = 'x-bubble'
      bubble.textContent = '用户消息'
      document.body.appendChild(bubble)
      await waitFor(1200)
      const hint = document.getElementById('hd-vision-hint')
      const imageHint = document.getElementById('hd-image-hint')
      const trajStyle = getComputedStyle(split)
      const navStyle = getComputedStyle(navCell)
      const inlineStyle = getComputedStyle(inlineCode)
      const preStyle = getComputedStyle(pre)
      const newSessionStyle = getComputedStyle(newSession)
      const panelStyle = getComputedStyle(settingsPanel)
      const maskStyle = getComputedStyle(settingsMask)
      const settingsButtonStyle = getComputedStyle(settingsButton)
      const selectStyle = getComputedStyle(select)
      const optionStyle = getComputedStyle(optionA)
      const bubbleStyle = getComputedStyle(bubble)
      const htmlMedia = document.documentElement.getAttribute('data-dsh-aqua-media')
      const htmlWallpaper = document.documentElement.hasAttribute('data-dsh-aqua-wallpaper')
      const bubbleMatched = document.querySelector('html[data-dsh-aqua][data-dsh-float][data-dsh-aqua-wallpaper][data-dsh-aqua-media="video"] [class*="bubble"]') === bubble
      const bubbleRules = []
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText !== undefined && rule.selectorText.includes('bubble') && rule.style !== undefined && rule.style.background) {
              bubbleRules.push({
                owner: sheet.ownerNode && sheet.ownerNode.getAttribute ? (sheet.ownerNode.getAttribute('data-plugin-css') || sheet.ownerNode.id || sheet.ownerNode.tagName) : '?',
                selector: rule.selectorText.slice(0, 110),
                background: rule.style.background,
                important: rule.style.getPropertyPriority('background'),
              })
            }
          }
        } catch {
          // cross-origin sheet
        }
      }
      // Probe: does toggling the video attributes change the resolved style?
      document.documentElement.removeAttribute('data-dsh-aqua-wallpaper')
      document.documentElement.removeAttribute('data-dsh-aqua-media')
      const bubbleBgOff = getComputedStyle(bubble).backgroundColor
      document.documentElement.setAttribute('data-dsh-aqua-wallpaper', '')
      document.documentElement.setAttribute('data-dsh-aqua-media', 'video')
      const bubbleBgOn = getComputedStyle(bubble).backgroundColor
      document.documentElement.removeAttribute('data-dsh-aqua-wallpaper')
      document.documentElement.removeAttribute('data-dsh-aqua-media')
      // Per-visit behavior: dismiss → close the settings dialog → reopen it.
      // Both hints must reappear (not just once per app session).
      let perVisitReappear = false
      let imageHintPerVisitReappear = false
      if (hint !== null) {
        const dismissBtn = hint.querySelector('.hd-vision-hint-close')
        if (dismissBtn !== null) dismissBtn.click()
      }
      if (imageHint !== null) {
        const dismissBtn = imageHint.querySelector('.hd-image-hint-close')
        if (dismissBtn !== null) dismissBtn.click()
      }
      await waitFor(600)
      dialog.remove()
      await waitFor(800)
      document.body.appendChild(dialog)
      await waitFor(1200)
      const reopenedVision = document.getElementById('hd-vision-hint')
      const reopenedImage = document.getElementById('hd-image-hint')
      perVisitReappear = reopenedVision !== null
      imageHintPerVisitReappear = reopenedImage !== null
      // Stability: the cards must keep their DOM identity while the periodic
      // scan runs (2s interval + status updates), i.e. never rebuild themselves.
      const stableNode = reopenedVision
      const imageStableNode = reopenedImage
      let stable = true
      let imageStable = true
      const identityProbe = setInterval(() => {
        if (document.getElementById('hd-vision-hint') !== stableNode) stable = false
        if (document.getElementById('hd-image-hint') !== imageStableNode) imageStable = false
      }, 400)
      await waitFor(2400)
      clearInterval(identityProbe)
      return {
        hintFound: hint !== null,
        hintText: hint === null ? null : hint.textContent,
        perVisitReappear,
        stable,
        imageHintFound: imageHint !== null,
        imageHintText: imageHint === null ? null : imageHint.textContent,
        imageHintAfterVision: reopenedImage !== null && reopenedVision !== null && reopenedImage.previousElementSibling === reopenedVision,
        imageHintPerVisitReappear,
        imageStable,
        trajectoryBackdrop: trajStyle.backdropFilter,
        trajectoryBackground: trajStyle.backgroundColor,
        navBackdrop: navStyle.backdropFilter,
        navBackground: navStyle.backgroundColor,
        inlineCodeBackground: inlineStyle.backgroundColor,
        preBackground: preStyle.backgroundColor,
        newSessionBackdrop: newSessionStyle.backdropFilter,
        newSessionBackground: newSessionStyle.backgroundColor,
        settingsPanelBackdrop: panelStyle.backdropFilter,
        settingsPanelBackground: panelStyle.backgroundColor,
        settingsMaskBackground: maskStyle.backgroundColor,
        settingsButtonBackdrop: settingsButtonStyle.backdropFilter,
        settingsButtonBackground: settingsButtonStyle.backgroundColor,
        selectBackdrop: selectStyle.backdropFilter,
        selectBackground: selectStyle.backgroundColor,
        optionColor: optionStyle.color,
        optionBackground: optionStyle.backgroundColor,
        bubbleBackdrop: bubbleStyle.backdropFilter,
        bubbleBackground: bubbleStyle.backgroundColor,
        htmlMedia,
        htmlWallpaper,
        bubbleMatched,
        bubbleRules,
        bubbleBgOff,
        bubbleBgOn,
      }
    })()`)
    safeLog('log', `UI_RESULT ${JSON.stringify(result)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'ui-check.json'), JSON.stringify(result, null, 2))
    } catch {
      // diagnostics only
    }
    stopServer()
    const uiPassed =
      result.hintFound === true
      && result.perVisitReappear === true
      && result.stable === true
      && result.imageHintFound === true
      && result.imageHintAfterVision === true
      && result.imageHintPerVisitReappear === true
      && result.imageStable === true
      && result.selectBackdrop !== 'none'
      && result.optionColor !== 'rgba(0, 0, 0, 0)'
      && result.optionColor !== 'transparent'
      && result.optionBackground !== 'rgba(0, 0, 0, 0)'
      && result.optionBackground !== 'transparent'
    app.exit(uiPassed ? 0 : 1)
  } catch (error) {
    safeLog('error', `UI_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/**
 * Self-check for the first-run defaults (dark theme + bundled video
 * wallpaper + tuned glass recipe). Runs after the seed's one-time reload
 * and verifies the persisted values, the IndexedDB blob, the mounted video
 * wallpaper, and the resolved dark scheme.
 */
async function runDefaultsCheck() {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const t0 = Date.now()
      const markerOk = () => {
        try {
          return localStorage.getItem('hd.defaults.v5') === '1'
        } catch {
          return false
        }
      }
      while (!markerOk()) {
        if (Date.now() - t0 > 45000) break
        await waitFor(300)
      }
      const read = (key, fallback) => {
        try {
          return localStorage.getItem(key) ?? fallback
        } catch {
          return fallback
        }
      }
      const blobExists = await new Promise((resolve) => {
        try {
          const request = indexedDB.open('dsh-aqua-media', 1)
          request.onsuccess = () => {
            const db = request.result
            try {
              const tx = db.transaction('wallpaper', 'readonly')
              const get = tx.objectStore('wallpaper').get('default-video')
              get.onsuccess = () => resolve(get.result !== undefined && get.result !== null)
              get.onerror = () => resolve(false)
            } catch {
              resolve(false)
            }
          }
          request.onerror = () => resolve(false)
        } catch {
          resolve(false)
        }
      })
      const video = document.querySelector('[data-dsh-aqua-wallpaper-video]')
      const videoSrc = video === null ? null : String(video.getAttribute('src')).slice(0, 24)
      return {
        seeded: markerOk(),
        blur: read('dsh.ui-aqua.blur'),
        frost: read('dsh.ui-aqua.frost'),
        videoBlur: read('dsh.ui-aqua.videoBlur'),
        videoBrightness: read('dsh.ui-aqua.videoBrightness'),
        background: read('dsh.ui-aqua.background'),
        wallpaper: read('dsh.ui-aqua.wallpaper'),
        darkScheme: document.body.hasAttribute('data-ds-dark-theme'),
        blobExists,
        videoSrc,
        aquaActive: document.documentElement.getAttribute('data-dsh-aqua') !== null,
      }
    })()`)
    safeLog('log', `DEFAULTS_RESULT ${JSON.stringify(result)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'defaults-check.json'), JSON.stringify(result, null, 2))
    } catch {
      // diagnostics only
    }
    const passed =
      result.seeded === true
      && result.blur === '16'
      && result.frost === '13'
      && result.videoBlur === '6'
      && result.videoBrightness === '20'
      && result.background === 'wallpaper'
      && String(result.wallpaper).startsWith('idb:')
      && result.darkScheme === true
      && (result.blobExists === true || String(result.videoSrc).startsWith('blob:'))
      && String(result.videoSrc).startsWith('blob:')
    stopServer()
    app.exit(passed ? 0 : 1)
  } catch (error) {
    safeLog('error', `DEFAULTS_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/**
 * Diagnostic: open the real settings dialog and verify the injected
 * "检查更新" entry is present and functional (clicks it and captures the
 * result dialog). Debug-only; requires network for the release check.
 */
async function runSettingsDump() {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.getElementById('root')
      const t0 = Date.now()
      while (root === null || root.children.length === 0) {
        if (Date.now() - t0 > 45000) break
        await waitFor(250)
      }
      const candidates = [...document.querySelectorAll('[role="button"], button, [class*="nav"], [class*="Nav"], li, a')]
        .filter((el) => el.textContent.trim() === '设置')
      let clicked = null
      for (const el of candidates) {
        el.click()
        clicked = { tag: el.tagName, cls: el.className, text: el.textContent.trim() }
        break
      }
      await waitFor(1500)
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((d) => {
        const nav = d.querySelector('nav')
        const navCells = nav === null ? [] : [...nav.querySelectorAll('button')].map((b) => b.textContent.trim())
        return {
          cls: d.className,
          navCells,
          hasUpdateCell: d.querySelector('#hd-update-cell') !== null,
        }
      })
      // Exercise the injected "检查更新" entry: click it and capture the dialog.
      const updateCell = document.getElementById('hd-update-cell')
      let updateClick = { cellFound: updateCell !== null }
      if (updateCell !== null) {
        updateCell.click()
        let modal = null
        for (let i = 0; i < 30 && modal === null; i += 1) {
          await waitFor(250)
          modal = document.getElementById('hd-update-modal')
        }
        updateClick = {
          cellFound: true,
          modalOpened: modal !== null,
          title: modal?.querySelector('.hd-update-modal-title')?.textContent ?? null,
          text: modal?.querySelector('.hd-update-modal-text')?.textContent ?? null,
          link: modal?.querySelector('a.hd-update-btn-link')?.href ?? null,
        }
      }
      return { clicked, dialogs, updateClick }
    })()`)
    safeLog('log', `SETTINGS_DUMP ${JSON.stringify(result).slice(0, 3000)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'settings-dump.json'), JSON.stringify(result, null, 2))
    } catch {
      // diagnostics only
    }
    stopServer()
    app.exit(0)
  } catch (error) {
    safeLog('error', `SETTINGS_DUMP_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/**
 * Self-check for the "检查更新" host route: calls the local update-check
 * endpoint and records the version comparison result. Used by the developer
 * smoke pipeline; requires network access to GitHub/Gitee release APIs.
 */
async function runUpdateCheck() {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.getElementById('root')
      const t0 = Date.now()
      while (root === null || root.children.length === 0) {
        if (Date.now() - t0 > 45000) break
        await waitFor(250)
      }
      const response = await fetch('/api/desktop-update.check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      return { status: response.status, data: await response.json() }
    })()`)
    safeLog('log', `UPDATE_CHECK_RESULT ${JSON.stringify(result)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'update-check.json'), JSON.stringify(result, null, 2))
    } catch {
      // diagnostics only
    }
    stopServer()
    app.exit(result?.data?.ok === true ? 0 : 1)
  } catch (error) {
    safeLog('error', `UPDATE_CHECK_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/**
 * End-to-end self-check for the vision-skill admission patch: sends a real
 * image attachment to the current (text-only) model and verifies the message
 * is ACCEPTED and stored as a text placeholder naming the attachment file
 * path (never rejected with MODEL_DOES_NOT_SUPPORT_IMAGES). Uses a throwaway
 * DSH_HOME only; no model credentials are needed because the admission check
 * happens before any LLM call. Requires an initialized DSH_HOME with at
 * least one workspace/session (like archive-real-check, use a real-home copy
 * in the developer smoke pipeline).
 */
async function runVisionCheck() {
  try {
    // Wait for the web UI and for the auto-created first session to exist.
    await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.getElementById('root')
      const t0 = Date.now()
      while (root === null || root.children.length === 0) {
        if (Date.now() - t0 > 45000) break
        await waitFor(250)
      }
      await waitFor(1500)
      return true
    })()`)

    const workspaceJsonPath = path.join(dshHome, 'storages', 'workspace.json')
    let sessionId = null
    const sessionDeadline = Date.now() + 20000
    while (Date.now() < sessionDeadline) {
      try {
        const ws = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8'))
        const first = Object.values(ws.tables.workspaces)[0]
        if (first && Array.isArray(first.sessionIds) && first.sessionIds.length > 0) {
          sessionId = first.sessionIds[0]
          break
        }
      } catch {
        // workspace.json not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (sessionId === null) throw new Error('no session id found in workspace.json')

    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const sendResult = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const envelope = {
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'session.prompt',
        payload: {
          sessionId: ${JSON.stringify(sessionId)},
          mode: 'queue',
          content: [
            { type: 'text', text: '这张图片里是什么？' },
            { type: 'image', data: ${JSON.stringify(pngB64)}, mediaType: 'image/png', name: 'vision-test.png' },
          ],
        },
      }
      const response = await fetch('/api/session.prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      })
      const responseText = await response.text()
      let data = null
      try {
        data = JSON.parse(responseText)
      } catch {
        data = null
      }
      await waitFor(4000)
      const bodyText = document.body.innerText || ''
      const directiveVisible = bodyText.includes('用户上传了一张')
      const blocked = bodyText.includes('请切换支持图片的模型')

      // Inspect the stored user message: model-visible content must carry the
      // ds-vision-skill directive (text only), while displayContent must keep
      // the original image block for the chat UI.
      const historyResponse = await fetch('/api/session.history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'session.history',
          payload: { sessionId: ${JSON.stringify(sessionId)}, maxMessages: 30 },
        }),
      })
      let history = null
      try {
        history = await historyResponse.json()
      } catch {
        history = null
      }
      const events = history?.result?.ok === true ? history.result.value.events : []
      const target = events.findLast((entry) =>
        entry.event.type === 'user/message'
        && Array.isArray(entry.event.data.content)
        && entry.event.data.content.some((block) => block.type === 'text' && String(block.text || '').includes('用户上传了一张')))
      const message = target?.event?.data || null
      const contentTexts = Array.isArray(message?.content) ? message.content.filter((b) => b.type === 'text').map((b) => b.text || '') : []
      const modelContentHasDirective = contentTexts.join('').includes('ds-vision-skill')
      const displayImages = Array.isArray(message?.displayContent)
        ? message.displayContent.filter((b) => b.type === 'image' && b.attachment !== void 0)
        : []
      const displayContentHasImage = displayImages.length > 0
      const attachmentId = displayImages[0]?.attachment?.attachmentId || null

      let attachmentLoadable = false
      if (attachmentId !== null) {
        const attachmentResponse = await fetch('/api/session.attachment', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: crypto.randomUUID(),
            method: 'session.attachment',
            payload: { sessionId: ${JSON.stringify(sessionId)}, attachmentId },
          }),
        })
        try {
          const attachmentData = await attachmentResponse.json()
          attachmentLoadable = attachmentData?.result?.ok === true && typeof attachmentData.result.value.data === 'string'
        } catch {
          attachmentLoadable = false
        }
      }

      // Natural-trigger evidence: the user only asked "这张图片里是什么？".
      // The agent should still invoke the vision skill on its own (the
      // admission directive carries the file path; no skill name is needed
      // from the user). Report the tool call when it shows up.
      let visionSkillTriggered = false
      const triggerDeadline = Date.now() + 90000
      while (Date.now() < triggerDeadline) {
        await waitFor(5000)
        const triggerHistory = await fetch('/api/session.history', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: crypto.randomUUID(),
            method: 'session.history',
            payload: { sessionId: ${JSON.stringify(sessionId)}, maxMessages: 100 },
          }),
        }).then((res) => res.json()).catch(() => null)
        const triggerEvents = triggerHistory?.result?.ok === true
          ? triggerHistory.result.value.events || []
          : []
        const joined = JSON.stringify(triggerEvents)
        if (/ds-vision-skill|vision-router|vlm-vision/i.test(joined)) {
          visionSkillTriggered = true
          break
        }
      }

      return {
        status: response.status,
        data,
        rawText: data === null ? responseText : null,
        directiveVisible,
        blocked,
        modelContentHasDirective,
        displayContentHasImage,
        attachmentLoadable,
        visionSkillTriggered,
        bodySnippet: bodyText.slice(0, 400),
      }
    })()`)

    const accepted = sendResult.data?.result?.ok === true
    const result = {
      sessionId,
      send: sendResult,
      accepted,
      attachmentOnDisk: false,
      passed: false,
    }
    const sha = crypto.createHash('sha256').update(Buffer.from(pngB64, 'base64')).digest('hex')
    const objectPath = path.join(dshHome, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
    result.attachmentOnDisk = fs.existsSync(objectPath)
    result.passed =
      accepted
      && sendResult.modelContentHasDirective
      && sendResult.displayContentHasImage
      && sendResult.attachmentLoadable
      && !sendResult.directiveVisible
      && !sendResult.blocked
      && result.attachmentOnDisk

    safeLog('log', `VISION_RESULT ${JSON.stringify(result)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'vision-check.json'), JSON.stringify(result, null, 2))
    } catch {
      // diagnostics only
    }
    stopServer()
    app.exit(result.passed ? 0 : 1)
  } catch (error) {
    safeLog('error', `VISION_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/**
 * End-to-end check for the built-in ds-image-skill: creates a throwaway
 * workspace + session, sends a text-only prompt that asks the agent to run
 * scripts/image-generate.ps1, waits for the tool result, then verifies that a
 * generated image file actually landed in the workspace. Requires a valid
 * TokenRhythm key in the credentials document and a live balance.
 */
async function runImageCheck() {
  try {
    const workspacePath = IMAGE_CHECK_WORKSPACE
      || path.join(app.getPath('userData'), 'hd-image-workspace')
    fs.mkdirSync(workspacePath, { recursive: true })
    const t0 = Date.now()

    await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.getElementById('root')
      const deadline = Date.now() + 45000
      while (root === null || root.children.length === 0) {
        if (Date.now() > deadline) break
        await waitFor(250)
      }
      await waitFor(1500)
      return true
    })()`)

    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const rpc = async (method, payload) => {
        const response = await fetch('/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: crypto.randomUUID(),
            method,
            payload,
          }),
        })
        return response.json()
      }
      const workspacePath = ${JSON.stringify(workspacePath)}

      const wsRes = await rpc('workspace.create', { path: workspacePath })
      const workspace = wsRes?.result?.ok === true ? wsRes.result.value.workspace : null
      if (workspace === null) {
        return { ok: false, stage: 'workspace.create', error: JSON.stringify(wsRes).slice(0, 500) }
      }
      const sessRes = await rpc('session.create', { workspaceId: workspace.workspaceId })
      const sessionId = sessRes?.result?.ok === true ? sessRes.result.value.sessionId : null
      if (sessionId === null) {
        return { ok: false, stage: 'session.create', error: JSON.stringify(sessRes).slice(0, 500) }
      }

      const prompt = '帮我画一只橙色的小猫坐在窗台上的扁平插画，画面柔和一点。'
      const sendRes = await rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      })
      if (sendRes?.result?.ok !== true) {
        return { ok: false, stage: 'session.prompt', error: JSON.stringify(sendRes).slice(0, 500) }
      }

      let invokedSkill = false
      let lastText = ''
      const pollDeadline = Date.now() + 240000
      while (Date.now() < pollDeadline) {
        await waitFor(5000)
        const hist = await rpc('session.history', { sessionId, maxMessages: 200 })
        const events = hist?.result?.ok === true ? (hist.result.value.events || []) : []
        const joined = events
          .map((entry) => JSON.stringify(entry?.event?.data || {}))
          .join(' ')
        lastText = joined.slice(0, 12000)
        // The agent's plan or tool arguments mention the skill script; the
        // file-on-disk check in the main process confirms actual success.
        if (/image-generate/i.test(joined)) {
          invokedSkill = true
          break
        }
      }
      return {
        ok: true,
        stage: 'prompted',
        sessionId,
        workspaceId: workspace.workspaceId,
        workspacePath,
        invokedSkill,
        lastText: lastText.slice(-1200),
      }
    })()`)

    let generatedFile = null
    const walk = (dir) => {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
          const stat = fs.statSync(full)
          if (stat.mtimeMs >= t0 - 5000 && (generatedFile === null || stat.mtimeMs > fs.statSync(generatedFile).mtimeMs)) {
            generatedFile = full
          }
        }
      }
    }
    // The skill script only writes the image after a successful generation, so
    // a file on disk is the definitive success signal. Give it up to 2 minutes
    // to land after the agent starts the skill.
    const fileDeadline = Date.now() + 120000
    while (Date.now() < fileDeadline) {
      generatedFile = null
      walk(workspacePath)
      if (generatedFile !== null || result.invokedSkill !== true) break
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    const passed =
      result.ok === true
      && result.invokedSkill === true
      && generatedFile !== null
    const fullResult = {
      ...result,
      generatedFile,
      elapsedMs: Date.now() - t0,
      passed,
    }
    safeLog('log', `IMAGE_RESULT ${JSON.stringify(fullResult)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'image-check.json'), JSON.stringify(fullResult, null, 2))
    } catch {
      // diagnostics only
    }
    stopServer()
    app.exit(passed ? 0 : 1)
  } catch (error) {
    safeLog('error', `IMAGE_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/**
 * New-user setup simulation: with a fresh DSH_HOME this opens the real
 * 设置 → 模型 dialog, verifies the injected vision + image-generation cards,
 * then performs exactly the same RPC calls a new user makes while configuring:
 *   - llm.discoverModels  → pull the TokenRhythm model list (拉取模型);
 *   - settings.mutate     → add the custom provider + default model + full
 *     permission preset (the way the Models page and settings write them);
 *   - credentials.set     → GLM vision key, TokenRhythm image key, and the
 *     provider key (the same calls the card save buttons make);
 *   - workspace.create + session.create → the first workspace/session.
 * Finally it verifies the desktop main process synced both keys into the
 * built-in skills' config.json so the skills are ready without further input.
 */
async function runSetupCheck() {
  try {
    let zhipuKey = ''
    let tokenrhythmKey = ''
    if (SETUP_CREDS !== undefined) {
      try {
        const parsed = JSON.parse(fs.readFileSync(SETUP_CREDS, 'utf8'))
        zhipuKey = String(parsed.zhipu || '')
        tokenrhythmKey = String(parsed.tokenrhythm || '')
      } catch {
        // missing/invalid creds file: keys stay empty, config-sync checks fail
      }
    }
    const workspacePath = SETUP_WORKSPACE
      || path.join(app.getPath('userData'), 'hd-setup-workspace')
    fs.mkdirSync(workspacePath, { recursive: true })

    await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.getElementById('root')
      const t0 = Date.now()
      while (root === null || root.children.length === 0) {
        if (Date.now() - t0 > 45000) break
        await waitFor(250)
      }
      await waitFor(1500)
      return true
    })()`)

    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const rpc = async (method, payload) => {
        const response = await fetch('/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: crypto.randomUUID(),
            method,
            payload,
          }),
        })
        return response.json()
      }
      const workspacePath = ${JSON.stringify(workspacePath)}
      const zhipuKey = ${JSON.stringify(zhipuKey)}
      const tokenrhythmKey = ${JSON.stringify(tokenrhythmKey)}

      // 1. Open the real 设置 dialog and switch to 模型.
      let opened = false
      const openDeadline = Date.now() + 30000
      while (Date.now() < openDeadline) {
        const candidates = [...document.querySelectorAll('[role="button"], button, [class*="nav"], [class*="Nav"], li, a')]
          .filter((el) => (el.textContent || '').trim() === '设置')
        if (candidates.length > 0) {
          candidates[0].click()
          opened = true
          break
        }
        await waitFor(500)
      }
      await waitFor(1500)
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const settingsDialog = dialogs.find((d) =>
        [...(d.querySelector('nav')?.querySelectorAll('button, [role="button"]') || [])]
          .some((b) => (b.textContent || '').trim() === '模型'))
      if (settingsDialog === null) {
        return { ok: false, stage: 'open-settings', opened, dialogCount: dialogs.length }
      }
      const modelNav = [...settingsDialog.querySelectorAll('nav button, nav [role="button"]')]
        .find((b) => (b.textContent || '').trim() === '模型')
      modelNav.click()
      await waitFor(1500)

      const visionCard = document.getElementById('hd-vision-hint')
      const imageCard = document.getElementById('hd-image-hint')
      const cardsOk = visionCard !== null
        && imageCard !== null
        && imageCard.previousElementSibling === visionCard

      // 2. 拉取模型 (the same probe the Models page runs).
      const discover = await rpc('llm.discoverModels', {
        settingsNs: 'llm-pi-ai',
        baseURL: 'https://tokenrhythm.studio/v1',
        api: 'openai-completions',
        apiKey: tokenrhythmKey,
      })
      const models = discover?.result?.ok === true ? (discover.result.value.models || []) : []
      const hasDeepseek = models.some((m) => m && m.id === 'deepseek-v4-flash')

      // 3. Add the custom provider (same settings.mutate the card performs).
      const providerMutate = await rpc('settings.mutate', {
        ns: 'llm-pi-ai',
        ops: [{
          op: 'set',
          path: ['providers', 'opensquilla'],
          value: {
            displayName: 'OpenSquilla',
            apiKeyEnv: 'OPENSQUILLA_API_KEY',
            api: 'openai-completions',
            baseURL: 'https://tokenrhythm.studio/v1',
            models,
          },
        }],
      })
      const providerSaved = providerMutate?.result?.ok === true

      // 4. Default model + full permission preset (new-user settings).
      const defaultModel = await rpc('settings.mutate', {
        ns: 'agent-default-model',
        ops: [{ op: 'set', path: [], value: { provider: 'opensquilla', model: 'deepseek-v4-flash' } }],
      })
      const permission = await rpc('settings.mutate', {
        ns: 'permission',
        ops: [{ op: 'set', path: [], value: { defaultPreset: 'danger-full-access' } }],
      })

      // 5. Keys: GLM vision card + TokenRhythm image card + provider key.
      const visionKey = await rpc('credentials.set', { ref: 'ZHIPU_API_KEY', value: zhipuKey })
      const imageKey = await rpc('credentials.set', { ref: 'TOKENRHYTHM_API_KEY', value: tokenrhythmKey })
      const providerKey = await rpc('credentials.set', { ref: 'OPENSQUILLA_API_KEY', value: tokenrhythmKey })
      const keysSaved = visionKey?.result?.ok === true
        && imageKey?.result?.ok === true
        && providerKey?.result?.ok === true

      // 6. First workspace + session (onboarding folder pick equivalent).
      await waitFor(1200)
      const wsRes = await rpc('workspace.create', { path: workspacePath })
      const workspace = wsRes?.result?.ok === true ? wsRes.result.value.workspace : null
      let sessionCreated = false
      if (workspace !== null) {
        const sessRes = await rpc('session.create', { workspaceId: workspace.workspaceId })
        sessionCreated = sessRes?.result?.ok === true
      }

      return {
        ok: true,
        stage: 'done',
        opened,
        dialogCount: dialogs.length,
        cardsOk,
        visionCardFound: visionCard !== null,
        imageCardFound: imageCard !== null,
        imageAfterVision: cardsOk,
        discovered: models.length,
        hasDeepseek,
        providerSaved,
        defaultModelSaved: defaultModel?.result?.ok === true,
        permissionSaved: permission?.result?.ok === true,
        keysSaved,
        sessionCreated,
        workspacePath,
      }
    })()`)

    // Main-process verification: both skill configs must carry the new keys.
    const readSkillKey = (skillId, section) => {
      try {
        const configPath = path.join(dshHome, 'skills', skillId, 'config.json')
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        return parsed?.[section]?.apiKey || ''
      } catch {
        return ''
      }
    }
    const visionSynced = zhipuKey === '' || readSkillKey(VISION_SKILL_ID, 'glm') === zhipuKey
    const imageSynced = tokenrhythmKey === '' || readSkillKey(IMAGE_SKILL_ID, 'tokenrhythm') === tokenrhythmKey

    const passed =
      result.ok === true
      && result.cardsOk === true
      && result.discovered > 0
      && result.hasDeepseek === true
      && result.providerSaved === true
      && result.defaultModelSaved === true
      && result.permissionSaved === true
      && result.keysSaved === true
      && result.sessionCreated === true
      && visionSynced === true
      && imageSynced === true
    const fullResult = {
      ...result,
      visionSynced,
      imageSynced,
      passed,
    }
    safeLog('log', `SETUP_RESULT ${JSON.stringify(fullResult)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'setup-check.json'), JSON.stringify(fullResult, null, 2))
    } catch {
      // diagnostics only
    }
    stopServer()
    app.exit(passed ? 0 : 1)
  } catch (error) {
    safeLog('error', `SETUP_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

/** Verify persisted wallpaper state restores automatically on a fresh boot. */
async function runWallpaperCheck() {
  try {
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const t0 = Date.now()
      const img = () => document.querySelector('[data-dsh-aqua-wallpaper-img]')
      const video = () => document.querySelector('[data-dsh-aqua-wallpaper-video]')
      const marker = localStorage.getItem('dsh.ui-aqua.wallpaper') || ''
      const expectVideo = marker.startsWith('idb:') || marker.startsWith('fsa:')
      let passed = false
      while (Date.now() - t0 < 45000) {
        passed = expectVideo
          ? video() !== null && String(video().getAttribute('src')).startsWith('blob:')
          : img() !== null && String(img().getAttribute('src')).startsWith('data:image/png')
        if (passed) break
        await waitFor(250)
      }
      return {
        passed,
        storedWallpaper: localStorage.getItem('dsh.ui-aqua.wallpaper'),
        storedBackground: localStorage.getItem('dsh.ui-aqua.background'),
        aquaAttr: document.documentElement.getAttribute('data-dsh-aqua'),
        hasAmbient: document.querySelector('[data-dsh-aqua-ambient]') !== null,
        hasWallpaperLayer: document.querySelector('[data-dsh-aqua-wallpaper-layer]') !== null,
        expectVideo,
        imageSrc: img() === null ? null : String(img().getAttribute('src')).slice(0, 30),
        videoSrc: video() === null ? null : String(video().getAttribute('src')).slice(0, 30),
        aquaWallpaperOn: document.documentElement.hasAttribute('data-dsh-aqua-wallpaper'),
      }
    })()`)
    safeLog('log', `WALLPAPER_RESULT ${JSON.stringify(result)}`)
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'wallpaper-check.json'), JSON.stringify(result, null, 2))
    } catch {
      // diagnostics only
    }
    stopServer()
    app.exit(result.passed === true ? 0 : 1)
  } catch (error) {
    safeLog('error', `WALLPAPER_FAILED ${error && error.stack ? error.stack : String(error)}`)
    stopServer()
    app.exit(1)
  }
}

function loadErrorPage(win, error) {
  const message = error instanceof Error ? error.message : String(error)
  appendLog(`startup failed: ${message}`)
  void win.loadFile(path.join(__dirname, 'error.html'), {
    query: { message, log: path.join(app.getPath('userData'), 'logs', 'dsh-server.log') },
  })
}

async function boot() {
  const win = createWindow()
  void win.loadFile(path.join(__dirname, 'splash.html'))
  const resources = resourceRoot()
  try {
    installPlugin(resources)
    installBuiltinSkill(resources, VISION_SKILL_ID)
    installBuiltinSkill(resources, IMAGE_SKILL_ID)
    syncVisionSkillConfig()
    syncImageSkillConfig()
    watchCredentialsSync()
    watchImageOpenRequests()
    const url = await startServer(resources)
    appendLog(`web UI ready at ${url}`)
    void win.loadURL(url)
  } catch (error) {
    loadErrorPage(win, error)
  }
}

// ---- lifecycle -----------------------------------------------------------------

app.setAppUserModelId('com.dsh.desktop')

app.on('before-quit', () => {
  stopServer()
})

app.on('window-all-closed', () => {
  app.quit()
})

if (gotLock) {
  app.whenReady().then(() => {
    dshHome = resolveDshHome()
    fs.mkdirSync(dshHome, { recursive: true })
    appendLog(`Harness Desktop starting (DSH_HOME=${dshHome})`)
    void boot()
  })
}

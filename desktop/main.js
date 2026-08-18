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
const WALLPAPER_CHECK = process.argv.includes('--wallpaper-check')
const WALLPAPER_SEED = process.argv.includes('--wallpaper-seed')
const WALLPAPER_SEED_KIND = argAfter('--wallpaper-seed') === 'video' ? 'video' : 'image'
const UI_CHECK = process.argv.includes('--ui-check')
const DEFAULTS_CHECK = process.argv.includes('--defaults-check')

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
 * line must reference the bundled dsh bin and the same port.
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
    return line.includes('@deepseek-ai\\dsh\\lib\\bin.js') && line.includes(`--port ${port}`)
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
    env: { ...process.env, DSH_HOME: dshHome, DSH_DESKTOP_ASSETS: resources },
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

  const scripts = ['archive-panel.js', 'model-vision-hint.js', 'defaults-seed.js']
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
      settingsOverlay.appendChild(settingsMask)
      settingsOverlay.appendChild(settingsPanel)
      document.body.appendChild(settingsOverlay)
      await waitFor(1200)
      const hint = document.getElementById('hd-vision-hint')
      const trajStyle = getComputedStyle(split)
      const navStyle = getComputedStyle(navCell)
      const inlineStyle = getComputedStyle(inlineCode)
      const preStyle = getComputedStyle(pre)
      const newSessionStyle = getComputedStyle(newSession)
      const panelStyle = getComputedStyle(settingsPanel)
      const maskStyle = getComputedStyle(settingsMask)
      const settingsButtonStyle = getComputedStyle(settingsButton)
      return {
        hintFound: hint !== null,
        hintText: hint === null ? null : hint.textContent,
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
    app.exit(result.hintFound === true ? 0 : 1)
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
          return localStorage.getItem('hd.defaults.v2') === '1'
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
      && result.videoBlur === '4.5'
      && result.videoBrightness === '20'
      && result.background === 'wallpaper'
      && String(result.wallpaper).startsWith('idb:default-video')
      && result.darkScheme === true
      && result.blobExists === true
      && String(result.videoSrc).startsWith('blob:')
    stopServer()
    app.exit(passed ? 0 : 1)
  } catch (error) {
    safeLog('error', `DEFAULTS_FAILED ${error && error.stack ? error.stack : String(error)}`)
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

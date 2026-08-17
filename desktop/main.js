'use strict'

/**
 * Harness Desktop — DeepSeek Harness packaged as a desktop app.
 *
 * What this launcher does:
 *   1. Resolves the app-managed DSH_HOME (override with --dsh-home or
 *      DSH_DESKTOP_HOME; default: <userData>/dsh-home — official ~/.dsh is
 *      never touched, so official `dsh web` stays stock).
 *   2. Installs the built-in Aqua plugin into that home (self-healing on
 *      every launch): the plugin package is copied to
 *      $DSH_HOME/plugins/@deepseek-ai/dsh-client-ui-aqua and linked into
 *      $DSH_HOME/profiles/node_modules, exactly like the official installer.
 *   3. Starts the bundled DeepSeek Harness web server with a bundled Node
 *      runtime, passing the built-in plugin as a --patch overlay (so the
 *      plugin is always on in this app and cannot be removed from the UI).
 *   4. Opens the web UI in an Electron window and shuts the server down when
 *      the window closes.
 */

const { app, BrowserWindow, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PORT = 3080
const STARTUP_TIMEOUT_MS = 150_000
const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-aqua'
const PATCH_FILENAME = 'aqua.patch.yml'
const SMOKE = process.argv.includes('--smoke')

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
  console.error(`UNCAUGHT ${error && error.stack ? error.stack : String(error)}`)
  app.exit(1)
})

let mainWindow = null
let serverChild = null
let chosenPort = 0
let dshHome = ''

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
 * Ensure the built-in plugin exists in DSH_HOME and is resolvable by the dsh
 * loader. Runs at every launch; any manual removal is repaired on restart.
 */
function installPlugin(resources) {
  const pluginSrc = path.join(resources, 'plugins', ...PLUGIN_ID.split('/'))
  const bundleRel = 'lib/client.js'
  const bundledBundle = path.join(pluginSrc, bundleRel)
  if (!fs.existsSync(bundledBundle)) {
    throw new Error(`built-in plugin bundle missing: ${bundledBundle}`)
  }

  // 1. Persistent copy under $DSH_HOME/plugins (same pattern as the official
  //    installer), refreshed only when the bundled version changes.
  const pluginDest = path.join(dshHome, 'plugins', ...PLUGIN_ID.split('/'))
  const installedBundle = path.join(pluginDest, bundleRel)
  const bundledSize = fs.statSync(bundledBundle).size
  const installedSize = fs.existsSync(installedBundle) ? fs.statSync(installedBundle).size : -1
  if (installedSize !== bundledSize) {
    appendLog(`installing built-in plugin into ${pluginDest}`)
    removePath(pluginDest)
    copyDir(pluginSrc, pluginDest)
  }

  // 2. Module fallback link the dsh loader resolves through:
  //    $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-ui-aqua
  const linkPath = path.join(dshHome, 'profiles', 'node_modules', ...PLUGIN_ID.split('/'))
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
      if (target === wants) return
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

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function pickPort() {
  if (await isPortFree(DEFAULT_PORT)) return DEFAULT_PORT
  return pickFreePort()
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
    env: { ...process.env, DSH_HOME: dshHome },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const onStdout = (data) => {
    const text = String(data).trim()
    if (text !== '') {
      appendLog(`[server] ${text}`)
      console.log(`[server] ${text}`)
    }
  }
  const onStderr = (data) => {
    const text = String(data).trim()
    if (text !== '') {
      appendLog(`[server:err] ${text}`)
      console.error(`[server:err] ${text}`)
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
    if (!SMOKE) return
    const current = mainWindow.webContents.getURL()
    if (!current.startsWith(`http://127.0.0.1:${chosenPort}`)) return
    void runSmokeCheck()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
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
      return { hasAqua, mounted, aquaActive, title: document.title };
    })()`)
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`)
    const shotPath = argAfter('--shot')
    if (shotPath !== undefined && result.mounted) {
      const image = await mainWindow.webContents.capturePage()
      fs.writeFileSync(shotPath, image.toPNG())
      console.log(`SMOKE_SHOT ${shotPath}`)
    }
    stopServer()
    app.exit(result.hasAqua && result.mounted ? 0 : 1)
  } catch (error) {
    console.error(`SMOKE_FAILED ${error && error.stack ? error.stack : String(error)}`)
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

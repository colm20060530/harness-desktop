/**
 * Harness Desktop built-in archive manager (host side).
 *
 * The official dsh web UI (rc.6) can archive conversations but provides no
 * way to restore or permanently delete them. This plugin fills that gap:
 *
 *   - restore:  removes the session id from the registry-global archive set
 *               (the official workspace domain write path, so the web UI
 *               refreshes live through `host/archived-sessions-changed`);
 *   - delete:   detaches the session from its workspace accounting, removes
 *               it from the archive set, and deletes its on-disk session
 *               log directory under $DSH_HOME/sessions.
 *
 * All mutations go through the official WorkspaceRegistry / storage-domain
 * surfaces (no direct file edits of live storage), and sessions that are
 * currently open in the server are refused for deletion.
 */
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { rm, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** Plugin identity used by the loader tree. */
export const name = 'desktop-archive'

/** Host services this plugin needs. */
export const inject = ['workspaceRegistry', 'sessions', 'webServer']

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/
const STORAGE_DIR = 'storages'

/** Read one storage JSON file (best-effort; only used for panel display). */
function readStorageJson(home, name) {
  try {
    return JSON.parse(readFileSync(path.join(home, STORAGE_DIR, `${name}.json`), 'utf8'))
  } catch {
    return null
  }
}

/** Resolve the dsh home for this server process. */
function dshHome() {
  const home = process.env.DSH_HOME
  if (!home) throw new Error('DSH_HOME is not set')
  return home
}

/** Sanitize a session id for filesystem use (the same rule the JSONL backend uses). */
function encodeSessionSegment(raw) {
  if (!SESSION_ID_RE.test(raw)) throw new Error(`invalid session id: ${JSON.stringify(raw)}`)
  return raw
}

/**
 * Locate the on-disk session directory for one session id. The JSONL backend
 * stores sessions at <DSH_HOME>/sessions/<project-key>/<session-id>/. Returns
 * the absolute path or undefined when the log is absent.
 */
async function findSessionDir(home, sessionId) {
  const encoded = encodeSessionSegment(sessionId)
  const sessionsRoot = path.join(home, 'sessions')
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = path.join(sessionsRoot, project.name, encoded)
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) continue
      return dir
    } catch {
      // not this project
    }
  }
  return undefined
}

/** Whether the directory still holds a session log (defensive delete guard). */
async function isSessionDir(dir) {
  try {
    const entries = await readdir(dir)
    return entries.includes('session.jsonl') || entries.includes('session.jsonl.zstd')
  } catch {
    return false
  }
}

/** Compose the panel list view for every archived session. */
async function listArchived(ctx) {
  const registry = ctx.workspaceRegistry
  const home = dshHome()
  const workspaceJson = readStorageJson(home, 'workspace')
  const projCache = readStorageJson(home, 'session_projcache')
  const archived = [...registry.archivedSessionIds]
  const workspaces = registry.list().map((entity) => ({
    workspaceId: entity.id,
    title: entity.record.title,
    path: entity.record.path,
    sessionIds: entity.record.sessionIds,
  }))
  const sessions = ctx.sessions
  const projRows = projCache?.tables?.sessions ?? {}

  const items = []
  for (const sessionId of archived) {
    const owner = workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))
    const row = projRows[sessionId]
    const title = row?.rows?.title?.val
    const sessionListMeta = row?.rows?.sessionListMetadata?.val
    const createdAt = row?.identity?.createdAt
    const updatedAt = row?.rows?.sessionStats?.val?.lastTurn != null
      ? row.rows.sessionStats.val.lastTurn
      : undefined
    items.push({
      sessionId,
      title: typeof title === 'string' && title !== '' ? title : '未命名对话',
      workspaceId: owner?.workspaceId ?? null,
      workspaceTitle: owner?.title ?? '未分组',
      workspacePath: owner?.path ?? null,
      createdAt: createdAt ?? null,
      lastPromptAt: sessionListMeta?.lastPromptAt ?? null,
      updatedAt: updatedAt ?? null,
      running: sessions?.get(sessionId) !== undefined,
    })
  }
  return items
}

/**
 * Restore one archived session (idempotent): remove the id from the
 * registry-global archive set. This mirrors the inverse of the shipped
 * archiveSession() — the registry's own queue + durable setState, so the
 * web UI refreshes live through `host/archived-sessions-changed`.
 */
async function restoreSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  const enqueue = registry.enqueueOperation.bind(registry)
  await enqueue(async () => {
    const state = registry.requireState()
    if (!state.archivedSessionIds.includes(sessionId)) return
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    })
  })
}

/** Permanently delete one archived session: log dir + workspace accounting. */
async function deleteSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  const sessions = ctx.sessions
  if (sessions?.get(sessionId) !== undefined) {
    const error = new Error('该对话当前正在运行，请先结束它再删除')
    error.code = 'session-running'
    throw error
  }

  // Remove the session from its owning workspace's ordered account, then
  // unarchive it — both through the registry's official write paths.
  for (const entity of registry.list()) {
    if (entity.record.sessionIds.includes(sessionId)) {
      await entity.detachSession(sessionId)
    }
  }
  await restoreSession(ctx, sessionId)

  // Delete the on-disk log directory (strictly under DSH_HOME/sessions and
  // only when it actually contains a session log).
  const home = dshHome()
  const dir = await findSessionDir(home, sessionId)
  if (dir !== undefined) {
    const root = path.resolve(path.join(home, 'sessions'))
    const resolved = path.resolve(dir)
    if (!resolved.startsWith(root + path.sep) || resolved === root) {
      throw new Error(`refusing to delete session outside sessions root: ${resolved}`)
    }
    if (!(await isSessionDir(resolved))) {
      throw new Error(`session directory does not contain a session log: ${resolved}`)
    }
    await rm(resolved, { recursive: true, force: true })
  }
}

/** Minimal JSON body reader for the custom endpoints. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Register one exact HTTP route for the archive manager. */
function registerRoute(ctx, pathname, handler) {
  const disposer = ctx.webServer.register({
    kind: 'exact',
    path: pathname,
    handler,
  })
  ctx.effect(() => disposer, `desktop-archive: route ${pathname}`)
}

/** Validate a sessionIds payload array. */
function sanitizeIds(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('sessionIds must be a non-empty array')
  }
  const ids = [...new Set(raw.map(String))]
  for (const id of ids) encodeSessionSegment(id)
  return ids
}

/**
 * Host plugin body: three endpoints.
 *   POST /api/desktop-archive.list    -> { items: [...] }
 *   POST /api/desktop-archive.restore -> { sessionIds } -> { restored: [...] }
 *   POST /api/desktop-archive.delete  -> { sessionIds } -> { deleted: [...] }
 */
export function apply(ctx) {
  const respond = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }
  const fail = (res, error) => {
    respond(res, 200, {
      ok: false,
      error: error?.code ?? 'internal',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  registerRoute(ctx, '/api/desktop-archive.list', async (req, res) => {
    try {
      const items = await listArchived(ctx)
      respond(res, 200, { ok: true, items })
    } catch (error) {
      fail(res, error)
    }
  })

  registerRoute(ctx, '/api/desktop-archive.restore', async (req, res) => {
    try {
      const { sessionIds } = await readBody(req)
      const ids = sanitizeIds(sessionIds)
      for (const id of ids) await restoreSession(ctx, id)
      respond(res, 200, { ok: true, restored: ids })
    } catch (error) {
      fail(res, error)
    }
  })

  registerRoute(ctx, '/api/desktop-archive.delete', async (req, res) => {
    try {
      const { sessionIds } = await readBody(req)
      const ids = sanitizeIds(sessionIds)
      const deleted = []
      const failed = []
      for (const id of ids) {
        try {
          await deleteSession(ctx, id)
          deleted.push(id)
        } catch (error) {
          failed.push({
            sessionId: id,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      respond(res, 200, { ok: true, deleted, failed })
    } catch (error) {
      fail(res, error)
    }
  })

  // Serve the bundled default wallpaper video (seeded into IndexedDB on the
  // renderer's first launch). The path is injected by the desktop launcher
  // via DSH_DESKTOP_ASSETS (the packaged resources directory).
  registerRoute(ctx, '/api/desktop-assets.wallpaper', (req, res) => {
    try {
      const assets = process.env.DSH_DESKTOP_ASSETS
      if (!assets) throw new Error('DSH_DESKTOP_ASSETS is not set')
      const file = path.join(assets, 'wallpaper', 'default.mp4')
      const info = statSync(file)
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': info.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      const stream = createReadStream(file)
      stream.on('error', () => {
        res.destroy()
      })
      stream.pipe(res)
    } catch (error) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'wallpaper asset missing' }))
    }
  })
}

export default { name, inject, apply }

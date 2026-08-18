/**
 * Harness Desktop patch: make the Aqua wallpaper survive restarts.
 *
 * The plugin's default video path relies on the File System Access handle,
 * whose permission is not reliably persisted by Electron across launches, so
 * the wallpaper silently disappears until the user re-picks the file. This
 * patch makes every newly picked video persist as an IndexedDB blob (the
 * plugin's own `idb:` path) and migrates an existing `fsa:` wallpaper into
 * the blob store the next time it loads.
 *
 * Idempotent: a bundle that is already patched is left untouched.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const marker = 'Harness Desktop patch'

/** Replace the FSA-first picker with the always-blob picker. */
function patchPicker(source) {
  if (source.includes(marker)) return source

  const original =
    '\t\t\t\t\t\tif (await saveVideoHandle(handle)) setWallpaper(`fsa:${handle.name}`);\n'
    + '\t\t\t\t\t\telse {\n'
    + '\t\t\t\t\t\t\tconst file = await handle.getFile();\n'
    + '\t\t\t\t\t\t\tsaveVideoBlob(file).then((id) => {\n'
    + '\t\t\t\t\t\t\t\tif (id !== "") setWallpaper(id);\n'
    + '\t\t\t\t\t\t\t\telse fileToDataUrl(file).then(setWallpaper);\n'
    + '\t\t\t\t\t\t\t});\n'
    + '\t\t\t\t\t\t}'

  const replacement =
    '\t\t\t\t\t\tconst file = await handle.getFile();\n'
    + '\t\t\t\t\t\tsaveVideoBlob(file).then((id) => {\n'
    + '\t\t\t\t\t\t\tif (id !== "") setWallpaper(id);\n'
    + '\t\t\t\t\t\t\telse fileToDataUrl(file).then(setWallpaper);\n'
    + '\t\t\t\t\t\t});'

  if (!source.includes(original)) {
    throw new Error('patch-aqua-wallpaper: picker block not found (bundle changed?)')
  }
  return source.replace(original, replacement)
}

/** Add the fsa -> idb migration inside the legacy fsa playback branch. */
function patchMigration(source) {
  if (source.includes(marker)) return source

  const anchor =
    '\t\t\t\t\t\t\tvideo.setAttribute("src", url);\n'
    + '\t\t\t\t\t\t\tthis.configureWallpaperVideo(video);\n'
    + '\t\t\t\t\t\t} catch {}'

  const migrated =
    '\t\t\t\t\t\t\tvideo.setAttribute("src", url);\n'
    + '\t\t\t\t\t\t\tthis.configureWallpaperVideo(video);\n'
    + '\t\t\t\t\t\t\tsaveVideoBlob(file).then((id) => {\n'
    + '\t\t\t\t\t\t\t\tif (id === "" || this.settings.wallpaper !== wallpaper) return;\n'
    + '\t\t\t\t\t\t\t\tthis.setWallpaper(id);\n'
    + '\t\t\t\t\t\t\t});\n'
    + '\t\t\t\t\t\t} catch {}'

  if (!source.includes(anchor)) {
    throw new Error('patch-aqua-wallpaper: migration anchor not found (bundle changed?)')
  }
  return source.replace(anchor, migrated)
}

/**
 * Fix the slot-registration API mismatch for dsh rc.6: the official client
 * declares `settings.plugin.item` as a KEYED slot (requires options.key),
 * while the plugin ships the older rc.5 shape (options.id). Without this the
 * whole client plugin fails to apply and the Aqua layer never mounts.
 */
function patchSlotKey(source) {
  if (source.includes('key: "aqua",')) return source
  const original =
    '\t\t\tctx.slots.inject("settings.plugin.item", () => ctx.slots.register({\n'
    + '\t\t\t\tname: "settings.plugin.item",\n'
    + '\t\t\t\tid: "aqua",'
  const replacement =
    '\t\t\tctx.slots.inject("settings.plugin.item", () => ctx.slots.register({\n'
    + '\t\t\t\tname: "settings.plugin.item",\n'
    + '\t\t\t\tkey: "aqua",\n'
    + '\t\t\t\tid: "aqua",'
  if (!source.includes(original)) {
    throw new Error('patch-aqua-wallpaper: slot-key block not found (bundle changed?)')
  }
  return source.replace(original, replacement)
}

/**
 * Harness Desktop default configuration: deep-sea dark default with the
 * bundled cloud wallpaper video and the tuned glass recipe:
 *   blur 16, frost 13, video blur 4.5, video brightness 20,
 *   background = wallpaper (idb:default-video).
 * Applied to both the layer's SETTINGS_DEFAULTS and the settings-row store
 * initial state, so a fresh profile boots straight into the branded look
 * before any localStorage exists.
 */
function patchDefaults(source) {
  if (source.includes('idb:default-video')) return source

  // SETTINGS_DEFAULTS (3 tabs).
  source = source.replaceAll('\t\t\tblur: 20,\n', '\t\t\tblur: 16,\n')
  source = source.replaceAll('\t\t\tfrost: 7,\n', '\t\t\tfrost: 13,\n')
  source = source.replaceAll(
    '\t\t\tbackground: "fluid",\n\t\t\twallpaper: "",',
    '\t\t\tbackground: "wallpaper",\n\t\t\twallpaper: "idb:default-video",',
  )
  source = source.replaceAll(
    '\t\t\tvideoBlur: 6,\n\t\t\tvideoBrightness: 45',
    '\t\t\tvideoBlur: 4.5,\n\t\t\tvideoBrightness: 20',
  )

  // Settings-row store initial state (5 tabs).
  source = source.replaceAll('\t\t\t\t\tblur: 20,\n', '\t\t\t\t\tblur: 16,\n')
  source = source.replaceAll('\t\t\t\t\tfrost: 7,\n', '\t\t\t\t\tfrost: 13,\n')
  source = source.replaceAll(
    '\t\t\t\t\tbackground: "fluid",\n\t\t\t\t\twallpaper: "",',
    '\t\t\t\t\tbackground: "wallpaper",\n\t\t\t\t\twallpaper: "idb:default-video",',
  )
  source = source.replaceAll(
    '\t\t\t\t\tvideoBlur: 6,\n\t\t\t\t\tvideoBrightness: 45,',
    '\t\t\t\t\tvideoBlur: 4.5,\n\t\t\t\t\tvideoBrightness: 20,',
  )

  source = source.replace(
    'const SETTINGS_DEFAULTS = {',
    '/* Harness Desktop defaults: dark video wallpaper */\n\t\tconst SETTINGS_DEFAULTS = {',
  )
  return source
}

/**
 * 视频壁纸下的对话气泡：插件为可读性给气泡近乎实色背景（#ffffffb3 /
 * #00000080），这里改成半透明玻璃，文字依旧清晰但背景是磨砂透出的视频。
 */
function patchVideoBubble(source) {
  if (source.includes('rgba(13,18,25,0.5)')) return source
  const light = 'html[data-dsh-float][data-dsh-aqua-wallpaper][data-dsh-aqua-media=video] [class*=bubble]{background:#ffffffb3'
  const dark = 'html[data-dsh-float][data-dsh-aqua-wallpaper][data-dsh-aqua-media=video] body[data-ds-dark-theme] [class*=bubble]{background:#00000080'
  if (!source.includes(light) || !source.includes(dark)) {
    throw new Error('patch-aqua-wallpaper: video bubble rules not found (bundle changed?)')
  }
  source = source.replace(light, 'html[data-dsh-float][data-dsh-aqua-wallpaper][data-dsh-aqua-media=video] [class*=bubble]{background:rgba(255,255,255,0.42)')
  source = source.replace(dark, 'html[data-dsh-float][data-dsh-aqua-wallpaper][data-dsh-aqua-media=video] body[data-ds-dark-theme] [class*=bubble]{background:rgba(13,18,25,0.5)')
  return source
}

const target = process.argv[2]
if (!target) {
  console.error('usage: node patch-aqua-wallpaper.mjs <path-to-lib/client.js>')
  process.exit(1)
}

const file = path.resolve(target)
let source = readFileSync(file, 'utf8')
const before = source
if (!source.includes(marker)) {
  source = patchPicker(source)
  source = patchMigration(source)
  source = patchSlotKey(source)
  source = source.replace(
    '\t\t\t/** Pick a video.',
    '\t\t\t/* Harness Desktop patch: persistent video wallpaper (idb blob store) */\n\t\t\t/** Pick a video.',
  )
  source = source.replace(
    '\t\t\t\t\t} else if (wallpaper.startsWith("fsa:")) if (this.videoBlobId === wallpaper && this.videoObjectUrl !== void 0) {} else loadVideoHandle().then(async (handle) => {\n',
    '\t\t\t\t\t} else if (wallpaper.startsWith("fsa:")) if (this.videoBlobId === wallpaper && this.videoObjectUrl !== void 0) {} else loadVideoHandle().then(async (handle) => {\n\t\t\t\t\t\t/* Harness Desktop patch: migrate legacy fsa wallpaper into idb blob */\n',
  )
}
// Defaults are applied even to bundles that already carry the wallpaper
// patch (the marker is set, but the defaults may be from an older build).
source = patchDefaults(source)
source = patchVideoBubble(source)
if (source !== before) {
  writeFileSync(file, source)
  console.log(`patched: ${file}`)
} else {
  console.log(`already patched: ${file}`)
}

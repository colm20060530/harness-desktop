// image-api.mjs - Node fallback HTTP client for ds-image-skill.
//
// Uses Node's own OpenSSL TLS (bundled with the desktop app), so it works even
// in shell contexts where Windows Schannel cannot acquire client credentials.
// All inputs arrive through environment variables set by image-generate.ps1.
// Prints exactly one JSON document to stdout.

import fs from 'node:fs'
import path from 'node:path'

const apiKey = process.env.HD_IMAGE_API_KEY || ''
const baseUrl = (process.env.HD_IMAGE_BASE_URL || 'https://tokenrhythm.studio/v1').replace(/\/+$/, '')
const model = process.env.HD_IMAGE_MODEL || 'qwen-image-2.0'
const prompt = process.env.HD_IMAGE_PROMPT || ''
const outDir = process.env.HD_IMAGE_OUT_DIR || ''
const filename = process.env.HD_IMAGE_FILENAME || ''

const out = (obj) => process.stdout.write(JSON.stringify(obj))

if (!apiKey) {
  out({ status: 'error', code: 'NO_API_KEY', message: 'No TokenRhythm API key configured. Ask the user to configure it in Settings -> Models -> Image Generation card.' })
  process.exit(0)
}

async function main() {
  try {
    const endpoint = `${baseUrl}/images/generations`
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt }),
      signal: AbortSignal.timeout(180000),
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch {}
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`
      out({ status: 'error', code: 'HTTP_ERROR', message: String(msg) })
      return
    }
    const item = data && data.data && data.data[0]
    let imageBytes = null
    let mime = 'image/png'
    if (item && item.b64_json) {
      imageBytes = Buffer.from(String(item.b64_json), 'base64')
    } else if (item && item.url) {
      const dl = await fetch(String(item.url), { signal: AbortSignal.timeout(120000) })
      if (!dl.ok) {
        out({ status: 'error', code: 'DOWNLOAD_FAILED', message: `download HTTP ${dl.status}` })
        return
      }
      imageBytes = Buffer.from(await dl.arrayBuffer())
      const ct = String(dl.headers.get('content-type') || '').split(';')[0].toLowerCase()
      if (ct.startsWith('image/')) mime = ct
    } else {
      out({ status: 'error', code: 'BAD_RESPONSE', message: 'Image API returned no image data.' })
      return
    }

    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
    const dir = outDir || path.join(process.cwd(), 'images')
    fs.mkdirSync(dir, { recursive: true })
    let name = filename
    if (name) {
      if (!path.extname(name)) name += '.' + ext
    } else {
      const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
      name = `generated-${ts}.${ext}`
    }
    const target = path.join(dir, name)
    fs.writeFileSync(target, imageBytes)
    out({
      status: 'ok',
      provider: 'tokenrhythm',
      model,
      path: target,
      mime_type: mime,
      size_bytes: imageBytes.length,
      image_id: item && item.image_id ? String(item.image_id) : '',
      cost_cny: data && data.cost_cny != null ? String(data.cost_cny) : '',
    })
  } catch (e) {
    out({ status: 'error', code: 'UNEXPECTED', message: String((e && e.message) || e) })
  }
}

main()

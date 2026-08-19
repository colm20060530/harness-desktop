#!/usr/bin/env node
/**
 * Harness Desktop — client conversation display patch.
 *
 * When a text-only model receives an image, the host keeps the model-visible
 * message content as text (the ds-vision-skill directive) and stores the
 * user's original image blocks in a companion `displayContent` field on the
 * same user message. The official chat UI renders `content` verbatim, which
 * would show the internal directive to the user.
 *
 * This patch teaches the official `dsh-client-ui-conversation` bundle to
 * prefer `displayContent` when one is present, so the chat shows the user's
 * own image and text while the hidden directive never appears on screen.
 *
 * Idempotent: re-running on an already patched file is a no-op.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const MARKER = '// @harness-desktop vision-display patch'

const target = process.argv[2]
if (!target) {
  console.error('usage: patch-client-vision-display.mjs <path/to/dsh-client-ui-conversation/lib/client.js>')
  process.exit(2)
}
if (!existsSync(target)) {
  console.error(`target not found: ${target}`)
  process.exit(2)
}

let source = readFileSync(target, 'utf8')
if (source.includes(MARKER)) {
  console.log(`already patched: ${target}`)
  process.exit(0)
}

const old = 'content: event.data.content,'
const count = source.split(old).length - 1
if (count !== 3) {
  console.error(`expected 3 message-node content bindings, found ${count} in ${target}; aborting (manual review needed)`)
  process.exit(1)
}

source = source.split(old).join('content: event.data.displayContent ?? event.data.content,')

const definitionAnchor = 'const messageDefinition = {'
if (!source.includes(definitionAnchor)) {
  console.error(`messageDefinition anchor not found in ${target}; aborting`)
  process.exit(1)
}
source = source.replace(definitionAnchor, `${MARKER}
const messageDefinition = {`)

if (!source.includes('event.data.displayContent ?? event.data.content')) {
  console.error('patch verification failed; nothing written')
  process.exit(1)
}

writeFileSync(target, source)
console.log(`patched: ${target}`)

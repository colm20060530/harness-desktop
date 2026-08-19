#!/usr/bin/env node
/**
 * Harness Desktop — vision-skill admission patch.
 *
 * The official dsh host rejects image attachments when the selected model
 * does not declare image input modalities (MODEL_DOES_NOT_SUPPORT_IMAGES).
 * For text-only models that use the built-in ds-vision-skill (local
 * GLM/OCR routing) this blocks the whole feature: the message never reaches
 * the agent.
 *
 * This patch changes the admission flow in the bundled dsh-host-apiproxy:
 *   - vision-capable models: images pass through unchanged (official behavior);
 *   - text-only models: instead of rejecting, each image block is replaced in
 *     `content` (the model-visible surface) by a text block that names the
 *     attachment's content-addressed file path and instructs the model to
 *     read it with ds-vision-skill (or an equivalent local vision/OCR skill).
 *     The original image is kept in a companion `displayContent` field on the
 *     same user message so the chat UI can render the user's own picture
 *     while the model API only ever receives text.
 *
 * The patch also teaches the attachment-authorization scan (`imageInEvent`)
 * to look inside `displayContent`, so the rendered image can still be loaded
 * by the browser even though the model-visible `content` is text-only.
 *
 * Idempotent: re-running on an already patched file is a no-op, and a file
 * carrying the previous revision of this patch is migrated in place.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const MARKER = '// @harness-desktop vision-skill patch'
const DISPLAY_MARKER = 'displayContent: durable'
const IMAGE_EVENT_MARKER = 'if (data.displayContent !== void 0) {'

const target = process.argv[2]
if (!target) {
  console.error('usage: patch-vision-skill.mjs <path/to/dsh-host-apiproxy/lib/index.js>')
  process.exit(2)
}
if (!existsSync(target)) {
  console.error(`target not found: ${target}`)
  process.exit(2)
}

let source = readFileSync(target, 'utf8')
if (source.includes(DISPLAY_MARKER) && source.includes(IMAGE_EVENT_MARKER)) {
  console.log(`already patched (displayContent): ${target}`)
  process.exit(0)
}
if (source.includes(MARKER)) {
  console.log(`migrating previous vision-skill patch: ${target}`)
}

// 1) Make `join` available for building the attachment object path.
const importBefore = 'import { dirname, extname } from "node:path";'
if (source.includes(importBefore) && !source.includes('import { dirname, extname, join } from "node:path";')) {
  source = source.replace(importBefore, 'import { dirname, extname, join } from "node:path";')
}

// 2) Insert the text-block helper right before durablePromptContent.
const helper = `${MARKER}
function visionSkillTextBlock(attachment) {
  const sha = String(attachment.attachmentId || "").replace(/^sha256:/, "");
  const valid = /^[a-f0-9]{64}$/.test(sha);
  const name = typeof attachment.name === "string" && attachment.name !== "" ? attachment.name : "图片";
  const dims = attachment.width !== void 0 && attachment.height !== void 0 ? attachment.width + "×" + attachment.height : "尺寸未知";
  const location = valid
    ? "文件路径：" + join(process.env.DSH_HOME || "", "attachments", "v1", "objects", sha.slice(0, 2), sha)
    : "附件ID：" + attachment.attachmentId;
  return {
    type: "text",
    text: "[用户上传了一张" + name + "（" + (attachment.mediaType || "image") + "，" + dims + "）。"
      + location
      + "。当前模型无法直接查看图片，请调用 ds-vision-skill 技能读取该图片文件进行识别（图片理解走视觉模型，纯文字识别走 OCR），再把识别结果整理后告诉用户。]"
  };
}
`
const anchor = 'async function durablePromptContent(ctx, content) {'
if (!source.includes('function visionSkillTextBlock(attachment)')) {
  if (!source.includes(anchor)) {
    console.error(`unexpected anchor (durablePromptContent) missing in ${target}; aborting`)
    process.exit(1)
  }
  source = source.replace(anchor, helper + '\n' + anchor)
}

// 3) Replace the whole image admission region (original or previous patch)
//    with the displayContent-aware transform. The region runs from
//    `if (hasImage) {` through the end of the if/else block (the else branch
//    closes right before the admit() catch), so the replacement is
//    independent of whether the file was previously patched.
const region = /if \(hasImage\) \{[\s\S]*?else agent\.followup\(message\);\n\t\t\t\t\t\t\}\n\t\t\t\t\t\} catch \(error\) \{/m
if (!region.test(source)) {
  console.error(`admit() image region not found in ${target}; aborting`)
  process.exit(1)
}
const transformedAdmit = `if (hasImage) {
							const current = selectionFor(agent).current;
							const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
							const supportsImage = modelInfo.inputModalities === void 0 || modelInfo.inputModalities.includes("image");
							const durable = await durablePromptContent(ctx, content);
							const contentForModel = supportsImage
								? durable
								: durable.map((block) => block.type === "image" ? visionSkillTextBlock(block.attachment) : block);
							const message = createUserMessage({
								content: contentForModel,
								...supportsImage || !durable.some((block) => block.type === "image") ? {} : { displayContent: durable },
								source
							});
							if (mode === "steer") agent.steer(message);
							else agent.followup(message);
						} else {
							const message = createUserMessage({ content: await durablePromptContent(ctx, content), source });
							if (mode === "steer") agent.steer(message);
							else agent.followup(message);
						}` + '\n\t\t\t\t\t} catch (error) {'
source = source.replace(region, transformedAdmit)

// 4) Teach the attachment-authorization scan to also find images carried in
//    displayContent (the UI-only copy of a transformed user message).
const imageEventAnchor = `function imageInEvent(event, match) {
	const data = event.data;
	const direct = imageBlockIn(data.content, match);
	if (direct !== void 0) return direct;`
if (!source.includes(IMAGE_EVENT_MARKER)) {
  if (!source.includes(imageEventAnchor)) {
    console.error(`imageInEvent anchor not found in ${target}; aborting`)
    process.exit(1)
  }
  const imageEventPatch = imageEventAnchor + `
	if (data.displayContent !== void 0) {
		const display = imageBlockIn(data.displayContent, match);
		if (display !== void 0) return display;
	}`
  source = source.replace(imageEventAnchor, imageEventPatch)
}

if (!source.includes(DISPLAY_MARKER) || !source.includes(IMAGE_EVENT_MARKER) || !source.includes('visionSkillTextBlock')) {
  console.error('patch verification failed; nothing written')
  process.exit(1)
}

writeFileSync(target, source)
console.log(`patched: ${target}`)

/**
 * Harness Desktop built-in DeepSeek vision reminder (renderer side).
 *
 * Injected into the official dsh web UI by the desktop launcher. When the
 * user opens 设置 → 模型 and a DeepSeek provider/model is present, a small
 * glass card appears under the section title reminding them that DeepSeek
 * models can gain image-recognition by asking the model itself to install
 * ds-vision-skill. The card consumes the Aqua plugin's glass variables, and
 * dismissal is remembered for the session.
 */
(function installVisionHint() {
  'use strict'

  const ID = 'hd-vision-hint'
  const KEY = 'hd.vision-hint.dismissed'

  let timer = null

  function dismissed() {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  }

  function findModelTitle(dialog) {
    const candidates = dialog.querySelectorAll('h1, h2, h3, [class*="title"]')
    for (const node of candidates) {
      const text = (node.textContent || '').trim()
      if (text.length > 0 && text.length <= 12 && /^(模型|模型设置|Models?)$/i.test(text)) return node
    }
    return null
  }

  function renderHint(after) {
    const card = document.createElement('div')
    card.id = ID
    card.className = 'hd-vision-hint'
    card.setAttribute('role', 'note')

    const icon = document.createElement('div')
    icon.className = 'hd-vision-hint-icon'
    icon.textContent = '💡'

    const body = document.createElement('div')
    body.className = 'hd-vision-hint-body'
    const title = document.createElement('div')
    title.className = 'hd-vision-hint-title'
    title.textContent = 'DeepSeek 识图小贴士'
    const text = document.createElement('div')
    text.className = 'hd-vision-hint-text'
    text.textContent =
      'DeepSeek 系列模型默认不具备图片识别能力。需要识图时，直接在对话中告诉模型「请安装 ds-vision-skill」，'
      + '模型会自己下载安装这个技能；安装后即可上传图片，让 DeepSeek 帮你识别、读图。'
    body.appendChild(title)
    body.appendChild(text)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'hd-vision-hint-close'
    close.setAttribute('aria-label', '关闭提示')
    close.textContent = '知道了'
    close.addEventListener('click', () => {
      try {
        localStorage.setItem(KEY, '1')
      } catch {
        // ignore
      }
      card.remove()
    })

    card.appendChild(icon)
    card.appendChild(body)
    card.appendChild(close)
    after.insertAdjacentElement('afterend', card)
  }

  function scan() {
    const old = document.getElementById(ID)
    if (old !== null) old.remove()
    if (dismissed()) return

    const dialog = document.querySelector('[role="dialog"]')
    if (dialog === null) return
    const title = findModelTitle(dialog)
    if (title === null) return
    if (!/deepseek/i.test(dialog.textContent || '')) return
    renderHint(title)
  }

  function schedule() {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(scan, 350)
  }

  // ---- style ------------------------------------------------------------------------
  const STYLE = `
  .hd-vision-hint {
    display: flex; align-items: flex-start; gap: 10px;
    max-width: 680px; margin: 0 0 14px; padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid rgba(110, 155, 232, 0.28);
    background: rgba(255, 255, 255, 0.6);
    -webkit-backdrop-filter: blur(var(--dsh-aqua-blur, 18px)) saturate(140%);
    backdrop-filter: blur(var(--dsh-aqua-blur, 18px)) saturate(140%);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.5), 0 10px 30px rgba(19, 45, 83, 0.12);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  html[data-dsh-aqua] .hd-vision-hint {
    background: color-mix(in srgb, #ffffff calc(58% * var(--dsh-aqua-surface-frost, 1.2)), transparent);
    border-color: color-mix(in srgb, #6e9be8 45%, transparent);
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint {
    background: color-mix(in srgb, #232a36 calc(60% * var(--dsh-aqua-surface-frost, 1.2)), transparent);
    border-color: rgba(148, 180, 220, 0.3);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.07), 0 10px 30px rgba(2, 6, 14, 0.45);
  }
  .hd-vision-hint-icon { font-size: 18px; line-height: 1.3; flex: none; }
  .hd-vision-hint-body { flex: 1; min-width: 0; }
  .hd-vision-hint-title {
    color: #1d3556; font-size: 13px; font-weight: 600; line-height: 1.4; margin-bottom: 3px;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-title { color: #e6f4ff; }
  .hd-vision-hint-text {
    color: #5d7696; font-size: 12px; line-height: 1.65;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-text { color: #a9c4e0; }
  .hd-vision-hint-close {
    flex: none; height: 26px; padding: 0 12px; border-radius: 999px;
    border: 1px solid rgba(110, 155, 232, 0.3);
    background: rgba(110, 155, 232, 0.12);
    color: #4a80c8; font: 500 11.5px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    cursor: pointer;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-close { color: #9fc9ef; }
  .hd-vision-hint-close:hover { background: rgba(110, 155, 232, 0.24); }
  `
  const styleEl = document.createElement('style')
  styleEl.id = ID + '-style'
  styleEl.textContent = STYLE
  document.head.appendChild(styleEl)

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()
})()

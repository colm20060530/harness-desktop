/**
 * Harness Desktop built-in TokenRhythm image-generation reminder (renderer side).
 *
 * Injected into the official dsh web UI by the desktop launcher. When the
 * user opens 设置 → 模型, a glass card appears directly below the DeepSeek
 * vision card where they can configure the TokenRhythm (基元律动) API Key for
 * the built-in ds-image-skill.
 *
 * This key is used ONLY by the image-generation skill (qwen-image-2.0 /
 * wan2.7-image, per-image billing). It is not a chat-model provider: it never
 * appears in the model picker and is never used to power conversation models.
 * Saving it calls credentials.set (TOKENRHYTHM_API_KEY) and the desktop main
 * process watches the credentials document and writes it into the skill's
 * config.json — the same key already used by a TokenRhythm chat provider is
 * detected and reused automatically.
 *
 * Dismissal only lasts for the current visit: closing 设置 or leaving 模型
 * resets it, so the card reappears every time the user opens 设置 → 模型.
 */
(function installImageHint() {
  'use strict'

  const ID = 'hd-image-hint'

  let timer = null
  let dismissedFlag = false
  let periodic = null

  async function rpc(method, payload) {
    const response = await fetch(`/api/${method}`, {
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

  function dismissed() {
    return dismissedFlag
  }

  function findModelTitle(dialog) {
    const candidates = dialog.querySelectorAll('h1, h2, h3, [class*="title"]')
    for (const node of candidates) {
      if (node.getClientRects().length === 0) continue
      const text = (node.textContent || '').trim()
      if (text.length > 0 && text.length <= 16 && /模型|Models?/i.test(text)) return node
    }
    return null
  }

  async function saveImageKey(card, input, statusEl, button) {
    const key = (input.value || '').trim()
    if (key === '') return
    button.disabled = true
    statusEl.textContent = '正在保存基元律动 API Key…'
    statusEl.dataset.state = 'checking'
    try {
      await rpc('credentials.set', { ref: 'TOKENRHYTHM_API_KEY', value: key })
      input.value = ''
      await refreshImageStatus(card)
    } catch {
      statusEl.textContent = '保存失败,请稍后重试'
      statusEl.dataset.state = 'missing'
    } finally {
      button.disabled = false
    }
  }

  async function refreshImageStatus(card) {
    const statusEl = card.querySelector('.hd-image-hint-status')
    if (statusEl === null) return
    statusEl.textContent = '正在检测基元律动 API 状态…'
    statusEl.dataset.state = 'checking'
    try {
      const data = await rpc('credentials.describe', {
        refs: ['TOKENRHYTHM_API_KEY', 'OPENSQUILLA_API_KEY'],
      })
      const creds = data?.result?.value?.credentials || {}
      const configured =
        data?.result?.ok === true
        && (creds.TOKENRHYTHM_API_KEY?.configured === true
          || creds.OPENSQUILLA_API_KEY?.configured === true)
      if (configured) {
        statusEl.textContent = '基元律动 API 已配置,生图技能已自动就绪(按张计费)'
      } else {
        statusEl.textContent = '尚未配置基元律动 API,请在下方输入框中填写'
      }
      statusEl.dataset.state = configured ? 'ok' : 'missing'
    } catch {
      statusEl.textContent = '无法检测基元律动 API 状态'
      statusEl.dataset.state = 'missing'
    }
  }

  function renderHint(after) {
    const card = document.createElement('div')
    card.id = ID
    card.className = 'hd-image-hint'
    card.setAttribute('role', 'note')

    const icon = document.createElement('div')
    icon.className = 'hd-image-hint-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/>'
      + '<circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-4.5-4.5L7 20"/></svg>'

    const body = document.createElement('div')
    body.className = 'hd-image-hint-body'
    const title = document.createElement('div')
    title.className = 'hd-image-hint-title'
    title.textContent = '生图能力(基元律动 TokenRhythm)'
    const text = document.createElement('div')
    text.className = 'hd-image-hint-text'
    text.textContent =
      '内置 ds-image-skill 生图技能支持 qwen-image-2.0 / wan2.7-image 两个模型。'
      + '这里的基元律动 API Key 仅供生图技能调用(约 ¥0.2/张,按张计费,后续需要充值),'
      + '不会出现在模型列表中,也不会被当作聊天模型使用。若已配置基元律动聊天模型,会自动复用同一个 Key。'
      + '在对话中直接说“画一张…”或“把这张图的背景换成星空”即可自动触发生图/改图,无需指定技能或模型。'
    const link = document.createElement('a')
    link.className = 'hd-image-hint-link'
    link.href = 'https://tokenrhythm.studio/account/keys'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = '还没有 Key?前往基元律动获取 →'
    const note = document.createElement('div')
    note.className = 'hd-image-hint-note'
    note.textContent = '注意:视觉识图能力走永久免费模型,无需充值;生图按张收费,需单独充值。'
    const row = document.createElement('div')
    row.className = 'hd-image-hint-row'
    const input = document.createElement('input')
    input.type = 'password'
    input.className = 'hd-image-hint-input'
    input.placeholder = '输入基元律动 API Key(如 sk_tr_...)'
    input.autocomplete = 'off'
    input.spellcheck = false
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'hd-image-hint-save'
    save.textContent = '保存'
    save.disabled = true
    const syncSaveState = () => {
      save.disabled = (input.value || '').trim() === ''
    }
    input.addEventListener('input', syncSaveState)
    save.addEventListener('click', () => void saveImageKey(card, input, status, save))
    row.appendChild(input)
    row.appendChild(save)
    const status = document.createElement('div')
    status.className = 'hd-image-hint-status'
    status.dataset.state = 'checking'
    body.appendChild(title)
    body.appendChild(text)
    body.appendChild(link)
    body.appendChild(note)
    body.appendChild(row)
    body.appendChild(status)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'hd-image-hint-close'
    close.setAttribute('aria-label', '关闭提示')
    close.textContent = '知道了'
    close.addEventListener('click', () => {
      dismissedFlag = true
      card.remove()
    })

    card.appendChild(icon)
    card.appendChild(body)
    card.appendChild(close)
    after.insertAdjacentElement('afterend', card)
    void refreshImageStatus(card)
  }

  function removeHint() {
    const old = document.getElementById(ID)
    if (old !== null) old.remove()
  }

  function findModelDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"]')
    for (const dialog of dialogs) {
      const title = findModelTitle(dialog)
      if (title !== null) return { dialog, title }
    }
    return null
  }

  function scan() {
    const found = findModelDialog()
    if (found === null) {
      // 设置面板已关闭:重置“本次已读”,保证下次打开仍然出现。
      dismissedFlag = false
      removeHint()
      return
    }
    const { title } = found
    if (dismissed()) return
    const existing = document.getElementById(ID)
    const visionCard = document.getElementById('hd-vision-hint')
    const anchor = visionCard !== null ? visionCard : title
    // 卡片必须位于视觉卡片正下方。已存在时只移动、不重建,避免触发自身
    // mutation 造成抖动,也保证 DOM 身份稳定。
    if (existing !== null) {
      if (existing.previousElementSibling !== anchor) {
        anchor.insertAdjacentElement('afterend', existing)
      }
      return
    }
    renderHint(anchor)
  }

  function schedule() {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(scan, 350)
  }

  // ---- style ------------------------------------------------------------------------
  const STYLE = `
  .hd-image-hint {
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
  html[data-dsh-aqua] .hd-image-hint {
    background: color-mix(in srgb, #ffffff calc(58% * var(--dsh-aqua-surface-frost, 1.2)), transparent);
    border-color: color-mix(in srgb, #6e9be8 45%, transparent);
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint {
    background: color-mix(in srgb, #232a36 calc(60% * var(--dsh-aqua-surface-frost, 1.2)), transparent);
    border-color: rgba(148, 180, 220, 0.3);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.07), 0 10px 30px rgba(2, 6, 14, 0.45);
  }
  .hd-image-hint-icon { color: #6e9be8; flex: none; display: flex; align-items: center; margin-top: 1px; }
  .hd-image-hint-body { flex: 1; min-width: 0; }
  .hd-image-hint-title {
    color: #1d3556; font-size: 13px; font-weight: 600; line-height: 1.4; margin-bottom: 3px;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-title { color: #e6f4ff; }
  .hd-image-hint-text {
    color: #5d7696; font-size: 12px; line-height: 1.65;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-text { color: #a9c4e0; }
  .hd-image-hint-link {
    display: inline-flex; align-items: center; gap: 4px;
    margin-top: 6px; font-size: 12px; color: #4a80c8;
    text-decoration: none; cursor: pointer;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-link { color: #9fc9ef; }
  .hd-image-hint-link:hover { text-decoration: underline; }
  .hd-image-hint-note {
    margin-top: 6px; font-size: 11.5px; line-height: 1.55;
    color: #b0632e;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-note { color: #f0b877; }
  .hd-image-hint-row {
    display: flex; gap: 8px; margin-top: 10px; align-items: center;
  }
  .hd-image-hint-input {
    flex: 1; min-width: 0; height: 30px; padding: 0 10px;
    border-radius: 9px;
    border: 1px solid rgba(110, 155, 232, 0.32);
    background: rgba(255, 255, 255, 0.55);
    color: #1d3556;
    font: 12px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    outline: none;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-input {
    background: rgba(13, 20, 31, 0.42);
    color: #e6f4ff;
    border-color: rgba(148, 180, 220, 0.3);
  }
  .hd-image-hint-input::placeholder { color: #9fb2c9; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-input::placeholder { color: #748aa6; }
  .hd-image-hint-save {
    flex: none; height: 30px; padding: 0 14px; border-radius: 9px;
    border: 1px solid rgba(110, 155, 232, 0.35);
    background: rgba(110, 155, 232, 0.18);
    color: #3f74b8; font: 600 12px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    cursor: pointer;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-save { color: #a9cdf2; }
  .hd-image-hint-save:hover:not(:disabled) { background: rgba(110, 155, 232, 0.32); }
  .hd-image-hint-save:disabled { opacity: 0.45; cursor: default; }
  .hd-image-hint-status {
    display: flex; align-items: center; gap: 6px;
    margin-top: 7px; font-size: 11.5px; line-height: 1.5;
  }
  .hd-image-hint-status:before {
    content: ""; flex: none; border-radius: 50%; width: 7px; height: 7px;
    background: #9aa7b8;
  }
  .hd-image-hint-status[data-state="ok"] { color: #2f8f5b; }
  .hd-image-hint-status[data-state="ok"]:before { background: #35b26a; }
  .hd-image-hint-status[data-state="missing"] { color: #c07a2d; }
  .hd-image-hint-status[data-state="missing"]:before { background: #e8a33d; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-status[data-state="ok"] { color: #7cd7a3; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-status[data-state="missing"] { color: #f0b877; }
  .hd-image-hint-close {
    flex: none; height: 26px; padding: 0 12px; border-radius: 999px;
    border: 1px solid rgba(110, 155, 232, 0.3);
    background: rgba(110, 155, 232, 0.12);
    color: #4a80c8; font: 500 11.5px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    cursor: pointer;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-image-hint-close { color: #9fc9ef; }
  .hd-image-hint-close:hover { background: rgba(110, 155, 232, 0.24); }
  `
  const styleEl = document.createElement('style')
  styleEl.id = ID + '-style'
  styleEl.textContent = STYLE
  document.head.appendChild(styleEl)

  const observer = new MutationObserver((records) => {
    // 忽略提示卡自身内容(状态文字)变化引起的 mutation,防止自我触发重建。
    for (const record of records) {
      const target = record.target
      if (target instanceof Element && target.closest('#' + ID) !== null) continue
      schedule()
      return
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()
  // Safety net: some settings views render asynchronously after the dialog
  // opens; re-scan periodically in case a mutation batch was missed.
  periodic = setInterval(schedule, 2000)
  window.addEventListener('beforeunload', () => {
    if (periodic !== null) clearInterval(periodic)
  })
})()

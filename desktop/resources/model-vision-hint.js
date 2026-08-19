/**
 * Harness Desktop built-in DeepSeek vision reminder (renderer side).
 *
 * Injected into the official dsh web UI by the desktop launcher. When the
 * user opens 设置 → 模型, a small glass card appears under the section title
 * where they can configure the GLM vision API Key.
 *
 * This key is used ONLY by the built-in ds-vision-skill (DeepSeek 识图).
 * It is not a chat-model provider: it never appears in the model picker and
 * is never used to power conversation models. Saving it calls the official
 * credentials.set (ZHIPU_API_KEY) and the desktop main process watches the
 * credentials document and writes it into the skill's config.json — no
 * manual skill installation is needed.
 *
 * The card consumes the Aqua plugin's glass variables, and dismissal only
 * lasts for the current visit: closing 设置 or leaving 模型 resets it, so the
 * hint reappears every time the user opens 设置 → 模型.
 */
(function installVisionHint() {
  'use strict'

  const ID = 'hd-vision-hint'

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

  async function saveVisionKey(card, input, statusEl, button) {
    const key = (input.value || '').trim()
    if (key === '') return
    button.disabled = true
    statusEl.textContent = '正在保存 GLM 视觉 API Key…'
    statusEl.dataset.state = 'checking'
    try {
      await rpc('credentials.set', { ref: 'ZHIPU_API_KEY', value: key })
      input.value = ''
      await refreshGlmStatus(card)
    } catch {
      statusEl.textContent = '保存失败,请稍后重试'
      statusEl.dataset.state = 'missing'
    } finally {
      button.disabled = false
    }
  }

  async function refreshGlmStatus(card) {
    const statusEl = card.querySelector('.hd-vision-hint-status')
    if (statusEl === null) return
    statusEl.textContent = '正在检测 GLM 视觉 API 状态…'
    statusEl.dataset.state = 'checking'
    try {
      const data = await rpc('credentials.describe', { refs: ['ZHIPU_API_KEY'] })
      const configured =
        data?.result?.ok === true
        && data.result.value.credentials?.ZHIPU_API_KEY?.configured === true
      if (configured) {
        statusEl.textContent = 'GLM 视觉 API 已配置,识图技能已自动就绪'
      } else {
        statusEl.textContent = '尚未配置 GLM 视觉 API,请在下方输入框中填写'
      }
      statusEl.dataset.state = configured ? 'ok' : 'missing'
    } catch {
      statusEl.textContent = '无法检测 GLM 视觉 API 状态'
      statusEl.dataset.state = 'missing'
    }
  }

  function renderHint(after) {
    const card = document.createElement('div')
    card.id = ID
    card.className = 'hd-vision-hint'
    card.setAttribute('role', 'note')

    const icon = document.createElement('div')
    icon.className = 'hd-vision-hint-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/>'
      + '<path d="M11 12h1v5h1"/></svg>'

    const body = document.createElement('div')
    body.className = 'hd-vision-hint-body'
    const title = document.createElement('div')
    title.className = 'hd-vision-hint-title'
    title.textContent = 'DeepSeek 识图配置'
    const text = document.createElement('div')
    text.className = 'hd-vision-hint-text'
    text.textContent =
      'DeepSeek 系列模型默认不能直接读图。这里的 GLM 视觉 API Key 仅供内置 ds-vision-skill 识图技能使用：'
      + '保存后应用会自动把它写入技能配置，DeepSeek 上传图片时即可调用技能完成识别。'
      + '该 Key 不会出现在模型列表中，也不会被当作聊天模型使用。'
    const link = document.createElement('a')
    link.className = 'hd-vision-hint-link'
    link.href = 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = '还没有 Key？前往智谱开放平台获取 →'
    const row = document.createElement('div')
    row.className = 'hd-vision-hint-row'
    const input = document.createElement('input')
    input.type = 'password'
    input.className = 'hd-vision-hint-input'
    input.placeholder = '输入 GLM 视觉 API Key（如 sk-...）'
    input.autocomplete = 'off'
    input.spellcheck = false
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'hd-vision-hint-save'
    save.textContent = '保存'
    save.disabled = true
    const syncSaveState = () => {
      save.disabled = (input.value || '').trim() === ''
    }
    input.addEventListener('input', syncSaveState)
    save.addEventListener('click', () => void saveVisionKey(card, input, status, save))
    row.appendChild(input)
    row.appendChild(save)
    const status = document.createElement('div')
    status.className = 'hd-vision-hint-status'
    status.dataset.state = 'checking'
    body.appendChild(title)
    body.appendChild(text)
    body.appendChild(link)
    body.appendChild(row)
    body.appendChild(status)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'hd-vision-hint-close'
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
    void refreshGlmStatus(card)
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
      // 设置面板已关闭：重置“本次已读”，保证下次打开仍然出现。
      dismissedFlag = false
      removeHint()
      return
    }
    const { dialog, title } = found
    if (!/deepseek|glm|zhipu/i.test(dialog.textContent || '')) return
    if (dismissed()) return
    // 卡片已在页面中则不重建，避免与自身状态更新形成循环抖动。
    if (document.getElementById(ID) !== null) return
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
  .hd-vision-hint-icon { color: #6e9be8; flex: none; display: flex; align-items: center; margin-top: 1px; }
  .hd-vision-hint-body { flex: 1; min-width: 0; }
  .hd-vision-hint-title {
    color: #1d3556; font-size: 13px; font-weight: 600; line-height: 1.4; margin-bottom: 3px;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-title { color: #e6f4ff; }
  .hd-vision-hint-text {
    color: #5d7696; font-size: 12px; line-height: 1.65;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-text { color: #a9c4e0; }
  .hd-vision-hint-link {
    display: inline-flex; align-items: center; gap: 4px;
    margin-top: 6px; font-size: 12px; color: #4a80c8;
    text-decoration: none; cursor: pointer;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-link { color: #9fc9ef; }
  .hd-vision-hint-link:hover { text-decoration: underline; }
  .hd-vision-hint-row {
    display: flex; gap: 8px; margin-top: 10px; align-items: center;
  }
  .hd-vision-hint-input {
    flex: 1; min-width: 0; height: 30px; padding: 0 10px;
    border-radius: 9px;
    border: 1px solid rgba(110, 155, 232, 0.32);
    background: rgba(255, 255, 255, 0.55);
    color: #1d3556;
    font: 12px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    outline: none;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-input {
    background: rgba(13, 20, 31, 0.42);
    color: #e6f4ff;
    border-color: rgba(148, 180, 220, 0.3);
  }
  .hd-vision-hint-input::placeholder { color: #9fb2c9; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-input::placeholder { color: #748aa6; }
  .hd-vision-hint-save {
    flex: none; height: 30px; padding: 0 14px; border-radius: 9px;
    border: 1px solid rgba(110, 155, 232, 0.35);
    background: rgba(110, 155, 232, 0.18);
    color: #3f74b8; font: 600 12px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    cursor: pointer;
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-save { color: #a9cdf2; }
  .hd-vision-hint-save:hover:not(:disabled) { background: rgba(110, 155, 232, 0.32); }
  .hd-vision-hint-save:disabled { opacity: 0.45; cursor: default; }
  .hd-vision-hint-status {
    display: flex; align-items: center; gap: 6px;
    margin-top: 7px; font-size: 11.5px; line-height: 1.5;
  }
  .hd-vision-hint-status:before {
    content: ""; flex: none; border-radius: 50%; width: 7px; height: 7px;
    background: #9aa7b8;
  }
  .hd-vision-hint-status[data-state="ok"] { color: #2f8f5b; }
  .hd-vision-hint-status[data-state="ok"]:before { background: #35b26a; }
  .hd-vision-hint-status[data-state="missing"] { color: #c07a2d; }
  .hd-vision-hint-status[data-state="missing"]:before { background: #e8a33d; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-status[data-state="ok"] { color: #7cd7a3; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .hd-vision-hint-status[data-state="missing"] { color: #f0b877; }
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

  const observer = new MutationObserver((records) => {
    // 忽略提示卡自身内容（状态文字）变化引起的 mutation，防止自我触发重建。
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

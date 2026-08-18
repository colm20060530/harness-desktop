/**
 * Harness Desktop built-in "检查更新" (renderer side).
 *
 * Injected into the official dsh web UI by the desktop launcher. Adds a
 * "检查更新" entry to the settings panel navigation. Clicking it queries the
 * bundled host route `/api/desktop-update.check` (which only compares the
 * installed version against the latest GitHub/Gitee release — it never
 * downloads anything). When a newer version exists, a dialog shows the
 * release page URL; the user decides whether to update.
 */
(function installUpdateCheck() {
  'use strict'

  const NS = 'hd-update'
  const API_CHECK = '/api/desktop-update.check'
  const REPO_URL = 'https://github.com/colm20060530/harness-desktop/releases'

  // ---- idempotency ----------------------------------------------------------
  if (document.getElementById(`${NS}-root`) !== null) return

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  // ---- toast ----------------------------------------------------------------
  function toast(message, kind) {
    const box = document.getElementById(`${NS}-toast`)
    if (box !== null) box.remove()
    const node = el('div', `${NS}-toast ${NS}-toast-${kind || 'info'}`)
    node.id = `${NS}-toast`
    node.textContent = message
    document.body.appendChild(node)
    setTimeout(() => {
      node.classList.add(`${NS}-toast-hide`)
      setTimeout(() => node.remove(), 350)
    }, 3200)
  }

  // ---- result dialog ---------------------------------------------------------
  function closeDialog() {
    const modal = document.getElementById(`${NS}-modal`)
    if (modal !== null) modal.remove()
  }

  function showResult(data) {
    closeDialog()
    const modal = el('div', `${NS}-modal`)
    modal.id = `${NS}-modal`
    const card = el('div', `${NS}-modal-card`)

    if (data.upToDate) {
      card.appendChild(el('div', `${NS}-modal-title`, '已是最新版本'))
      card.appendChild(el('div', `${NS}-modal-text`, `当前版本 ${data.current}，无需更新。`))
      const row = el('div', `${NS}-modal-actions`)
      const ok = el('button', `${NS}-btn ${NS}-btn-primary`, '知道了')
      ok.onclick = closeDialog
      row.appendChild(ok)
      card.appendChild(row)
    } else {
      card.appendChild(el('div', `${NS}-modal-title`, '发现新版本'))
      card.appendChild(
        el('div', `${NS}-modal-text`,
          `当前版本：${data.current}\n最新版本：${data.latest}（来自 ${data.source || '发布页'}）\n\n`
          + '点击下方链接前往发布页查看更新内容，确认需要后再自行下载更新，本应用不会自动下载。'),
      )
      const row = el('div', `${NS}-modal-actions`)
      const link = el('a', `${NS}-btn ${NS}-btn-primary ${NS}-btn-link`, '前往发布页查看更新')
      link.href = data.url || REPO_URL
      link.target = '_blank'
      link.rel = 'noreferrer'
      const close = el('button', `${NS}-btn ${NS}-btn-ghost`, '稍后再说')
      close.onclick = closeDialog
      row.appendChild(link)
      row.appendChild(close)
      card.appendChild(row)
    }

    modal.appendChild(card)
    modal.onclick = (event) => {
      if (event.target === modal) closeDialog()
    }
    document.body.appendChild(modal)
  }

  // ---- check flow -------------------------------------------------------------
  async function runCheck(button) {
    if (button !== null) {
      button.disabled = true
      button.classList.add(`${NS}-busy`)
      button.textContent = '检查中…'
    }
    try {
      const response = await fetch(API_CHECK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const data = await response.json()
      if (data.ok !== true) throw new Error(data.message || '检查失败')
      showResult(data)
    } catch (error) {
      toast(`检查更新失败：${error && error.message ? error.message : '网络不可用，请稍后再试'}`, 'error')
    } finally {
      if (button !== null) {
        button.disabled = false
        button.classList.remove(`${NS}-busy`)
        button.textContent = '检查更新'
      }
    }
  }

  // ---- inject the nav entry ----------------------------------------------------
  function injectIntoNav(navList) {
    if (navList === null || navList.querySelector(`#${NS}-cell`) !== null) return
    const cell = el('button', `${NS}-cell`)
    cell.id = `${NS}-cell`
    cell.type = 'button'
    cell.title = '检查 GitHub / Gitee 是否有新版本（仅提示，不自动下载）'
    const label = el('span', `${NS}-cell-label`, '检查更新')
    cell.appendChild(label)
    cell.onclick = () => runCheck(cell)
    navList.appendChild(cell)
  }

  /**
   * The official settings dialog (rc.6) renders as
   *   [role=dialog][aria-modal=true] > nav > (navTitle + navList)
   * where navList holds the section buttons (通用设置 / 模型 / 插件 / Agent 预设).
   * Locate navList structurally so hashed class names never break the hook.
   */
  function findNavList() {
    const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .find((d) => d.querySelector('nav') !== null && d.textContent.includes('通用设置'))
    if (dialog === undefined) return null
    const nav = dialog.querySelector('nav')
    if (nav === null) return null
    for (const child of nav.children) {
      if (child.querySelector('button') !== null && child.textContent.includes('通用设置')) return child
    }
    return null
  }

  function scan() {
    injectIntoNav(findNavList())
  }

  // ---- style ----------------------------------------------------------------------
  const STYLE = `
  .${NS}-cell {
    display: flex; align-items: center; gap: 8px;
    width: 100%; padding: 8px 12px; margin-top: 4px;
    border: 1px solid rgba(127, 216, 245, 0.22); border-radius: 9px;
    background: rgba(74, 159, 224, 0.10); color: #8fd0ff;
    font: 500 13px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    cursor: pointer; transition: background .15s ease, transform .1s ease, opacity .15s ease;
    text-align: left;
  }
  .${NS}-cell:hover:not(:disabled) { background: rgba(74, 159, 224, 0.22); color: #c7e8ff; }
  .${NS}-cell:disabled { opacity: .55; cursor: wait; }
  .${NS}-cell-label { flex: 1; }
  html[data-dsh-aqua] .${NS}-cell {
    background: color-mix(in srgb, #6e9be8 calc(16% * var(--dsh-aqua-frost, 1)), transparent);
    border-color: color-mix(in srgb, #6e9be8 38%, transparent);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  }
  html[data-dsh-aqua] .${NS}-cell:hover:not(:disabled) {
    background: color-mix(in srgb, #6e9be8 calc(30% * var(--dsh-aqua-frost, 1)), transparent);
  }
  .${NS}-toast {
    position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%);
    z-index: 2147483520; max-width: min(560px, calc(100vw - 40px));
    padding: 11px 20px; border-radius: 999px; border: 1px solid rgba(127,216,245,.3);
    background: linear-gradient(145deg, rgba(22,41,66,.96), rgba(10,18,30,.97));
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    color: #dceeff; font: 500 13px/1.3 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    box-shadow: 0 14px 40px rgba(1,5,12,.6); transition: opacity .35s ease, transform .35s ease;
  }
  .${NS}-toast-error { border-color: rgba(255,140,140,.4); color: #ffdada; }
  .${NS}-toast-hide { opacity: 0; transform: translateX(-50%) translateY(8px); }
  .${NS}-modal {
    position: fixed; inset: 0; z-index: 2147483530;
    display: flex; align-items: center; justify-content: center;
    background: rgba(2, 6, 12, 0.55); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  }
  .${NS}-modal-card {
    width: min(420px, calc(100vw - 48px)); border-radius: 16px; padding: 20px 22px;
    border: 1px solid rgba(127, 216, 245, 0.3);
    background: linear-gradient(165deg, rgba(22, 41, 66, 0.98), rgba(10, 18, 30, 0.98));
    box-shadow: 0 24px 70px rgba(0,0,0,.7);
  }
  .${NS}-modal-title { color: #dceeff; font: 700 15px/1.3 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; margin-bottom: 8px; }
  .${NS}-modal-text { color: #b9c9dc; font: 400 12.5px/1.7 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; margin-bottom: 18px; white-space: pre-line; }
  .${NS}-modal-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
  .${NS}-btn {
    display: inline-flex; align-items: center; justify-content: center;
    height: 32px; padding: 0 14px; border-radius: 9px; border: 1px solid transparent;
    font: 500 12.5px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; cursor: pointer;
    text-decoration: none; white-space: nowrap; transition: filter .15s ease, transform .1s ease;
  }
  .${NS}-btn:active { transform: translateY(1px); }
  .${NS}-btn-primary {
    background: linear-gradient(145deg, #3f7fc0, #2c5f9e); color: #fff;
    box-shadow: 0 6px 18px rgba(44,95,158,.35);
  }
  .${NS}-btn-primary:hover { filter: brightness(1.12); }
  .${NS}-btn-ghost { background: rgba(127,216,245,.1); color: #bcd8f2; }
  .${NS}-btn-ghost:hover { background: rgba(127,216,245,.2); }
  html[data-dsh-aqua] .${NS}-modal-card {
    background: color-mix(in srgb, #232a36 calc(72% * var(--dsh-aqua-surface-frost, 1.2)), transparent);
    -webkit-backdrop-filter: blur(var(--dsh-aqua-blur, 20px)) saturate(150%);
    backdrop-filter: blur(var(--dsh-aqua-blur, 20px)) saturate(150%);
  }
  @media (max-width: 640px) { .${NS}-modal-card { width: calc(100vw - 32px); } }
  `
  const styleEl = el('style')
  styleEl.id = `${NS}-style`
  styleEl.textContent = STYLE
  document.head.appendChild(styleEl)

  const root = el('div')
  root.id = `${NS}-root`
  root.style.display = 'none'
  document.body.appendChild(root)

  // Watch for the settings dialog opening; inject once per open.
  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true })
  scan()
})()

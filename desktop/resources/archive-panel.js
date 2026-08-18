/**
 * Harness Desktop built-in "恢复归档" panel (renderer side).
 *
 * Injected into the official dsh web UI by the desktop launcher. It renders a
 * floating glass button at the bottom-right corner; clicking it opens the
 * archived-conversation manager, which talks to the bundled
 * @deepseek-ai/dsh-desktop-archive host plugin through the same-origin
 * `/api/desktop-archive.*` endpoints. The official UI is never modified.
 */
(function installArchivePanel() {
  'use strict'

  // ---- idempotency: remove a previously injected instance -------------------
  const OLD = document.getElementById('hd-archive-root')
  if (OLD !== null) OLD.remove()

  const NS = 'hd-archive'
  const API_LIST = '/api/desktop-archive.list'
  const API_RESTORE = '/api/desktop-archive.restore'
  const API_DELETE = '/api/desktop-archive.delete'

  let items = []
  let selected = new Set()
  let busy = false
  let confirmAction = null

  // ---- tiny helpers -----------------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function fmtTime(value) {
    if (!value) return '时间未知'
    const t = typeof value === 'number' ? value : Date.parse(value)
    if (!Number.isFinite(t)) return '时间未知'
    const diff = Date.now() - t
    const minute = 60 * 1000
    const hour = 60 * minute
    const day = 24 * hour
    if (diff < minute) return '刚刚'
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`
    if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
    const d = new Date(t)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

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
    }, 2800)
  }

  // ---- API --------------------------------------------------------------------
  async function call(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`)
    const data = await response.json()
    if (data.ok !== true) {
      const error = new Error(data.message || '操作失败')
      error.code = data.error
      throw error
    }
    return data
  }

  async function loadItems() {
    const data = await call(API_LIST, {})
    items = data.items || []
    const known = new Set(items.map((item) => item.sessionId))
    selected = new Set([...selected].filter((id) => known.has(id)))
    render()
  }

  async function runRestore(ids) {
    if (busy) return
    busy = true
    setBusy(true)
    try {
      await call(API_RESTORE, { sessionIds: ids })
      toast(`已恢复 ${ids.length} 个对话`, 'ok')
      await loadItems()
    } catch (error) {
      toast(error.message || '恢复失败', 'error')
    } finally {
      busy = false
      setBusy(false)
    }
  }

  async function runDelete(ids) {
    if (busy) return
    busy = true
    setBusy(true)
    try {
      const data = await call(API_DELETE, { sessionIds: ids })
      const failed = data.failed || []
      const deletedCount = (data.deleted || []).length
      if (failed.length === 0) {
        toast(`已删除 ${deletedCount} 个对话，正在刷新…`, 'ok')
        setTimeout(() => window.location.reload(), 600)
      } else if (deletedCount > 0) {
        toast(`已删除 ${deletedCount} 个对话；${failed.length} 个失败：${failed[0].message}`, 'error')
        setTimeout(() => window.location.reload(), 1800)
      } else {
        toast(`删除失败：${failed[0]?.message || '未知错误'}`, 'error')
        busy = false
        setBusy(false)
      }
    } catch (error) {
      busy = false
      setBusy(false)
      toast(error.message || '删除失败', 'error')
    }
  }

  // ---- confirm modal ------------------------------------------------------------
  function askConfirm(title, message, onConfirm) {
    confirmAction = onConfirm
    const modal = el('div', `${NS}-modal`)
    modal.id = `${NS}-modal`
    const card = el('div', `${NS}-modal-card`)
    card.appendChild(el('div', `${NS}-modal-title`, title))
    card.appendChild(el('div', `${NS}-modal-text`, message))
    const row = el('div', `${NS}-modal-actions`)
    const cancel = el('button', `${NS}-btn ${NS}-btn-ghost`, '取消')
    const ok = el('button', `${NS}-btn ${NS}-btn-danger`, '确认删除')
    cancel.onclick = closeConfirm
    ok.onclick = () => {
      const action = confirmAction
      closeConfirm()
      if (action) action()
    }
    row.appendChild(cancel)
    row.appendChild(ok)
    card.appendChild(row)
    modal.appendChild(card)
    modal.onclick = (event) => {
      if (event.target === modal) closeConfirm()
    }
    document.body.appendChild(modal)
    ok.focus()
  }

  function closeConfirm() {
    confirmAction = null
    const modal = document.getElementById(`${NS}-modal`)
    if (modal !== null) modal.remove()
  }

  function requestDelete(ids, batch) {
    const label = batch ? `确定要删除选中的 ${ids.length} 个归档对话吗？` : `确定要删除对话「${labelOf(ids[0])}」吗？`
    askConfirm(
      '永久删除对话',
      `${label}删除后对话记录将从磁盘中彻底移除，无法恢复。此操作不会影响其他任何对话。`,
      () => runDelete(ids),
    )
  }

  function labelOf(sessionId) {
    const item = items.find((entry) => entry.sessionId === sessionId)
    return item ? item.title : '未命名对话'
  }

  // ---- rendering -----------------------------------------------------------------
  function setBusy(value) {
    const button = document.getElementById(`${NS}-fab`)
    if (button !== null) {
      button.classList.toggle(`${NS}-busy`, value)
      button.disabled = value
    }
    const rows = document.querySelectorAll(`.${NS}-row`)
    for (const row of rows) row.classList.toggle(`${NS}-dim`, value)
  }

  function render() {
    const listEl = document.getElementById(`${NS}-list`)
    const countEl = document.getElementById(`${NS}-count`)
    const batchEl = document.getElementById(`${NS}-batch`)
    if (listEl === null || countEl === null || batchEl === null) return
    countEl.textContent = `共 ${items.length} 个归档对话`

    const allSelected = items.length > 0 && items.every((item) => selected.has(item.sessionId))
    const selectAll = document.getElementById(`${NS}-select-all`)
    if (selectAll !== null) {
      selectAll.checked = allSelected
      selectAll.indeterminate = !allSelected && selected.size > 0
    }

    listEl.textContent = ''
    if (items.length === 0) {
      const empty = el('div', `${NS}-empty`, '暂无归档对话。在工作区会话上点击「归档」后，会显示在这里。')
      listEl.appendChild(empty)
    }

    for (const item of items) {
      const row = el('div', `${NS}-row`)
      row.dataset.sessionId = item.sessionId
      if (selected.has(item.sessionId)) row.classList.add(`${NS}-selected`)

      const check = el('input', `${NS}-check`)
      check.type = 'checkbox'
      check.checked = selected.has(item.sessionId)
      check.onchange = () => {
        if (check.checked) selected.add(item.sessionId)
        else selected.delete(item.sessionId)
        render()
      }

      const body = el('div', `${NS}-row-body`)
      const title = el('div', `${NS}-row-title`, item.title)
      const meta = el('div', `${NS}-row-meta`)
      meta.textContent = `${item.workspaceTitle} · ${fmtTime(item.lastPromptAt || item.createdAt)}`
      body.appendChild(title)
      body.appendChild(meta)
      if (item.running) body.appendChild(el('span', `${NS}-badge`, '运行中'))

      const actions = el('div', `${NS}-row-actions`)
      const restore = el('button', `${NS}-btn ${NS}-btn-soft`, '恢复')
      restore.title = '恢复到原工作区'
      restore.onclick = () => runRestore([item.sessionId])
      const del = el('button', `${NS}-btn ${NS}-btn-soft-danger`, '删除')
      del.title = '从磁盘永久删除'
      del.onclick = () => {
        if (item.running) {
          toast('该对话当前正在运行，请先结束它再删除', 'error')
          return
        }
        requestDelete([item.sessionId], false)
      }
      actions.appendChild(restore)
      actions.appendChild(del)

      row.appendChild(check)
      row.appendChild(body)
      row.appendChild(actions)
      listEl.appendChild(row)
    }

    const restoreAll = document.getElementById(`${NS}-restore-all`)
    const deleteAll = document.getElementById(`${NS}-delete-all`)
    const hasSelection = selected.size > 0
    restoreAll.disabled = !hasSelection || busy
    deleteAll.disabled = !hasSelection || busy
    batchEl.classList.toggle(`${NS}-batch-active`, hasSelection)
  }

  function buildPanel() {
    const root = el('div', `${NS}-root`)
    root.id = `${NS}-root`

    const fab = el('button', `${NS}-fab`)
    fab.id = `${NS}-fab`
    fab.type = 'button'
    fab.setAttribute('aria-label', '恢复归档')
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'
      + '</svg><span>恢复归档</span>'
    fab.onclick = togglePanel

    const panel = el('div', `${NS}-panel`)
    panel.id = `${NS}-panel`

    const header = el('div', `${NS}-header`)
    const title = el('div', `${NS}-title`)
    title.textContent = '归档对话管理'
    const close = el('button', `${NS}-close`, '×')
    close.title = '关闭'
    close.onclick = togglePanel
    header.appendChild(title)
    header.appendChild(close)

    const count = el('div', `${NS}-count`)
    count.id = `${NS}-count`
    header.appendChild(count)

    const batch = el('div', `${NS}-batch`)
    batch.id = `${NS}-batch`
    const selectAllLabel = el('label', `${NS}-select-all-label`)
    const selectAll = el('input', `${NS}-check`)
    selectAll.type = 'checkbox'
    selectAll.id = `${NS}-select-all`
    selectAll.onchange = () => {
      if (selectAll.checked) selected = new Set(items.map((item) => item.sessionId))
      else selected.clear()
      render()
    }
    selectAllLabel.appendChild(selectAll)
    selectAllLabel.appendChild(el('span', null, '全选'))
    const restoreAll = el('button', `${NS}-btn ${NS}-btn-soft`, '批量恢复')
    restoreAll.id = `${NS}-restore-all`
    restoreAll.onclick = () => runRestore([...selected])
    const deleteAll = el('button', `${NS}-btn ${NS}-btn-soft-danger`, '批量删除')
    deleteAll.id = `${NS}-delete-all`
    deleteAll.onclick = () => requestDelete([...selected], true)
    batch.appendChild(selectAllLabel)
    batch.appendChild(el('div', `${NS}-batch-spacer`))
    batch.appendChild(restoreAll)
    batch.appendChild(deleteAll)

    const list = el('div', `${NS}-list`)
    list.id = `${NS}-list`

    const hint = el('div', `${NS}-hint`,
      '恢复：对话回到原来的工作区；删除：从磁盘永久移除对话记录（不影响其他对话）。')

    panel.appendChild(header)
    panel.appendChild(batch)
    panel.appendChild(list)
    panel.appendChild(hint)
    root.appendChild(panel)
    root.appendChild(fab)
    return root
  }

  function togglePanel() {
    const panel = document.getElementById(`${NS}-panel`)
    if (panel === null) return
    const opening = !panel.classList.contains(`${NS}-open`)
    panel.classList.toggle(`${NS}-open`, opening)
    document.getElementById(`${NS}-fab`)?.classList.toggle(`${NS}-fab-active`, opening)
    if (opening) {
      void loadItems()
    }
  }

  // ---- style ------------------------------------------------------------------------
  const STYLE = `
  .${NS}-root { position: fixed; inset: auto 0 0 auto; z-index: 2147483000; pointer-events: none; }
  .${NS}-fab {
    pointer-events: auto;
    position: fixed; right: 26px; bottom: 24px;
    display: flex; align-items: center; gap: 7px;
    height: 42px; padding: 0 18px;
    border-radius: 999px;
    border: 1px solid rgba(127, 216, 245, 0.38);
    background: linear-gradient(145deg, rgba(22, 41, 66, 0.92), rgba(11, 20, 32, 0.94));
    -webkit-backdrop-filter: blur(18px) saturate(140%); backdrop-filter: blur(18px) saturate(140%);
    color: #cfeaff; font: 500 13px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    box-shadow: 0 12px 34px rgba(2, 8, 16, 0.55), inset 0 1px 0 rgba(255,255,255,0.08);
    cursor: pointer; transition: transform .18s ease, box-shadow .18s ease, opacity .18s ease;
  }
  .${NS}-fab:hover { transform: translateY(-2px); box-shadow: 0 16px 40px rgba(2,8,16,.65), 0 0 0 1px rgba(127,216,245,.28), inset 0 1px 0 rgba(255,255,255,.1); }
  .${NS}-fab:active { transform: translateY(0); }
  .${NS}-fab svg { flex: none; }
  .${NS}-fab-active { border-color: rgba(127,216,245,.72); box-shadow: 0 0 0 3px rgba(127,216,245,.14), 0 12px 34px rgba(2,8,16,.6); }
  .${NS}-busy { opacity: .55; pointer-events: none; }
  .${NS}-panel {
    pointer-events: auto;
    position: fixed; right: 26px; bottom: 78px;
    width: min(480px, calc(100vw - 40px)); max-height: min(560px, calc(100vh - 120px));
    display: flex; flex-direction: column;
    border-radius: 18px; overflow: hidden;
    border: 1px solid rgba(127, 216, 245, 0.22);
    background: linear-gradient(165deg, rgba(19, 36, 58, 0.97), rgba(8, 15, 25, 0.98));
    -webkit-backdrop-filter: blur(26px) saturate(150%); backdrop-filter: blur(26px) saturate(150%);
    box-shadow: 0 28px 80px rgba(1, 5, 12, 0.75), inset 0 1px 0 rgba(255,255,255,0.07);
    opacity: 0; transform: translateY(14px) scale(.97); transform-origin: bottom right;
    transition: opacity .22s ease, transform .22s cubic-bezier(.2,.9,.3,1.2); pointer-events: none;
  }
  .${NS}-panel.${NS}-open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
  .${NS}-header { display: flex; align-items: baseline; gap: 10px; padding: 15px 18px 10px; }
  .${NS}-title { font: 700 15px/1.2 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: #e6f4ff; letter-spacing: .2px; }
  .${NS}-count { font: 400 11px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: #7d94ad; }
  .${NS}-close { margin-left: auto; width: 26px; height: 26px; border-radius: 8px; border: 0; background: rgba(127,216,245,.08); color: #9fc3e4; font: 500 17px/1 system-ui; cursor: pointer; }
  .${NS}-close:hover { background: rgba(127,216,245,.18); color: #e6f4ff; }
  .${NS}-batch { display: flex; align-items: center; gap: 8px; padding: 6px 18px 10px; border-bottom: 1px solid rgba(127,216,245,.12); }
  .${NS}-select-all-label { display: flex; align-items: center; gap: 6px; color: #a9c4e0; font: 400 12px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; cursor: pointer; user-select: none; }
  .${NS}-batch-spacer { flex: 1; }
  .${NS}-list { flex: 1; overflow-y: auto; padding: 10px 12px 6px; min-height: 120px; }
  .${NS}-list::-webkit-scrollbar { width: 8px; }
  .${NS}-list::-webkit-scrollbar-thumb { background: rgba(127,216,245,.18); border-radius: 8px; }
  .${NS}-empty { padding: 42px 0; text-align: center; color: #6f86a0; font: 400 13px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  .${NS}-row { display: flex; align-items: center; gap: 10px; padding: 10px 10px; border-radius: 12px; margin-bottom: 6px; border: 1px solid transparent; background: rgba(20, 38, 60, 0.5); transition: background .15s ease, border-color .15s ease; }
  .${NS}-row:hover { background: rgba(27, 50, 79, 0.72); }
  .${NS}-row.${NS}-selected { border-color: rgba(127,216,245,.36); background: rgba(26, 52, 82, 0.78); }
  .${NS}-row.${NS}-dim { opacity: .55; }
  .${NS}-check { width: 15px; height: 15px; accent-color: #4a9fe0; flex: none; cursor: pointer; }
  .${NS}-row-body { flex: 1; min-width: 0; }
  .${NS}-row-title { color: #e2effb; font: 500 13px/1.35 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .${NS}-row-meta { color: #7990a9; font: 400 11px/1.4 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; margin-top: 2px; }
  .${NS}-badge { display: inline-block; margin-top: 5px; padding: 2px 8px; border-radius: 999px; background: rgba(90, 202, 148, 0.16); color: #6fdcac; font: 500 10px/1.4 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  .${NS}-row-actions { display: flex; gap: 6px; flex: none; }
  .${NS}-btn {
    height: 28px; padding: 0 12px; border-radius: 9px; border: 1px solid transparent;
    font: 500 12px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; cursor: pointer;
    transition: filter .15s ease, transform .1s ease, opacity .15s ease; white-space: nowrap;
  }
  .${NS}-btn:disabled { opacity: .4; cursor: not-allowed; }
  .${NS}-btn:not(:disabled):active { transform: translateY(1px); }
  .${NS}-btn-soft { background: rgba(74, 159, 224, 0.16); color: #8fd0ff; border-color: rgba(127,216,245,.26); }
  .${NS}-btn-soft:hover:not(:disabled) { background: rgba(74, 159, 224, 0.28); color: #c7e8ff; }
  .${NS}-btn-soft-danger { background: rgba(226, 84, 84, 0.14); color: #ff9d9d; border-color: rgba(255, 120, 120, 0.26); }
  .${NS}-btn-soft-danger:hover:not(:disabled) { background: rgba(226, 84, 84, 0.26); color: #ffc2c2; }
  .${NS}-btn-ghost { background: rgba(127,216,245,.1); color: #bcd8f2; }
  .${NS}-btn-danger { background: linear-gradient(145deg, #d25454, #a83232); color: #fff; box-shadow: 0 6px 18px rgba(168,50,50,.35); }
  .${NS}-hint { padding: 8px 18px 12px; color: #6f86a0; font: 400 11px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; border-top: 1px solid rgba(127,216,245,.1); }
  .${NS}-modal { position: fixed; inset: 0; z-index: 2147483010; display: flex; align-items: center; justify-content: center; background: rgba(2, 6, 12, 0.55); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
  .${NS}-modal-card { width: min(380px, calc(100vw - 48px)); border-radius: 16px; padding: 20px 22px; border: 1px solid rgba(255,140,140,.26); background: linear-gradient(165deg, rgba(34, 30, 48, 0.98), rgba(14, 12, 22, 0.98)); box-shadow: 0 24px 70px rgba(0,0,0,.7); }
  .${NS}-modal-title { color: #ffd3d3; font: 700 15px/1.3 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; margin-bottom: 8px; }
  .${NS}-modal-text { color: #b9adc2; font: 400 12.5px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; margin-bottom: 18px; }
  .${NS}-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .${NS}-toast {
    position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%);
    z-index: 2147483020; max-width: min(520px, calc(100vw - 40px));
    padding: 11px 20px; border-radius: 999px; border: 1px solid rgba(127,216,245,.3);
    background: linear-gradient(145deg, rgba(22,41,66,.96), rgba(10,18,30,.97));
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    color: #dceeff; font: 500 13px/1.3 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    box-shadow: 0 14px 40px rgba(1,5,12,.6); transition: opacity .35s ease, transform .35s ease;
  }
  .${NS}-toast-ok { border-color: rgba(111,220,172,.4); color: #d9f7e8; }
  .${NS}-toast-error { border-color: rgba(255,140,140,.4); color: #ffdada; }
  .${NS}-toast-hide { opacity: 0; transform: translateX(-50%) translateY(8px); }
  @media (max-width: 640px) { .${NS}-fab { right: 14px; bottom: 14px; } .${NS}-panel { right: 14px; bottom: 66px; } }

  /* ---- Aqua glass integration -------------------------------------------
     When the built-in Aqua plugin is active (html[data-dsh-aqua]), the
     archive manager consumes the plugin's live glass recipe: the frosted
     fill rides --dsh-aqua-glass-card-light/dark, the blur rides
     --dsh-aqua-blur, and hover/selection glows use --dsh-aqua-spot-color.
     Adjusting 模糊度/磨砂度 in 设置 → 通用设置 → 外观 changes this panel
     too. Fallbacks keep the panel usable even if the plugin is off. */
  html[data-dsh-aqua] .${NS}-fab,
  html[data-dsh-aqua] .${NS}-panel,
  html[data-dsh-aqua] .${NS}-toast,
  html[data-dsh-aqua] .${NS}-modal-card {
    background: color-mix(in srgb, #ffffff calc(62% * var(--dsh-aqua-surface-frost, 1.2)), transparent);
    -webkit-backdrop-filter: blur(var(--dsh-aqua-blur, 20px)) saturate(150%);
    backdrop-filter: blur(var(--dsh-aqua-blur, 20px)) saturate(150%);
    border-color: rgba(19, 45, 83, 0.26);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.55), 0 12px 36px rgba(19, 45, 83, 0.18);
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-fab,
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-panel,
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-toast,
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-modal-card {
    background: color-mix(in srgb, #232a36 calc(64% * var(--dsh-aqua-surface-frost, 1.2)), transparent);
    border-color: rgba(148, 180, 220, 0.32);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.08), 0 12px 36px rgba(2, 6, 14, 0.5);
  }
  html[data-dsh-aqua] .${NS}-row {
    background: color-mix(in srgb, #ffffff calc(30% * var(--dsh-aqua-frost, 1)), transparent);
    border-color: rgba(19, 45, 83, 0.14);
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-row {
    background: color-mix(in srgb, #232a36 calc(32% * var(--dsh-aqua-frost, 1)), transparent);
    border-color: rgba(148, 180, 220, 0.16);
  }
  html[data-dsh-aqua] .${NS}-row:hover {
    background: color-mix(in srgb, #ffffff calc(42% * var(--dsh-aqua-frost, 1)), transparent);
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-row:hover {
    background: color-mix(in srgb, #2c3442 calc(44% * var(--dsh-aqua-frost, 1)), transparent);
  }
  html[data-dsh-aqua] .${NS}-row.${NS}-selected {
    border-color: color-mix(in srgb, #6e9be8 72%, transparent);
    box-shadow: 0 0 16px var(--dsh-aqua-spot-color, rgba(110, 155, 232, 0.18));
  }
  html[data-dsh-aqua] .${NS}-fab:hover {
    background: color-mix(in srgb, #ffffff calc(76% * var(--dsh-aqua-surface-frost, 1.2)), transparent);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.6), 0 0 0 1px color-mix(in srgb, #6e9be8 55%, transparent), 0 16px 42px rgba(19, 45, 83, 0.22);
  }
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-fab:hover {
    background: color-mix(in srgb, #2f3846 calc(76% * var(--dsh-aqua-surface-frost, 1.2)), transparent);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.1), 0 0 0 1px rgba(148, 180, 220, 0.5), 0 16px 42px rgba(2, 6, 14, 0.6);
  }
  html[data-dsh-aqua] body:not([data-ds-dark-theme]) .${NS}-fab,
  html[data-dsh-aqua] body:not([data-ds-dark-theme]) .${NS}-title,
  html[data-dsh-aqua] body:not([data-ds-dark-theme]) .${NS}-row-title,
  html[data-dsh-aqua] body:not([data-ds-dark-theme]) .${NS}-toast { color: #1d3556; }
  html[data-dsh-aqua] body:not([data-ds-dark-theme]) .${NS}-count,
  html[data-dsh-aqua] body:not([data-ds-dark-theme]) .${NS}-row-meta,
  html[data-dsh-aqua] body:not([data-ds-dark-theme]) .${NS}-hint,
  html[data-dsh-aqua] body:not([data-ds-dark-theme]) .${NS}-select-all-label { color: #5d7696; }
  html[data-dsh-aqua] .${NS}-close { background: rgba(110, 155, 232, 0.14); }
  html[data-dsh-aqua] body:not([data-ds-dark-theme]) .${NS}-close { color: #2d4a70; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-close { color: #9fc3e4; }
  html[data-dsh-aqua] .${NS}-btn-soft { color: #4a80c8; border-color: rgba(110, 155, 232, 0.3); }
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-btn-soft { color: #8fd0ff; }
  html[data-dsh-aqua] .${NS}-btn-soft:hover:not(:disabled) { color: #2b5b9a; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-btn-soft:hover:not(:disabled) { color: #c7e8ff; }
  html[data-dsh-aqua] .${NS}-btn-soft-danger { color: #c44545; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-btn-soft-danger { color: #ff9d9d; }
  html[data-dsh-aqua] body[data-ds-dark-theme] .${NS}-modal-card { background: color-mix(in srgb, #241f31 calc(72% * var(--dsh-aqua-surface-frost, 1.2)), transparent); }
  `
  const styleEl = el('style')
  styleEl.id = `${NS}-style`
  styleEl.textContent = STYLE
  document.head.appendChild(styleEl)
  document.body.appendChild(buildPanel())
})()

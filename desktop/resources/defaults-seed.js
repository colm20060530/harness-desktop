/**
 * Harness Desktop — 首次启动默认配置种子（渲染进程侧）。
 *
 * 打开应用的默认观感是「深色 + 内置云朵兽耳视频壁纸」：
 *   玻璃模糊 16、磨砂 13、视频模糊 6、视频亮度 20、背景=视频壁纸。
 *
 * 流程（每个用户目录按版本标记只执行一次）：
 *   1. 从内置服务端接口拉取捆绑视频，写入 Aqua 插件的 IndexedDB 存储
 *      （键 default-video，插件通过 idb: 标记自动加载，重启不丢）；
 *   2. 把上述数值写入插件设置（localStorage）；
 *   3. 通过官方 settings.update 接口把主题偏好设为深色；
 *   3.5 清理 v4 旧版误种的 GLM 聊天供应商（见下）；
 *   4. 打上完成标记并刷新一次页面，让插件以新配置挂载。
 */
(function seedDefaults() {
  'use strict'

  const MARK = 'hd.defaults.v5'
  const BLOB_KEY = 'default-video'
  const DB_NAME = 'dsh-aqua-media'
  const STORE = 'wallpaper'

  try {
    if (localStorage.getItem(MARK) === '1') return
  } catch {
    return
  }

  ;(async () => {
    try {
      // 1. 拉取捆绑视频并写入 IndexedDB（插件壁纸存储）。
      const response = await fetch('/api/desktop-assets.wallpaper', { cache: 'no-store' })
      if (!response.ok) throw new Error(`wallpaper asset fetch failed: HTTP ${response.status}`)
      const blob = await response.blob()
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(blob, BLOB_KEY)
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })

      // 2. Aqua 默认参数。
      localStorage.setItem('dsh.ui-aqua.blur', '16')
      localStorage.setItem('dsh.ui-aqua.frost', '13')
      localStorage.setItem('dsh.ui-aqua.videoBlur', '6')
      localStorage.setItem('dsh.ui-aqua.videoBrightness', '20')
      localStorage.setItem('dsh.ui-aqua.background', 'wallpaper')
      localStorage.setItem('dsh.ui-aqua.wallpaper', 'idb:default-video')

      // 3. 主题偏好 → 深色（官方 settings.update 接口，持久化到设置文档）。
      const envelope = {
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'settings.update',
        payload: { ns: 'ui-theme', patch: { preference: 'dark' } },
      }
      await fetch('/api/settings.update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      }).catch(() => null)

      // 3.5 清理旧版（v4）误种的 GLM 聊天供应商。v4 曾把 7 个 GLM 模型
      //     写进 llm-pi-ai.providers.zhipu,会让人误以为应用内置了可用的
      //     GLM 聊天模型。GLM Key 现在只通过 设置 → 模型 的识图卡片配置,
      //     写入内置 ds-vision-skill,不会再出现在模型列表中。
      //     仅当供应商与 v4 种子完全一致时删除,用户自己配置的 GLM
      //     供应商（哪怕是同名 zhipu）不会受影响。
      try {
        const describeData = await fetch('/api/settings.describe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: crypto.randomUUID(),
            method: 'settings.describe',
            payload: {},
          }),
        }).then((res) => res.json()).catch(() => null)
        const llm = describeData?.result?.value?.namespaces
          ?.find((ns) => ns?.ns === 'llm-pi-ai')
        const zhipu = llm?.value?.providers?.zhipu
        const seededModelIds = [
          'glm-5', 'glm-5-turbo', 'glm-5.1', 'glm-5.2', 'glm-5.3',
          'glm-4.6v-flash', 'glm-4.7-flash',
        ]
        const matchesSeed = zhipu !== undefined
          && zhipu.displayName === 'GLM'
          && zhipu.apiKeyEnv === 'ZHIPU_API_KEY'
          && zhipu.baseURL === 'https://open.bigmodel.cn/api/paas/v4'
          && Array.isArray(zhipu.models)
          && seededModelIds.length === zhipu.models.length
          && seededModelIds.every((id) => zhipu.models.some((m) => m && m.id === id))
        if (matchesSeed) {
          await fetch('/api/settings.mutate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: crypto.randomUUID(),
              method: 'settings.mutate',
              payload: {
                ns: 'llm-pi-ai',
                ops: [{ op: 'unset', path: ['providers', 'zhipu'] }],
              },
            }),
          }).catch(() => null)
        }
      } catch {
        // 清理失败不阻塞其余初始化,下次启动会重试。
      }

      // 4. 完成标记 + 刷新，让插件以新配置挂载。
      localStorage.setItem(MARK, '1')
      window.location.reload()
    } catch (error) {
      console.error('[harness-desktop] defaults seed failed:', error)
    }
  })()
})()

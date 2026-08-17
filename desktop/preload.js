'use strict'

const { contextBridge } = require('electron')

// Minimal, sandboxed bridge. The web UI runs with nodeIntegration off and
// contextIsolation on; this only exposes read-only platform facts.
contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
})

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('watchdesk', {
  meta: () => ipcRenderer.invoke('companion:meta'),
  openDownload: () => ipcRenderer.invoke('companion:open-download'),
  listSources: () => ipcRenderer.invoke('companion:list-sources'),
  env: () => ipcRenderer.invoke('companion:env'),
  hostLogin: (opts) => ipcRenderer.invoke('companion:host-login', opts),
  sessionCookie: () => ipcRenderer.invoke('companion:session-cookie'),
  sendInput: (ev) => ipcRenderer.send('companion:input', ev),
});

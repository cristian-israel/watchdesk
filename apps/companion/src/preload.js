'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('watchdesk', {
  meta: () => ipcRenderer.invoke('companion:meta'),
  openDownload: () => ipcRenderer.invoke('companion:open-download'),
  listSources: () => ipcRenderer.invoke('companion:list-sources'),
  settingsGet: () => ipcRenderer.invoke('companion:settings-get'),
  settingsSave: (partial) => ipcRenderer.invoke('companion:settings-save', partial),
  fetchMe: (opts) => ipcRenderer.invoke('companion:fetch-me', opts),
  createRoom: (opts) => ipcRenderer.invoke('companion:create-room', opts),
  deleteRoom: (opts) => ipcRenderer.invoke('companion:delete-room', opts),
  hostLogin: (opts) => ipcRenderer.invoke('companion:host-login', opts),
  patchRoom: (opts) => ipcRenderer.invoke('companion:patch-room', opts),
  sessionCookie: () => ipcRenderer.invoke('companion:session-cookie'),
  viewerLink: (opts) => ipcRenderer.invoke('companion:viewer-link', opts),
  clipboard: (text) => ipcRenderer.invoke('companion:clipboard', text),
  openExternal: (url) => ipcRenderer.invoke('companion:open-external', url),
  sendInput: (ev) => ipcRenderer.send('companion:input', ev),
  onDeepLink: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('companion:deep-link', handler);
    return () => ipcRenderer.removeListener('companion:deep-link', handler);
  },
});

const { contextBridge, ipcRenderer } = require('electron');
const channels = new Set(['load', 'state', 'choose', 'start', 'decide', 'undo', 'revise', 'confirm', 'discard', 'restore', 'show-folder']);
contextBridge.exposeInMainWorld('twenty', {
  invoke: (channel, ...args) => { if (!channels.has(channel)) throw new Error('Unknown action'); return ipcRenderer.invoke(channel, ...args); },
  onProgress: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('progress', listener); return () => ipcRenderer.removeListener('progress', listener); }
});

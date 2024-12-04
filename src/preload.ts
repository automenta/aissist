const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onStatusUpdate: (callback:Function) => ipcRenderer.on('status-update', (event, status) => callback(status)),
    onDataUpdate: (callback:Function) => ipcRenderer.on('data-update', (event, data) => callback(data))
});

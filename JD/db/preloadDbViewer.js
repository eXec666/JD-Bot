const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getTableData: () => ipcRenderer.invoke('get-table-data'),
  refreshDatabase: () => ipcRenderer.invoke('refresh-database'),
  onForceRefresh: (callback) => {
    ipcRenderer.on('force-refresh', callback);
  }
});
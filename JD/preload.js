const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    initDb: () => ipcRenderer.invoke('init-db'),
    wipeDb: () => ipcRenderer.invoke('wipe-db'),
    selectExcelFile: () => ipcRenderer.invoke('select-excel-file'),
    queryPart: (partNumber) => ipcRenderer.invoke('query-part', partNumber),
    queryPartSuggestions: (query) => ipcRenderer.invoke('query-part-suggestions', query),
    getNodeDetails: (partNumber, vehicleId) => ipcRenderer.invoke('get-node-details', partNumber, vehicleId),
    scrapeVehicles: (filePath) => ipcRenderer.invoke('scrape-vehicles', filePath),
    scrapeNodes: () => ipcRenderer.invoke('scrape-nodes'),
    openDbViewer: () => ipcRenderer.send('open-db-viewer'),
    getTableData: (table) => ipcRenderer.invoke('get-table-data', table),
    downloadCsv: () => ipcRenderer.invoke('download-csv'),
    openFolder: (path) => ipcRenderer.invoke('open-folder', path),
    onProgress: (callback) => {
        ipcRenderer.on('progress-update', (event, percent, message) => callback(percent, message));
    },
    onLog: (callback) => {
        ipcRenderer.on('log-message', (_, payload) => callback(payload));
    }
});
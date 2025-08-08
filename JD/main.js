#!/usr/bin/env node
console.log('MAIN PROCESS STARTED');
debugger;
process.env.DEBUG = '0';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('better-sqlite3');
const { queryVehiclesForPart, queryPartSuggestions } = require('./scraper/compat_query.js');
const { DB_PATH } = require('./db/db_config.js');
const { wipeDatabase, runWithProgress } = require('./scraper/vehicle_scraper.js'); // Renamed back to runWithProgress for simplicity
const { getTableData } = require('./db/db_utils.js');
const { runWithProgress: runNodeScraper } = require('./scraper/node_scraper');
const dbManager = require('./db/db_manager');


// Create the main application window
function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      devTools: true,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools();
  }

  win.loadFile('./renderer/index.html');
}

app.whenReady().then(createWindow);

// Listen for the 'scrape-vehicles' event from the renderer process
ipcMain.handle('scrape-vehicles', async (event, filePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  console.log('⚡ Scrape-vehicles IPC called');
  console.log('Starting vehicle scraping...');

  const progressCallback = (percent, message) => {
    console.log(`⏳ Vehicle Progress: ${percent}% - ${message}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send(
        'progress-update',
        percent,
        message,
      );
    }
  };
  
  const onForceRefresh = () => {
    win.webContents.send('force-refresh');
  };

  try {
    // Corrected call: pass filePath first, then the progress callback
    const result = await runWithProgress(filePath, onForceRefresh, progressCallback);
    if (result.error) throw new Error(result.error);
    return { message: 'Vehicle scrape completed!', results: result.results };
  } catch (err) {
    console.error(`💥 Vehicle scrape failed: ${err.message}`);
    return { error: err.message };
  }
});


// Other handlers (like 'wipe-db', 'select-excel-file', etc.) would go here.
ipcMain.handle('wipe-db', async () => {
    try {
        const result = wipeDatabase();
        if (result.success) {
            return { message: result.message };
        } else {
            return { error: result.message };
        }
    } catch (err) {
        return { error: err.message };
    }
});


// ... (rest of your IPC handlers) ...
ipcMain.handle('select-excel-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Excel Files', extensions: ['xlsx', 'xls'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (canceled || !filePaths?.length) {
    return null;
  }
  return filePaths[0];
});

ipcMain.handle('query-part', async (event, partNumber) => {
  try {
    const result = await queryVehiclesForPart(partNumber);
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('query-part-suggestions', async (event, query) => {
  try {
    const result = await queryPartSuggestions(query);
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-node-details', async (_, partNumber, vehicleId) => {
    try {
        const vehicle = dbManager.query(
            `SELECT vehicle_name FROM vehicles WHERE vehicle_id = ?`,
            [vehicleId]
        )[0];
        
        const nodes = dbManager.query(`
            SELECT n.node_desc
            FROM part_vehicle_nodes pvn
            JOIN nodes n ON pvn.node_id = n.node_id
            JOIN parts p ON pvn.part_id = p.part_id
            WHERE p.part_number = ? AND pvn.vehicle_id = ?
        `, [partNumber, vehicleId]);
        
        return { 
            vehicleName: vehicle.vehicle_name,
            nodes: nodes.map(row => row.node_desc)
        };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('get-table-data', async (event, table) => {
    try {
        const result = getTableData(table);
        return { success: true, data: result };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('scrape-nodes', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  console.log('Starting node scraping...');

  const progressCallback = (percent, message) => {
    console.log(`Node Progress: ${percent}% - ${message}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send(
        'progress-update',
        percent,
        message,
      );
    }
  };

  try {
    const result = await runNodeScraper(progressCallback);
    if (result.error) throw new Error(result.error);
    return { message: 'Node scraping completed!', totalNodesSaved: result.totalNodesSaved };
  } catch (err) {
    console.error(`Node scrape failed: ${err.message}`);
    return { error: err.message };
  }
});

ipcMain.on('open-db-viewer', () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'db', 'preloadDbViewer.js')
    }
  });

  win.loadFile(path.join(__dirname, 'db', 'dbViewer.html'));
});

ipcMain.handle('download-csv', async () => {
  const db = dbManager.connect();
  const filePath = path.join(os.homedir(), 'Desktop', 'scraped_data.csv');
  const csvData = [];
  try {
      const parts = db.prepare('SELECT part_number FROM parts').all();
      for (const part of parts) {
          const vehicles = db.prepare(`
              SELECT v.vehicle_name
              FROM compatibility c
              JOIN vehicles v ON c.vehicle_id = v.vehicle_id
              JOIN parts p ON c.part_id = p.part_id
              WHERE p.part_number = ?
          `).all(part.part_number);
          csvData.push([part.part_number, vehicles.map(v => v.vehicle_name).join(', ')]);
      }
      const csvString = csvData.map(e => e.join(",")).join("\n");
      fs.writeFileSync(filePath, 'Part Number,Compatible Vehicles\n' + csvString);
      return { success: true, filePath: filePath };
  } catch (err) {
      console.error('Error downloading CSV:', err);
      return { success: false, error: err.message };
  } finally {
      dbManager.disconnect();
  }
});

ipcMain.handle('open-folder', async (event, folderPath) => {
  try {
    shell.openPath(folderPath);
    return { success: true };
  } catch (err) {
    console.error('Error opening folder:', err);
    return { success: false, error: err.message };
  }
});
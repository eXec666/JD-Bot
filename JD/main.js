#!/usr/bin/env node
console.log('MAIN PROCESS STARTED');
debugger;
process.env.DEBUG = '0';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const originalLog = console.log;
const originalErr = console.error;
const path = require('path');
const fs = require('fs');
const { runWithProgress } = require('./scraper/node_scraper');
const dataEntry = require('./db/data_entry_point.js');
const vehicleScraper = require('./scraper/vehicle_scraper');
const { data } = require('node-persist');

// Log forwarding logic
function broadcastLog(level, ...args) {
  originalLog.apply(console, args);
  const msg = args.map(a => String(a)).join(' ');
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send('log-message', { level, msg, ts: new Date().toISOString() });
  });
}
console.log = (...args) => broadcastLog('log', ...args);
console.error = (...args) => broadcastLog('error', ...args);

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

  // Listen for dump progress from the unified DB entry point
  dataEntry.onDumpProgress((payload) => {
    console.log('[MAIN] forwarding ui:db-dump-progress', payload);
    if (win && !win.isDestroyed()) {
      win.webContents.send('ui:db-dump-progress', payload);
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // win.webContents.openDevTools();
}

app.whenReady().then(createWindow);

// Refresh database handler
ipcMain.handle('refresh-database', async () => {
  return { status: 'refreshed' };
});

// Generic table dump (debug/inspection)
ipcMain.handle('get-table-data', async () => {
  try {
    const tables = dataEntry.query(`SELECT name FROM sqlite_master WHERE type='table'`);
    const data = {};
    for (const t of tables) {
      data[t.name] = dataEntry.query(`SELECT * FROM ${t.name}`);
    }
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Database wipe handler
ipcMain.handle('wipe-db', async () => {
  const result = await dataEntry.wipeDatabase();
  return result;
});

// Part query handler
ipcMain.handle('query-part', async (event, partNumber) => {
  try {
    const result = await dataEntry.queryVehiclesForPart(partNumber);
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

// If you use this elsewhere, make sure it's defined/imported.
// Keeping as-is per your existing code.
ipcMain.handle('query-part-suggestions', async (event, query) => {
  try {
    const result = await queryPartSuggestions(query);
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

// Input file handler
ipcMain.handle('select-excel-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Excel Files', extensions: ['xlsx', 'xls'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (canceled || !filePaths?.length) return null;
  return filePaths[0];  // absolute path
});


//csv export handler
ipcMain.handle('download-csv', async () => {
  const result = await dataEntry.generateCsvFiles();
  return result; 
});


//folder handler
ipcMain.handle('open-folder', async (_evt, folderPath) => {
  if (!folderPath) return { success: false, error: 'No folder path provided' };
  const outcome = await shell.openPath(folderPath);
  // openPath returns '' on success, or an error string on failure
  if (outcome) return { success: false, error: outcome };
  return { success: true };
});


// Vehicle scraper
ipcMain.handle('scrape-vehicles', async (event, inputFilePath) => {
  console.log('⚡️ scrape-vehicles IPC called');
  try {
    let win = BrowserWindow.getFocusedWindow();
    if (!win) {
      const windows = BrowserWindow.getAllWindows();
      win = windows.find(w => w.isVisible()) || windows[0];
    }

    console.log('🔌 Starting vehicle scraping...');
    const result = await vehicleScraper.runWithProgress(
      (percent, message) => {
        console.log(`📦 Progress: ${percent}% - ${message}`);
        if (win && !win.isDestroyed()) {
          win.webContents.send('progress-update', percent, message);
        }
      },
      () => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('force-refresh');
        }
      },
      inputFilePath
    );

    console.log(' Vehicle scrape completed:', result);
    if (win && !win.isDestroyed()) {
      win.webContents.send('scrape-complete', result);
    }
    return result;
  } catch (err) {
    console.error(' Vehicle scrape failed:', err);
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('scrape-error', {
        error: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      });
    }
    return { error: err.message };
  }
});

// Nodes scraper
ipcMain.handle('scrape-nodes', async () => {
  console.log('scrape-nodes IPC called');

  try {
    let win = BrowserWindow.getFocusedWindow();
    if (!win) {
      const windows = BrowserWindow.getAllWindows();
      win = windows.find(w => w.isVisible()) || windows[0];
    }
    if (!win) throw new Error('No browser window available for progress updates');

    console.log('🔌 Loading scraper module...');
    const { runWithProgress } = require('./scraper/node_scraper');

    // Verify database connection via unified entry point
    try {
      const testQuery = dataEntry.query(`SELECT 1 AS test`);

      console.log('Database connection test:', testQuery);
    } catch (dbErr) {
      console.error('Database connection failed:', dbErr);
      throw new Error(`Database connection failed: ${dbErr.message}`);
    }

    console.log('Starting scrape process...');
    const result = await runWithProgress((percent, message) => {
      try {
        console.log(`Progress: ${percent}% - ${message}`);
        if (win && !win.isDestroyed()) {
          win.webContents.send('progress-update', percent, message);
        }
      } catch (progressErr) {
        console.error('Progress callback failed:', progressErr);
      }
    });

    console.log('Scrape completed:', {
      success: result.results?.filter(r => r.nodePath).length || 0,
      errors: result.results?.filter(r => r.error).length || 0
    });

    if (win && !win.isDestroyed()) {
      win.webContents.send('scrape-complete', result);
    }
    return result;
  } catch (err) {
    console.error(' Scrape failed:', err);
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('scrape-error', {
        error: err.message,
        stack: err.stack
      });
    }
    return {
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    };
  }
});

// Query node details handler
ipcMain.handle('get-node-details', async (_, partNumber, vehicleId) => {
  try {
    const vehicle = dataEntry.query(
      `SELECT vehicle_name FROM vehicles WHERE vehicle_id = ?`,
      [vehicleId]
    )[0];

    const nodes = dataEntry.query(`
      SELECT n.node_desc
      FROM part_vehicle_nodes pvn
      JOIN nodes n ON pvn.node_id = n.node_id
      JOIN parts p ON pvn.part_id = p.part_id
      WHERE p.part_number = ? AND pvn.vehicle_id = ?
    `, [partNumber, vehicleId]);

    return {
      vehicleName: vehicle?.vehicle_name || 'Unknown Vehicle',
      nodes: nodes.map(row => row.node_desc)
    };
  } catch (error) {
    return { error: error.message };
  }
});

// Open DB Viewer window handler
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

// When all windows are closed, close the app / DB
app.on('window-all-closed', () => {
  try {
    dataEntry.disconnect(); // unified DB close
  } catch (e) {
    console.warn('DB disconnect warning:', e?.message || e);
  }
  if (process.platform !== 'darwin') app.quit();
});

// Force-quit if backend hangs
process.on('SIGTERM', () => {
  try { dataEntry.disconnect(); } catch {}
  app.quit();
});

#!/usr/bin/env node
console.log('MAIN PROCESS STARTED');
debugger;
process.env.DEBUG = '0';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('better-sqlite3');
const { queryVehiclesForPart } = require('./scraper/compat_query.js');
const { DB_PATH } = require('./db/db_config.js');
const { wipeDatabase } = require('./scraper/vehicle_scraper.js');
const { getTableData } = require('./db/db_utils.js');
const { runWithProgress } = require('./scraper/node_scraper');
const dbManager = require('./db/db_manager');
const vehicleScraper = require('./scraper/vehicle_scraper');


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

// Refresh database handler
ipcMain.handle('refresh-database', async () => {
  // This forces the database to be re-read
  return { status: 'refreshed' };
});

// Add this with your other IPC handlers in main.js
ipcMain.handle('get-table-data', async () => {
    try {
        const tables = dbManager.getTables();
        const data = {};
        for (const table of tables) {
            data[table.name] = dbManager.getTableData(table.name);
        }
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Database wipe handler
ipcMain.handle('wipe-db', async () => {
  return await wipeDatabase();
});

// Part query handler
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

  return filePaths[0];  // ✅ returns full absolute path
});

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
        console.log(`📦 Vehicle Progress: ${percent}% - ${message}`);
        if (win && !win.isDestroyed()) {
          win.webContents.send('scrape-progress', {
            percent, 
            message,
            timestamp: new Date().toISOString() 
          });
        }
      },
      () => {
        // Force refresh callback
        if (win && !win.isDestroyed()) {
          win.webContents.send('force-refresh');
        }
      },
      inputFilePath
    );

    console.log('✅ Vehicle scrape completed:', result);
    if (win && !win.isDestroyed()) {
      win.webContents.send('scrape-complete', result);
    }

    return result;
  } catch (err) {
    console.error('❌ Vehicle scrape failed:', err);
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

// Scraper progress handler
ipcMain.handle('scrape-nodes', async (event) => {
  console.log('⚡️ scrape-nodes IPC called');
  
  try {
    // Get all windows and find a visible one if none is focused
    let win = BrowserWindow.getFocusedWindow();
    if (!win) {
      const windows = BrowserWindow.getAllWindows();
      win = windows.find(w => w.isVisible()) || windows[0];
    }

    if (!win) {
      throw new Error('No browser window available for progress updates');
    }

    console.log('🔌 Loading scraper module...');
    const { runWithProgress } = require('./scraper/node_scraper');
    
    // Verify database connection
    try {
      const testQuery = await dbManager.query('SELECT 1 as test');
      console.log('✅ Database connection test:', testQuery);
    } catch (dbErr) {
      console.error('❌ Database connection failed:', dbErr);
      throw new Error(`Database connection failed: ${dbErr.message}`);
    }

    console.log('🏁 Starting scrape process...');
    const result = await runWithProgress((percent, message) => {
      try {
        console.log(`📦 Progress: ${percent}% - ${message}`);
        if (win && !win.isDestroyed()) {
          win.webContents.send('scrape-progress', { 
            percent, 
            message,
            timestamp: new Date().toISOString() 
          });
        }
      } catch (progressErr) {
        console.error('⚠️ Progress callback failed:', progressErr);
      }
    });

    console.log('✅ Scrape completed:', {
      success: result.results?.filter(r => r.nodePath).length || 0,
      errors: result.results?.filter(r => r.error).length || 0
    });

    // Send final completion message
    if (win && !win.isDestroyed()) {
      win.webContents.send('scrape-complete', result);
    }

    return result;
  } catch (err) {
    console.error('❌ Scrape failed:', err);
    
    // Try to send error to renderer if window exists
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

// Open DB Viewer window handler
ipcMain.on('open-db-viewer', () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'db', 'preloadDbViewer.js') // Path to subdirectory
    }
  });

  win.loadFile(path.join(__dirname, 'db', 'dbViewer.html')); // Path to subdirectory
});

// When all windows are closed, close the app
app.on('window-all-closed', () => {
  if (dbManager.db) {
    dbManager.closeConnection(); // Ensure better-sqlite3 is closed
  }
});

// Force-quit if backend hangs
process.on('SIGTERM', () => {
  app.quit();
});

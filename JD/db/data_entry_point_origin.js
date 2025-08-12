// db/data_entry_point.js
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');
const path = require('path');
const { DB_PATH } = require('./db_config');
const initDb = require('../scraper/init_db');  
const fs = require('fs');
const { app } = require('electron');

let activeWriters = 0;         
let writeGateOpen = true;       
let isWiping = false; 

// adjust filename if needed
let dbInstance = null;
const bus = new EventEmitter();

//helper functions
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForIdle(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (activeWriters > 0 && Date.now() < deadline) {
    await sleep(50);
  }
  return activeWriters === 0;
}

const MAX_ROWS_PER_FILE = 5000;

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return (str.includes(',') || str.includes('"') || str.includes('\n'))
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

// Safely delete file with retry for EBUSY/EPERM on Windows
async function retryDelete(filePath, tries = 15, delayMs = 200) {
  const fs = require('fs');
  for (let i = 0; i < tries; i++) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && i < tries - 1) {
        await sleep(delayMs);
        continue;
      }
      if (err.code === 'ENOENT') return true;
      throw err;
    }
  }
  return false;
}


/**
 * Connect to SQLite and configure PRAGMAs
 */
function connect() {
    if (dbInstance && dbInstance.open) {
        return dbInstance;
    }
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    return dbInstance;
}

/**
 * Close DB connection
 */
function disconnect() {
    if (dbInstance && dbInstance.open) {
        dbInstance.close();
        dbInstance = null;
    }
}

function query(sql, params = []) {
  const db = connect();
  const stmt = db.prepare(sql);
  return Array.isArray(params) && params.length ? stmt.all(params) : stmt.all();
}

function queryVehiclesForPart(partNumber) {
    let db;
    try {
        db = new Database(DB_PATH, { readonly: true });
        const sql = `
            SELECT v.vehicle_id, v.vehicle_name, COUNT(*) AS cnt
            FROM compatibility c
            JOIN parts p ON c.part_id = p.part_id
            JOIN vehicles v ON c.vehicle_id = v.vehicle_id
            WHERE p.part_number = ?
            GROUP BY v.vehicle_id
            ORDER BY cnt DESC;
        `;
        const stmt = db.prepare(sql);
        const rows = stmt.all(partNumber);
        return { totalUnique: rows.length, rows };
    } catch (err) {
        console.error('[ENTRY] queryVehiclesForPart failed:', err);
        return { totalUnique: 0, rows: [], error: err.message };
    } finally {
        if (db) db.close();
    }
}


async function wipeDatabase() {
  if (isWiping) return { success: false, error: 'Wipe already in progress.' };
  isWiping = true;
  console.log(`[${nowIso()}] [ENTRY] Wiping database...`);

  try {
    // 1) Close the gate so no new writers can start
    writeGateOpen = false;

    // 2) Wait for in-flight writers to finish (up to 8s)
    const wentIdle = await waitForIdle(8000);
    if (!wentIdle) {
      console.warn(`[${nowIso()}] [ENTRY] Wipe proceeding after idle timeout; force-closing DB handle.`);
    }

    // 3) Checkpoint WAL and close the singleton handle, if open
    try {
      if (!dbInstance || !dbInstance.open) {
        // open a temp handle just to checkpoint if needed
        dbInstance = new Database(DB_PATH);
      }
      // Move WAL contents into main DB and truncate WAL
      dbInstance.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      console.log(`[${nowIso()}] [ENTRY] wal_checkpoint note: ${e.message}`);
    } finally {
      if (dbInstance && dbInstance.open) {
        try { dbInstance.close(); } catch (_) {}
      }
      dbInstance = null;
    }

    // 4) Delete DB + sidecar files with retry (Windows EBUSY/EPERM safe)
    const wal = `${DB_PATH}-wal`;
    const shm = `${DB_PATH}-shm`;

    const okMain = await retryDelete(DB_PATH);
    const okWal  = await retryDelete(wal);
    const okShm  = await retryDelete(shm);

    if (!okMain) {
      throw new Error(`Could not delete DB file after retries: ${DB_PATH}`);
    }

    // 5) Reinitialize schema
    await initDb();
    console.log(`[${nowIso()}] [ENTRY] Database wiped and reinitialized.`);

    return { success: true, message: 'Database wiped and reinitialized' };
  } catch (err) {
    console.error(`[${nowIso()}] [ENTRY] wipeDatabase failed:`, err);
    return { success: false, error: err.message };
  } finally {
    // 6) Reopen the gate for future writes
    writeGateOpen = true;
    isWiping = false;
  }
}

function generateCsvFiles({ chunkSize = MAX_ROWS_PER_FILE } = {}) {
  // Open a separate read-only handle to avoid interfering with the singleton
  const ro = new Database(DB_PATH, { readonly: true });
  try {
    // Count rows in node links first
    const nodeLinks = ro.prepare(`SELECT COUNT(*) AS total FROM part_vehicle_nodes`).get().total;

    let mode = 'nodes'; // default (preferred) mode when node data exists
    let total = nodeLinks;

    if (!nodeLinks) {
      // Fallback: export compatibility only (no nodes yet)
      const compatRows = ro.prepare(`SELECT COUNT(*) AS total FROM compatibility`).get().total;
      if (!compatRows) {
        return {
          success: true,
          message: 'No data to export (no nodes or compatibility rows present).',
          directory: null,
          files: [],
          fileCount: 0,
          totalRows: 0
        };
      }
      mode = 'compat';
      total = compatRows;
    }

    const downloadsPath = (app && app.getPath) ? app.getPath('downloads') : path.join(process.cwd(), 'exports');
    const baseDir = path.join(downloadsPath, mode === 'nodes' ? 'compatibility_reports' : 'compatibility_only_reports');
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

    const fileCount = Math.ceil(total / chunkSize);
    const files = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Prepared statement per mode
    const stmt = mode === 'nodes'
      ? ro.prepare(`
          SELECT 
            p.part_number AS PartNumber,
            v.vehicle_name AS Vehicle,
            n.node_desc AS Node
          FROM part_vehicle_nodes pvn
          JOIN parts p    ON pvn.part_id = p.part_id
          JOIN vehicles v ON pvn.vehicle_id = v.vehicle_id
          JOIN nodes n    ON pvn.node_id  = n.node_id
          ORDER BY p.part_number, v.vehicle_name
          LIMIT ? OFFSET ?
        `)
      : ro.prepare(`
          SELECT 
            p.part_number AS PartNumber,
            v.vehicle_name AS Vehicle
          FROM compatibility c
          JOIN parts p    ON c.part_id = p.part_id
          JOIN vehicles v ON c.vehicle_id = v.vehicle_id
          ORDER BY p.part_number, v.vehicle_name
          LIMIT ? OFFSET ?
        `);

    for (let i = 0; i < fileCount; i++) {
      const offset = i * chunkSize;
      const rows = stmt.all(chunkSize, offset);
      if (!rows.length) continue;

      const fileName = `${mode === 'nodes' ? 'compatibility' : 'compatibility_only'}_${timestamp}_part${i + 1}_of${fileCount}.csv`;
      const filePath = path.join(baseDir, fileName);

      const header = Object.keys(rows[0]).join(',');
      const csv = [header];

      for (const r of rows) {
        // write columns in the same order as header
        csv.push(Object.keys(rows[0]).map(k => escapeCsvValue(r[k])).join(','));
      }

      fs.writeFileSync(filePath, csv.join('\n'), 'utf8');
      files.push(filePath);
    }

    return {
      success: true,
      message: mode === 'nodes'
        ? `Exported ${total} node-mapped rows to ${fileCount} file(s).`
        : `No node mappings yet — exported ${total} compatibility rows (Part ↔ Vehicle) to ${fileCount} file(s).`,
      directory: baseDir,
      fileCount,
      totalRows: total,
      files,
      mode
    };
  } catch (error) {
    console.error('[ENTRY] CSV export failed:', error);
    return { success: false, error: error.message };
  } finally {
    try { ro.close(); } catch {}
  }
}


function getPartIdByNumber(partNumber) {
    const db = connect();
    const row = db.prepare('SELECT part_id FROM parts WHERE part_number = ?').get(partNumber);
    return row ? row.part_id : null;
}

function getVehicleIdByRef(refId) {
    const db = connect();
    const row = db.prepare('SELECT vehicle_id FROM vehicles WHERE equipment_ref_id = ?').get(refId);
    return row ? row.vehicle_id : null;
}

function getNodeIdByDesc(desc) {
  const db = connect();
  const row = db.prepare('SELECT node_id FROM nodes WHERE node_desc = ?').get(desc);
  return row ? row.node_id : null;
}

/**
 * Dump a batch into a table, emitting progress events
 * @param {string} tableName
 * @param {Array<Object>} data
 */
function dumpToDb(tableName, data) {
  if (!data || data.length === 0) return { message: 'No data to dump.' };
  if (!writeGateOpen) {
    console.warn(`[${nowIso()}] [ENTRY] dumpToDb blocked: wipe in progress (table=${tableName})`);
    return { success: false, error: 'DB is being wiped. Try again shortly.' };
  }

  const db = connect();
  activeWriters++; // track an in-flight writer

  let insertStmt;
  switch (tableName) {
    case 'vehicles':
      insertStmt = db.prepare('INSERT OR IGNORE INTO vehicles (vehicle_id, vehicle_name, equipment_ref_id) VALUES (?, ?, ?)');
      break;
    case 'parts':
      insertStmt = db.prepare('INSERT OR IGNORE INTO parts (part_id, part_number) VALUES (?, ?)');
      break;
    case 'compatibility':
      insertStmt = db.prepare('INSERT OR IGNORE INTO compatibility (part_id, vehicle_id) VALUES (?, ?)');
      break;
    case 'nodes':
      insertStmt = db.prepare('INSERT OR IGNORE INTO nodes (node_id, node_desc) VALUES (?, ?)');
      break;
    case 'part_vehicle_nodes':
      insertStmt = db.prepare('INSERT OR IGNORE INTO part_vehicle_nodes (part_id, vehicle_id, node_id) VALUES (?, ?, ?)');
      break;
    default:
      activeWriters = Math.max(0, activeWriters - 1);
      throw new Error(`Unsupported table: ${tableName}`);
  }

  const total = data.length;
  let done = 0;

  const tx = db.transaction((rows) => {
    for (const row of rows) {
      try {
        insertStmt.run(Object.values(row));
        done++;
        const percent = Math.round((done / total) * 100);
        const payload = { table: tableName, done, total, percent };
        bus.emit('dump-progress', payload);
        console.log('[DB] dump-progress', payload);
      } catch (err) {
        console.error(`Error inserting into ${tableName}:`, err.message);
      }
    }
  });

  try {
    tx(data);
    return { success: true, inserted: done, total };
  } catch (err) {
    console.error(`Dump to ${tableName} failed:`, err.message);
    return { error: err.message };
  } finally {
    activeWriters = Math.max(0, activeWriters - 1); // writer finished
  }
}

/**
 * Allow listeners to subscribe to dump progress events
 */
function onDumpProgress(handler) {
    bus.on('dump-progress', handler);
}

module.exports = {
    connect,
    disconnect,
    dumpToDb,
    query,
    wipeDatabase,
    onDumpProgress,
    getPartIdByNumber,
    getVehicleIdByRef,
    getNodeIdByDesc,
    queryVehiclesForPart,
    generateCsvFiles
    
};

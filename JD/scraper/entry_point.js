/**
 * entry_point.js
 * Central DB helpers + orchestration.
 * Backwards-compatible: exposes runWithProgress(task, payload) used by main.js.
 */

const ExcelJS = require('exceljs');
const dbManager = require('./db_manager');

/* -------------------- Bulk insert (kept for nodes/CSV) -------------------- */
async function dumpToDb(tableName, data) {
  if (!Array.isArray(data)) throw new Error(`dumpToDb expected array for ${tableName}`);
  const db = dbManager.connect();
  try {
    const tx = db.transaction((rows) => {
      let insertStmt;
      switch (tableName) {
        case 'vehicles':
          insertStmt = db.prepare(
            'INSERT OR IGNORE INTO vehicles (vehicle_name, equipment_ref_id) VALUES (?, ?)'
          );
          break;
        case 'parts':
          insertStmt = db.prepare(
            'INSERT OR IGNORE INTO parts (part_number) VALUES (?)'
          );
          break;
        case 'compatibility':
          insertStmt = db.prepare(
            'INSERT OR IGNORE INTO compatibility (part_id, vehicle_id) VALUES (?, ?)'
          );
          break;
        case 'nodes':
          insertStmt = db.prepare(
            'INSERT OR IGNORE INTO nodes (node_desc) VALUES (?)'
          );
          break;
        case 'part_vehicle_nodes':
          insertStmt = db.prepare(
            'INSERT OR IGNORE INTO part_vehicle_nodes (part_id, vehicle_id, node_id) VALUES (?, ?, ?)'
          );
          break;
        default:
          throw new Error(`Unsupported table name: ${tableName}`);
      }

      for (const row of rows) {
        try {
          switch (tableName) {
            case 'vehicles':
              insertStmt.run(row.vehicle_name, row.equipment_ref_id);
              break;
            case 'parts':
              insertStmt.run(String(row.part_number));
              break;
            case 'compatibility':
              insertStmt.run(row.part_id, row.vehicle_id);
              break;
            case 'nodes':
              insertStmt.run(row.node_desc);
              break;
            case 'part_vehicle_nodes':
              insertStmt.run(row.part_id, row.vehicle_id, row.node_id);
              break;
          }
        } catch (e) {
          console.error(`Error inserting row into ${tableName}:`, row, e.message);
        }
      }
    });
    tx(data);
    return { ok: true, inserted: data.length, table: tableName };
  } finally {
    dbManager.disconnect();
  }
}

/* -------------------- Upsert helpers returning INTEGER ids -------------------- */
function ensurePart(partNumber) {
  const pn = String(partNumber ?? '').trim();
  if (!pn) return null;
  const db = dbManager.connect();
  try {
    const ins = db.prepare('INSERT OR IGNORE INTO parts (part_number) VALUES (?)');
    const sel = db.prepare('SELECT part_id FROM parts WHERE part_number = ?');
    ins.run(pn);
    const row = sel.get(pn);
    return row ? row.part_id : null;
  } finally {
    dbManager.disconnect();
  }
}

function ensureVehicle(vehicleName, equipmentRefId) {
  const name = String(vehicleName ?? '').trim();
  const ref = String(equipmentRefId ?? '').trim();
  if (!ref) return null;
  const db = dbManager.connect();
  try {
    const ins = db.prepare(
      'INSERT OR IGNORE INTO vehicles (vehicle_name, equipment_ref_id) VALUES (?, ?)'
    );
    const sel = db.prepare('SELECT vehicle_id FROM vehicles WHERE equipment_ref_id = ?');
    ins.run(name, ref);
    const row = sel.get(ref);
    return row ? row.vehicle_id : null;
  } finally {
    dbManager.disconnect();
  }
}

function dumpCompatibility(rows) {
  if (!rows?.length) return { ok: true, inserted: 0 };
  const db = dbManager.connect();
  try {
    const tx = db.transaction((arr) => {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO compatibility (part_id, vehicle_id) VALUES (?, ?)'
      );
      for (const r of arr) stmt.run(r.part_id, r.vehicle_id);
    });
    tx(rows);
    return { ok: true, inserted: rows.length };
  } finally {
    dbManager.disconnect();
  }
}

/* -------------------- XLSX utils -------------------- */
function sanitizeParts(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const s = String(v ?? '')
      .replace(/["'`]/g, '')
      .trim();
    if (!s) continue;
    if (!/[0-9A-Za-z\-._]/.test(s)) continue;
    const key = s.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function readPartsFromXlsx(xlsxPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const raw = [];
  ws.eachRow((row) => raw.push(row.getCell(1).value));
  return sanitizeParts(raw);
}

/* -------------------- Vehicle scraping orchestration -------------------- */
async function runVehicles({ xlsxPath, concurrency = 2, progressChannel = null } = {}) {
  if (!xlsxPath) throw new Error('xlsxPath is required');
  const parts = await readPartsFromXlsx(xlsxPath);
  if (parts.length === 0) return { ok: true, inserted: 0, vehicles: 0, compatibility: 0 };

  // Ensure parts and cache ids
  const partIdByNumber = new Map();
  for (const pn of parts) {
    const pid = ensurePart(pn);
    if (pid) partIdByNumber.set(pn, pid);
  }

  const { scrapeVehicleBatch } = require('./vehicle_scraper');

  let processed = 0;
  const allCompatRows = [];

  for (let i = 0; i < parts.length; i += concurrency) {
    const batch = parts.slice(i, i + concurrency);
    const res = await scrapeVehicleBatch(batch, () => {
      processed += 1;
      if (progressChannel) {
        try {
          const { BrowserWindow } = require('electron');
          BrowserWindow.getAllWindows().forEach((w) =>
            w.webContents.send(progressChannel, { processed, total: parts.length })
          );
        } catch (_) {}
      }
    });

    if (Array.isArray(res?.vehicles) && res.vehicles.length) {
      for (const v of res.vehicles) ensureVehicle(v.vehicle_name, v.equipment_ref_id);
    }
    if (Array.isArray(res?.compatibility) && res.compatibility.length) {
      for (const c of res.compatibility) {
        const partId = partIdByNumber.get(String(c.part_number));
        let vehicleId = c.vehicle_id;
        if (!vehicleId && c.equipment_ref_id) {
          vehicleId = ensureVehicle(c.vehicle_name || '', c.equipment_ref_id);
        }
        if (partId && vehicleId) allCompatRows.push({ part_id: partId, vehicle_id: vehicleId });
      }
    }
  }

  const compatResult = dumpCompatibility(allCompatRows);

  try {
    const { BrowserWindow } = require('electron');
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send('database-updated', { at: Date.now() })
    );
  } catch (_) {}

  return {
    ok: true,
    inserted: parts.length,
    vehicles: 'upserted',
    compatibility: compatResult.inserted || 0,
  };
}

/* -------------------- Nodes passthrough (optional) -------------------- */
async function runNodes(payload) {
  if (payload?.nodes?.length) await dumpToDb('nodes', payload.nodes);
  if (payload?.part_vehicle_nodes?.length) await dumpToDb('part_vehicle_nodes', payload.part_vehicle_nodes);

  try {
    const { BrowserWindow } = require('electron');
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send('database-updated', { at: Date.now() })
    );
  } catch (_) {}

  return { ok: true };
}

/* -------------------- Back-compat shim -------------------- */
/**
 * Legacy entry point used by main.js
 * @param {'vehicles'|'nodes'} task
 * @param {any} payload
 *   vehicles: string|{ xlsxPath, concurrency?, progressChannel? }
 *   nodes: { nodes:[], part_vehicle_nodes:[] }
 */
async function runWithProgress(task, payload) {
  if (task === 'vehicles') {
    let xlsxPath, concurrency, progressChannel;
    if (typeof payload === 'string') {
      xlsxPath = payload;
    } else if (payload && typeof payload === 'object') {
      xlsxPath = payload.xlsxPath || payload.path || payload.filePath;
      concurrency = payload.concurrency;
      progressChannel = payload.progressChannel || 'progress:vehicles';
    }
    if (!xlsxPath) throw new Error('xlsxPath is required for vehicles task');
    return runVehicles({ xlsxPath, concurrency, progressChannel });
  }

  if (task === 'nodes') {
    return runNodes(payload || {});
  }

  throw new Error(`Unknown task: ${task}`);
}

module.exports = {
  dumpToDb,
  ensurePart,
  ensureVehicle,
  dumpCompatibility,
  runVehicles,
  runNodes,
  runWithProgress, // <- compatibility export
};

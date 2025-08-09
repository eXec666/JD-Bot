// db/data_entry_point.js
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');
const path = require('path');
const { DB_PATH } = require('./db_config');

// adjust filename if needed
let dbInstance = null;
const bus = new EventEmitter();

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
    if (!data || data.length === 0) {
        return { message: 'No data to dump.' };
    }

    const db = connect();

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

                // DEBUG: log each successful row write + emit
                const payload = { table: tableName, done, total, percent };
                bus.emit('dump-progress', payload);
                console.log('[DB] dump-progress', payload);
            }catch (err) {
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
    onDumpProgress,
    getPartIdByNumber,
    getVehicleIdByRef,
    getNodeIdByDesc,
    query
};

const Database = require('better-sqlite3');
const { DB_PATH } = require('../db/db_config');

const schema = `
CREATE TABLE IF NOT EXISTS parts (
  part_id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_number TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_name TEXT NOT NULL,
  equipment_ref_id TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS compatibility (
  compat_id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL,
  vehicle_id INTEGER NOT NULL,
  FOREIGN KEY (part_id) REFERENCES parts (part_id),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles (vehicle_id),
  UNIQUE(part_id, vehicle_id)
);

CREATE TABLE IF NOT EXISTS nodes (
  node_id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_desc TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS part_vehicle_nodes (
  pvn_id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL,
  vehicle_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  FOREIGN KEY (part_id) REFERENCES parts (part_id),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles (vehicle_id),
  FOREIGN KEY (node_id) REFERENCES nodes (node_id),
  UNIQUE(part_id, vehicle_id, node_id)
);

`;

function initDb() {
  let db;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    
    // Check if vehicles table exists
    const tableCheck = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='vehicles'
    `).get();

    if (!tableCheck) {
      console.log('Creating database schema...');
      db.exec(schema);
      
      // Verify creation
      const tables = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table'
      `).all();
      console.log('Created tables:', tables.map(t => t.name));
    } else {
      console.log('Database already initialized');
    }
    
    return true;
  } catch (err) {
    console.error('Database initialization failed:', err);
    
    // Try to recover by deleting and recreating
    try {
      if (db) db.close();
      require('fs').unlinkSync(DB_PATH);
      return initDb(); // Recursively retry
    } catch (recoveryErr) {
      console.error('Database recovery failed:', recoveryErr);
      return false;
    }
  } finally {
    if (db) db.close();
  }
}

// Add this for manual testing when needed
if (require.main === module) {
  initDb();
}

module.exports = initDb;
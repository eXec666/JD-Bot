const Database = require('better-sqlite3');
const { DB_PATH } = require('../db/db_config');

function queryVehiclesForPart(partNumber) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
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
  } finally {
    db.close();
  }
}

module.exports = {
  queryVehiclesForPart
};
// db_utils.js
const Database = require('better-sqlite3');
const { DB_PATH } = require('./db_config');

function getTableData(table) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const stmt = db.prepare(`SELECT * FROM ${table}`);
    return stmt.all();
  } finally {
    db.close();
  }
}

module.exports = {
  getTableData
};
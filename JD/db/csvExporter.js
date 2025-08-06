const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DB_PATH } = require('./db_config');
const Database = require('better-sqlite3');
const dbManager = require('./db/db_manager');

const MAX_ROWS_PER_FILE = 5000;

function generateCsvFiles() {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // Get total rows count first
    const countStmt = dbManager.query(`
      SELECT COUNT(*) as total
      FROM part_vehicle_nodes
    `);
    const { total } = countStmt.get();
    
    if (total === 0) {
      return { message: 'No compatibility data found to export' };
    }
    
    // Determine output directory
    const downloadsPath = app.getPath('downloads');
    const baseDir = path.join(downloadsPath, 'compatibility_reports');
    
    // Create directory if needed
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    
    // Get the data in chunks
    const fileCount = Math.ceil(total / MAX_ROWS_PER_FILE);
    const files = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    for (let i = 0; i < fileCount; i++) {
      const offset = i * MAX_ROWS_PER_FILE;
      
      const stmt = dbManager.query(`
        SELECT 
          p.part_number AS PartNumber,
          v.vehicle_name AS Vehicle,
          n.node_desc AS Node
        FROM part_vehicle_nodes pvn
        JOIN parts p ON pvn.part_id = p.part_id
        JOIN vehicles v ON pvn.vehicle_id = v.vehicle_id
        JOIN nodes n ON pvn.node_id = n.node_id
        ORDER BY p.part_number, v.vehicle_name
        LIMIT ? OFFSET ?
      `);
      
      const rows = stmt.all(MAX_ROWS_PER_FILE, offset);
      if (rows.length === 0) continue;
      
      // Generate filename
      const fileName = `compatibility_${timestamp}_part${i + 1}_of${fileCount}.csv`;
      const filePath = path.join(baseDir, fileName);
      
      // Generate CSV content
      const header = Object.keys(rows[0]).join(',');
      const csvContent = [header];
      
      for (const row of rows) {
        const line = [
          escapeCsvValue(row.PartNumber),
          escapeCsvValue(row.Vehicle),
          escapeCsvValue(row.Node)
        ].join(',');
        csvContent.push(line);
      }
      
      fs.writeFileSync(filePath, csvContent.join('\n'), 'utf8');
      files.push(filePath);
    }
    
    return {
      success: true,
      message: `Exported ${total} records to ${fileCount} files`,
      directory: baseDir,
      fileCount,
      totalRows: total
    };
    
  } catch (error) {
    console.error('CSV export failed:', error);
    return { error: error.message };
  } finally {
    db.close();
  }
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = { generateCsvFiles };
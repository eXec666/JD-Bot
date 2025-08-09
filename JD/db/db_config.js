// db/db_config.js
const path = require('path');
const fs = require('fs');
let app;

try {
  app = require('electron').app;
} catch {
  app = null;
}

// Always resolve to the same location based on whether Electron's app is available
const DB_PATH = app && app.getPath
  ? path.join(app.getPath('userData'), 'parts.db')
  : path.join(process.cwd(), 'parts.db'); // For CLI or scripts without Electron

// Ensure directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

module.exports = { DB_PATH };

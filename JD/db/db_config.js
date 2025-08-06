// db/db_config.js
const path = require('path');
const { app } = require('electron') || {};
const fs = require('fs');

const getDbPath = () => {
    if (app && app.getPath) {
        return path.join(app.getPath('userData'), 'parts.db');
    }
    return path.join(__dirname, '..', 'data', 'parts.db'); // Adjusted path
};

// Ensure data directory exists
const dataDir = path.dirname(getDbPath());
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

module.exports = { 
    DB_PATH: getDbPath()
};
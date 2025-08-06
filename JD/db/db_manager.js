// db/db_manager.js
const Database = require('better-sqlite3');
const { DB_PATH } = require('./db_config');

class DatabaseManager {
    constructor() {
        this.db = null;
    }

    connect() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('foreign_keys = ON');
        }
        return this.db;
    }

    disconnect() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    // Generic query execution
    query(sql, params = []) {
        const db = this.connect();
        try {
            const stmt = db.prepare(sql);
            return params.length > 0 ? stmt.all(params) : stmt.all();
        } catch (error) {
            console.error('Query failed:', error.message);
            throw error;
        }
    }

    // Specific methods for common operations
    getTables() {
        return this.query(
            "SELECT name FROM sqlite_master WHERE type='table'"
        );
    }

    getTableData(tableName) {
        return this.query(`SELECT * FROM ${tableName}`);
    }

    // Compatibility data methods
    getCompatibilityData(partId, vehicleId) {
        return this.query(`
            SELECT n.node_desc 
            FROM part_vehicle_nodes pvn
            JOIN nodes n ON pvn.node_id = n.node_id
            WHERE pvn.part_id = ? AND pvn.vehicle_id = ?
        `, [partId, vehicleId]);
    }

    // Add more domain-specific methods as needed...
}

// Singleton instance
const dbManager = new DatabaseManager();

// Ensure clean disconnect on process exit
process.on('exit', () => dbManager.disconnect());
process.on('SIGINT', () => process.exit());

module.exports = dbManager;
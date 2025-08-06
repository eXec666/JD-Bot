const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3');
const puppeteer = require('puppeteer');
const ExcelJS = require('exceljs');
const {v4: uuidv4} = require('uuid');
const { resourceLimits } = require('worker_threads');
//check if actually necessary for the functionality of the code
const {DB_PATH} = require();
const initDb = require();


//if required, configure database manager from JD code as template

const CONFIG = {
    //configure and test file paths
    inputFile: path.join(process.resourcesPath || __dirname, 'testFile.xlsx'),
    outputFile: 'Ценообразование.xlsx',
    baseUrl: 'https://partsbooking.ru/products',
    maxPartsToProcess: 0,

    //resource management
    maxConcurrentInstances: Math.max(1,Math.floor(os.cpus().length * 0.75)),
    requestThrottle: 700,
    resourceLimits: {
        maxCPU: 80,
        maxMemory: 80,
    },

    browser: {
        headless: true,
        instances: Array.from({length: Math.max(1, Math.floor(os.cpus().length * 0.75))}, (_, i) => ({
            x: (i % 2) * 1280,
            y: Math.floor(i / 2) * 800,
            width: 1280,
            height: 800
        }))
    },

    navigation: {
        timeout: 60000,
        waitUntil: 'networkidle2',
        apiTimeout: 30000,
        retries: 3,
        retryDelays: [2000, 5000, 10000],
    },

    debug: {
        logNetwork: true,
        saveScreenshots: true,
        screenshotPath: path.join(os.homedir(), 'gg-partsBooking-debug')
    }
};


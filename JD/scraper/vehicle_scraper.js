const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');
const { DB_PATH } = require('../db/db_config');
const initDb = require('./init_db');
const { app } = require('electron');
const dataEntry = require('../db/data_entry_point'); // Unified DB hub

puppeteer.use(StealthPlugin());

// --- Configuration ---
const CONFIG = {
  inputFile: path.join(process.resourcesPath || __dirname, 'JD_clean.xlsx'),
  baseUrl: 'https://partscatalog.deere.com/jdrc/search/type/parts/term/',
  maxPartsToProcess: 0,
  maxConcurrentInstances: Math.max(1, Math.floor(os.cpus().length * 0.75)),
  requestThrottle: 2500,
  resourceLimits: { maxCPU: 80, maxMemory: 80 },
  browser: {
    headless: true,
    executablePath: null,
    userDataDir: path.join(app ? app.getPath('userData') : os.tmpdir(), 'puppeteer_data'),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
    instances: Array.from(
      { length: Math.max(1, Math.floor(os.cpus().length * 0.75)) },
      (_, i) => ({
        x: (i % 2) * 1280,
        y: Math.floor(i / 2) * 800,
        width: 1280,
        height: 800
      })
    )
  },
  navigation: {
    timeout: 60000,
    waitUntil: 'networkidle2',
    apiTimeout: 30000,
    retries: 3,
    retryDelays: [2000, 5000, 10000]
  },
  debug: {
    saveScreenshots: true,
    screenshotPath: path.join(os.homedir(), 'gg-bot-debug')
  }
};


// --- Batch Processing Configuration ---
const BATCH_SIZE = 1000;
const sleep = ms => new Promise(res => setTimeout(res, ms));
let sharedTaskQueue = [];
function getNextTask() { return sharedTaskQueue.shift() || null; }

// --- Parallel Scraper Class ---
class ParallelScraper {
  constructor(config, instanceId) {
    this.config = config;
    this.instanceId = instanceId;
    this.currentBatch = [];
    this.vehiclesProcessedCount = 0;
  }

  async initialize() {
    if (!CONFIG.browser.executablePath) {
    const chromeLauncher = await import('chrome-launcher');
    CONFIG.browser.executablePath = chromeLauncher.Launcher.getInstallations()[0];
  }

  // Launch Puppeteer browser
  this.browser = await puppeteer.launch({
    executablePath: CONFIG.browser.executablePath,
    headless: CONFIG.browser.headless,
    args: CONFIG.browser.args,
    ignoreHTTPSErrors: true
  });

  this.page = await this.browser.newPage();
  await this.page.setViewport({ width: this.config.width, height: this.config.height });
  await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  await this.page.evaluateOnNewDocument(() => {
    localStorage.setItem('language', 'en');
    localStorage.setItem('selectedLocale', 'en_US');
  });

  await this.page.setRequestInterception(true);
  this.page.on('request', req => {
    const type = req.resourceType();
    if (['stylesheet', 'font', 'image', 'media'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });
  }

  async processPart(partNumber) {
    const debugId = `${this.instanceId}-${uuidv4().slice(0, 4)}`;
    const partUrl = CONFIG.baseUrl + encodeURIComponent(partNumber);
    const startTime = Date.now();

    try {
        console.log(`[${debugId}] Scraping: ${partUrl}`);
        await this.page.goto(partUrl, { waitUntil: CONFIG.navigation.waitUntil, timeout: CONFIG.navigation.timeout });

        const apiResponse = await this.page.waitForResponse(
            response => response.url().includes('/jdrc-services/v1/search/parts') && response.status() === 200,
            { timeout: CONFIG.navigation.apiTimeout }
        );

        const json = await apiResponse.json();
        const results = Array.isArray(json) ? json : json.searchResults || [];

        const vehicles = [];
        for (const item of results) {
            if (item.equipmentName && item.equipmentRefId && String(item.equipmentName).trim() !== '') {
                vehicles.push({ name: String(item.equipmentName).trim(), refId: String(item.equipmentRefId).trim() });
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${debugId}]  Scraped ${vehicles.length} vehicle(s) for part '${partNumber}' in ${duration}s.`);

        // Always return valid object
        return { part: partNumber, vehicles, error: null };

    } catch (err) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const screenshotPath = path.join(CONFIG.debug.screenshotPath, `error-${debugId}.png`);

        if (CONFIG.debug.saveScreenshots) {
            fs.mkdirSync(CONFIG.debug.screenshotPath, { recursive: true });
            await this.page.screenshot({ path: screenshotPath }).catch(e => console.error("Screenshot failed:", e));
        }

        console.error(`[${debugId}]  Failed to scrape part '${partNumber}': ${err.message}`);

        // Always return valid object on error
        return { part: partNumber, vehicles: [], error: err.message };
    }
}


  async dumpCurrentBatch() {
    if (!this.currentBatch || this.currentBatch.length === 0) return;

    console.log(`[Worker ${this.instanceId}] Dumping batch of ${this.currentBatch.length} items to database.`);

    const parts = [];
    const vehicles = [];
    const compatibilityTemp = [];

    // Step 1: Prepare raw insert data
    for (const result of this.currentBatch) {
      if (!result || typeof result !== 'object') {
        continue; // skip invalid entries
      }
      if (result.error || !Array.isArray(result.vehicles) || result.vehicles.length === 0) {
          continue;
      }

      parts.push({
        part_id: null,
        part_number: result.part
      });

      for (const vehicle of result.vehicles) {
        vehicles.push({
          vehicle_id: null,
          vehicle_name: vehicle.name,
          equipment_ref_id: vehicle.refId
        });

        compatibilityTemp.push({
          part_number: result.part,
          equipment_ref_id: vehicle.refId
        });
      }
    }

    // Step 2: Insert parts and vehicles
    dataEntry.dumpToDb('parts', parts);
    dataEntry.dumpToDb('vehicles', vehicles);

    // Step 3: Resolve IDs via entry point helpers
    const compatibilityResolved = compatibilityTemp.map(row => {
      const partId = dataEntry.getPartIdByNumber(row.part_number);
      const vehicleId = dataEntry.getVehicleIdByRef(row.equipment_ref_id);
      if (partId && vehicleId) {
        return { part_id: partId, vehicle_id: vehicleId };
      }
      return null;
    }).filter(Boolean);

    // Step 4: Insert compatibility
    dataEntry.dumpToDb('compatibility', compatibilityResolved);

    // Step 5: Track processed count & clear batch
    this.vehiclesProcessedCount += vehicles.length;
    this.currentBatch = [];
  }

  async workerLoop() {
    while (true) {
      const task = getNextTask();
      if (!task) break;

      const result = await this.processPart(task);
      if (result && typeof result === 'object') {
        this.currentBatch.push(result);
      } 

      if (this.currentBatch.length >= BATCH_SIZE) {
        await this.dumpCurrentBatch();
      }

      await sleep(CONFIG.requestThrottle + Math.random() * 1000);
    }
    await this.dumpCurrentBatch();
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
  }
}

// Global scrape lock
let isScraping = false;

module.exports = {
  wipeDatabase: async function () {
    if (isScraping) return { success: false, message: "Scrape in progress." };
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    await initDb();
    return { success: true, message: 'Database wiped and reinitialized' };
  },

  runWithProgress: async function (progressCallback = () => {}, onForceRefresh = () => {}, inputFilePath = null) {
    if (isScraping) return { message: "Scraping is already in progress." };
    isScraping = true;

    const startTime = Date.now();
    let progressInterval;

    try {
      await initDb();
      const inputFile = inputFilePath || CONFIG.inputFile;
      if (!fs.existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);

      // Load parts list
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(inputFile);
      const worksheet = workbook.getWorksheet(1);
      const partNumbers = worksheet.getColumn(2).values.slice(2).filter(Boolean).map(p => p.toString().trim());
      const finalParts = CONFIG.maxPartsToProcess > 0 ? partNumbers.slice(0, CONFIG.maxPartsToProcess) : partNumbers;

      sharedTaskQueue = [...finalParts];
      const totalParts = finalParts.length;

      // Init workers
      const workerInitPromises = CONFIG.browser.instances.map(async (conf, idx) => {
        try {
          const worker = new ParallelScraper(conf, idx + 1);
          await worker.initialize();
          return worker;
        } catch (initError) {
          console.error(`Worker ${idx + 1} failed to initialize: ${initError.message}`);
          return null;
        }
      });

      const initializedWorkers = await Promise.all(workerInitPromises);
      const workers = initializedWorkers.filter(Boolean);
      if (workers.length === 0) throw new Error("No scraper workers could be initialized.");

      console.log(`Starting scrape of ${totalParts} parts with ${workers.length} active instances.`);

      // Scraping progress
      progressInterval = setInterval(() => {
        const processedPartsCount = totalParts - sharedTaskQueue.length;
        const totalVehiclesProcessed = workers.reduce((sum, w) => sum + w.vehiclesProcessedCount, 0);
        const percent = Math.min(100, Math.round((processedPartsCount / totalParts) * 100));
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const remaining = processedPartsCount > 0
          ? ((totalParts - processedPartsCount) * (elapsed / processedPartsCount)).toFixed(1)
          : '...';

        progressCallback(percent, `Scraping... ${percent}% (${processedPartsCount}/${totalParts} parts, ${totalVehiclesProcessed} vehicles) | Elapsed: ${elapsed}s | Remaining: ~${remaining}s`);
      }, 1000);

      // Run workers
      await Promise.all(workers.map(w => w.workerLoop()));

      clearInterval(progressInterval);
      progressCallback(100, `Scraping 100% complete.`);

      console.log("All scraping and batch dumping completed. Closing browsers...");
      await Promise.all(workers.map(w => w.close()));
      onForceRefresh();

      const finalTotalVehiclesProcessed = workers.reduce((sum, w) => sum + w.vehiclesProcessedCount, 0);
      return { message: `Scraping and saving completed for ${totalParts} parts, ${finalTotalVehiclesProcessed} vehicles.`, results: [] };
    } catch (err) {
      console.error('Critical error in runWithProgress:', err);
      return { error: err.message };
    } finally {
      if (progressInterval) clearInterval(progressInterval);
      isScraping = false;
      console.log("Scraping process finished.");
    }
  }
};

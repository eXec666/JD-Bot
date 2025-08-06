const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');
const { DB_PATH } = require('../db/db_config'); // Ensure this path is correct for your project
const initDb = require('./init_db'); // Ensure this path is correct for your project
const { app } = require('electron'); // Electron app module for path resolution

puppeteer.use(StealthPlugin());

// --- Configuration ---
const CONFIG = {
  inputFile: path.join(process.resourcesPath || __dirname, 'JD_clean.xlsx'),
  baseUrl: 'https://partscatalog.deere.com/jdrc/search/type/parts/term/',
  maxPartsToProcess: 0, // Set to 0 to process all parts, or a number for testing
  maxConcurrentInstances: Math.max(1, Math.floor(os.cpus().length * 0.75)), // Use 75% of CPU cores
  requestThrottle: 2500, // Delay between requests to avoid overwhelming the server
  resourceLimits: { maxCPU: 80, maxMemory: 80 }, // Not directly used in this script but good for monitoring
  browser: {
    headless: true, // Run browser in headless mode (no GUI)
    executablePath: null, // Auto-detected by chrome-launcher if null
    userDataDir: path.join(app ? app.getPath('userData') : os.tmpdir(), 'puppeteer_data'), // Persistent user data directory
    args: [ // Browser arguments for optimization and stability
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // Use single process for better resource management in some cases
      '--disable-gpu' // Disable GPU hardware acceleration
    ],
    // Configuration for multiple browser instances (if running multiple windows)
    instances: Array.from({ length: Math.max(1, Math.floor(os.cpus().length * 0.75)) }, (_, i) => ({
      x: (i % 2) * 1280, y: Math.floor(i / 2) * 800, width: 1280, height: 800
    }))
  },
  navigation: { // Navigation timeouts and retry logic
    timeout: 60000, // Page navigation timeout
    waitUntil: 'networkidle2', // Wait until network activity is low
    apiTimeout: 30000, // API response timeout
    retries: 3, // Number of retries for failed requests
    retryDelays: [2000, 5000, 10000] // Delays between retries
  },
  debug: { // Debugging options
    saveScreenshots: true, // Save screenshots on error
    screenshotPath: path.join(os.homedir(), 'gg-bot-debug') // Path to save screenshots
  }
};

// --- Batch Processing Configuration ---
const BATCH_SIZE = 1000; // Number of scraped results to collect before dumping to DB

const sleep = ms => new Promise(res => setTimeout(res, ms));
let sharedTaskQueue = []; // Global queue for part numbers to be scraped
function getNextTask() { return sharedTaskQueue.shift() || null; } // Get next task from the queue

// --- DATABASE DUMP FUNCTION ---
// This function is now called with smaller batches of data
// It returns the count of vehicles successfully processed in this batch.
function dumpDataToDatabase(scrapedResultsBatch) {
  if (!scrapedResultsBatch || scrapedResultsBatch.length === 0) {
    return 0; // Return 0 if no data to process
  }
  const db = new Database(DB_PATH);
  let vehiclesInBatchProcessed = 0; // Counter for vehicles processed in this batch
  try {
    db.pragma('journal_mode = WAL'); // Enable Write-Ahead Logging for better concurrency and performance
    db.pragma('foreign_keys = ON'); // Enforce foreign key constraints

    // Prepared statements for efficient database operations
    const getPartStmt = db.prepare('SELECT part_id FROM parts WHERE part_number = ?');
    const insertPartStmt = db.prepare('INSERT OR IGNORE INTO parts (part_number) VALUES (?)');
    const getVehicleStmt = db.prepare('SELECT vehicle_id FROM vehicles WHERE equipment_ref_id = ?');
    const insertVehicleStmt = db.prepare('INSERT INTO vehicles (vehicle_name, equipment_ref_id) VALUES (?, ?)'); // Changed from INSERT OR IGNORE
    const insertCompatStmt = db.prepare('INSERT OR IGNORE INTO compatibility (part_id, vehicle_id) VALUES (?, ?)');

    // Database transaction for atomic and fast batch inserts
    const dumpTx = db.transaction(() => {
      for (const result of scrapedResultsBatch) {
        if (result.error || result.vehicles.length === 0) continue; // Skip errored or empty results

        // Insert part and get its ID
        insertPartStmt.run(result.part);
        const partRow = getPartStmt.get(result.part);
        if (!partRow) {
          console.warn(`Could not retrieve part_id for part: ${result.part}. Skipping part and its vehicles.`);
          continue;
        }
        const partId = partRow.part_id;

        // Insert vehicles and their compatibility with the part
        for (const vehicle of result.vehicles) {
          let vehicleId;
          const trimmedRefId = vehicle.refId; // Use the already trimmed refId
          const trimmedVehicleName = vehicle.name; // Use the already trimmed name

          // First, try to get the existing vehicle_id
          const existingVehicleRow = getVehicleStmt.get(trimmedRefId);

          if (existingVehicleRow) {
            vehicleId = existingVehicleRow.vehicle_id;
          } else {
            // If vehicle does not exist, insert it
            try {
              const insertResult = insertVehicleStmt.run(trimmedVehicleName, trimmedRefId);
              vehicleId = insertResult.lastInsertRowid;
            } catch (insertError) {
              // This catch block will specifically handle UNIQUE constraint violations
              // or other insert errors, and then attempt to retrieve the ID if it was a unique conflict.
              if (insertError.message.includes('UNIQUE constraint failed')) {
                const retryVehicleRow = getVehicleStmt.get(trimmedRefId);
                if (retryVehicleRow) {
                  vehicleId = retryVehicleRow.vehicle_id;
                } else {
                  console.error(`[ERROR] Failed to insert vehicle '${trimmedRefId}' and could not retrieve existing ID after unique constraint failure: ${insertError.message}`);
                  continue; // Skip this vehicle if ID cannot be retrieved
                }
              } else {
                console.error(`[ERROR] Failed to insert new vehicle '${trimmedRefId}': ${insertError.message}`);
                continue; // Skip this vehicle on other insert errors
              }
            }
          }
          
          // If we successfully obtained a vehicleId (either new or existing)
          if (vehicleId) {
            insertCompatStmt.run(partId, vehicleId);
            vehiclesInBatchProcessed++; // Increment the counter for this batch
          }
        }
      }
    });

    dumpTx(); // Execute the transaction
    return vehiclesInBatchProcessed; // Return the count of vehicles processed in this batch
  } catch (dbErr) {
    console.error('Error during database batch dump:', dbErr.message);
    return 0; // Return 0 on error
  } finally {
    if (db && db.open) {
      db.close(); // Close the database connection
    }
  }
}

// --- Parallel Scraper Class ---
class ParallelScraper {
  constructor(config, instanceId) {
    this.config = config;
    this.instanceId = instanceId;
    this.currentBatch = []; // Buffer to store scraped results for batching
    this.vehiclesProcessedCount = 0; // Counter for vehicles processed by this worker
  }

  async initialize() {
    // Auto-detect Chrome executable path if not specified
    if (!CONFIG.browser.executablePath) {
        const chromeLauncher = await import('chrome-launcher');
        CONFIG.browser.executablePath = chromeLauncher.Launcher.getInstallations()[0];
    }
    // Launch Puppeteer browser instance
    this.browser = await puppeteer.launch({
      executablePath: CONFIG.browser.executablePath,
      headless: CONFIG.browser.headless,
      args: CONFIG.browser.args,
      ignoreHTTPSErrors: true // Ignore HTTPS certificate errors
    });
    this.page = await this.browser.newPage(); // Open a new page
    // Set viewport dimensions
    await this.page.setViewport({ width: this.config.width, height: this.config.height });
    // Set user agent to mimic a standard browser
    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    // Set extra HTTP headers
    await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    // Execute script on new document to set localStorage for language
    await this.page.evaluateOnNewDocument(() => { localStorage.setItem('language', 'en'); localStorage.setItem('selectedLocale', 'en_US'); });
    await this.page.setRequestInterception(true); // Enable request interception
    // Abort requests for certain resource types to save bandwidth and speed up scraping
    this.page.on('request', req => {
      const type = req.resourceType();
      if (['stylesheet', 'font', 'image', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  // Function to process a single part number
  async processPart(partNumber) {
    const debugId = `${this.instanceId}-${uuidv4().slice(0, 4)}`; // Unique ID for debugging
    const partUrl = CONFIG.baseUrl + encodeURIComponent(partNumber); // Construct URL
    const startTime = Date.now(); // Start time for performance measurement
    try {
      console.log(`[${debugId}] Scraping: ${partUrl}`);
      // Navigate to the part URL
      await this.page.goto(partUrl, { waitUntil: CONFIG.navigation.waitUntil, timeout: CONFIG.navigation.timeout });
      // Wait for the specific API response containing part data
      const apiResponse = await this.page.waitForResponse(
        response => response.url().includes('/jdrc-services/v1/search/parts') && response.status() === 200,
        { timeout: CONFIG.navigation.apiTimeout }
      );
      const json = await apiResponse.json(); // Parse JSON response
      const results = Array.isArray(json) ? json : json.searchResults || []; // Extract search results
      const vehicles = [];
      // Extract vehicle names and reference IDs with validation
      for (const item of results) {
        // Ensure equipmentName is not an empty string after trimming and both are present
        if (item.equipmentName && item.equipmentRefId && String(item.equipmentName).trim() !== '') {
          vehicles.push({ name: String(item.equipmentName).trim(), refId: String(item.equipmentRefId).trim() });
        } else {
          // Optional: Log if a vehicle item is skipped due to invalid data
          // console.warn(`[${debugId}] Skipping vehicle with invalid data: equipmentName='${item.equipmentName}', equipmentRefId='${item.equipmentRefId}'`);
        }
      }
      const duration = ((Date.now() - startTime) / 1000).toFixed(1); // Calculate duration
      console.log(`[${debugId}] ✅ Scraped ${vehicles.length} vehicle(s) for part '${partNumber}' in ${duration}s.`);
      return { part: partNumber, vehicles: vehicles, error: null }; // Return scraped data
    } catch (err) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const screenshotPath = path.join(CONFIG.debug.screenshotPath, `error-${debugId}.png`);
      if (CONFIG.debug.saveScreenshots) {
        fs.mkdirSync(CONFIG.debug.screenshotPath, { recursive: true });
        await this.page.screenshot({ path: screenshotPath }).catch(e => console.error("Screenshot failed:", e));
      }
      console.error(`[${debugId}] ❌ Failed to scrape part '${partNumber}': ${err.message}`);
      return { part: partNumber, vehicles: [], error: err.message }; // Return error information
    }
  }

  // Function to dump the current batch to the database
  async dumpCurrentBatch() {
    if (this.currentBatch.length > 0) {
      console.log(`[Worker ${this.instanceId}] Dumping batch of ${this.currentBatch.length} items to database...`);
      const processedCount = dumpDataToDatabase(this.currentBatch); // Get count of vehicles processed in this batch
      this.vehiclesProcessedCount += processedCount; // Add to worker's total
      this.currentBatch = []; // Clear the batch after dumping
    }
  }

  // Main worker loop to process tasks from the shared queue
  async workerLoop() {
    while (true) {
      const task = getNextTask(); // Get next part number from the global queue
      if (!task) break; // If no more tasks, break the loop

      const result = await this.processPart(task); // Process the part
      this.currentBatch.push(result); // Add result to the worker's current batch

      // If the batch size is reached, dump to database
      if (this.currentBatch.length >= BATCH_SIZE) {
        await this.dumpCurrentBatch();
      }

      await sleep(CONFIG.requestThrottle + Math.random() * 1000); // Throttle requests
    }
    // After the loop finishes, dump any remaining items in the batch
    await this.dumpCurrentBatch();
  }

  // Close the browser instance
  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
  }
}

// Global scrape lock to prevent concurrent executions
let isScraping = false;

module.exports = {
  // Function to wipe and reinitialize the database
  wipeDatabase: async function () {
    if (isScraping) { return { success: false, message: "Scrape in progress." }; }
    if (fs.existsSync(DB_PATH)) { fs.unlinkSync(DB_PATH); } // Delete existing DB file
    await initDb(); // Reinitialize database schema
    return { success: true, message: 'Database wiped and reinitialized' };
  },

  // Main function to run the scraping process with progress updates
  runWithProgress: async function (progressCallback = () => {}, onForceRefresh = () => {}, inputFilePath = null) {
    if (isScraping) { return { message: "Scraping is already in progress." }; }
    isScraping = true; // Set scrape lock

    const startTime = Date.now();
    let progressInterval;

    try {
      await initDb(); // Initialize database before starting
      const inputFile = inputFilePath || CONFIG.inputFile;
      if (!fs.existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);
      
      // Read part numbers from the Excel file
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(inputFile);
      const worksheet = workbook.getWorksheet(1);
      const partNumbers = worksheet.getColumn(2).values.slice(2).filter(Boolean).map(p => p.toString().trim());
      const finalParts = CONFIG.maxPartsToProcess > 0 ? partNumbers.slice(0, CONFIG.maxPartsToProcess) : partNumbers;
      
      sharedTaskQueue = [...finalParts]; // Populate the global task queue
      const totalParts = finalParts.length;

      // Initialize parallel scraper workers
      const workerInitPromises = CONFIG.browser.instances.map(async (conf, idx) => {
        try {
          const worker = new ParallelScraper(conf, idx + 1);
          await worker.initialize();
          return worker;
        } catch (initError) {
          console.error(`Worker ${idx + 1} failed to initialize and will be disabled. Error: ${initError.message}`);
          return null;
        }
      });
      
      const initializedWorkers = await Promise.all(workerInitPromises);
      const workers = initializedWorkers.filter(w => w !== null); // Filter out failed workers

      if (workers.length === 0) throw new Error("No scraper workers could be initialized.");
      console.log(`Starting scrape of ${totalParts} parts with ${workers.length} active instances.`);

      // Set up progress interval
      progressInterval = setInterval(() => {
        const processedPartsCount = totalParts - sharedTaskQueue.length;
        // Sum up vehiclesProcessedCount from all workers for total vehicles processed
        const totalVehiclesProcessed = workers.reduce((sum, worker) => sum + worker.vehiclesProcessedCount, 0);
        const percent = Math.min(100, Math.round((processedPartsCount / totalParts) * 100));
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const remaining = processedPartsCount > 0 ? ((totalParts - processedPartsCount) * (elapsed / processedPartsCount)).toFixed(1) : '...';
        
        // Update the message to include vehicle count
        progressCallback(percent, `Scraping... ${percent}% (${processedPartsCount}/${totalParts} parts, ${totalVehiclesProcessed} vehicles) | Elapsed: ${elapsed}s | Remaining: ~${remaining}s`);
      }, 1000);

      // Start all worker loops concurrently
      const workerPromises = workers.map(worker => worker.workerLoop());
      await Promise.all(workerPromises); // Wait for all workers to complete their tasks
      
      clearInterval(progressInterval); // Clear progress interval
      progressCallback(100, `Scraping 100% complete.`);

      console.log("All scraping and batch dumping completed. Closing browsers...");

      // Close all browser instances
      await Promise.all(workers.map(worker => worker.close()));
      onForceRefresh(); // Trigger UI refresh if needed

      // Get final total vehicles processed for the completion message
      const finalTotalVehiclesProcessed = workers.reduce((sum, worker) => sum + worker.vehiclesProcessedCount, 0);
      return { message: `Scraping and saving completed for ${totalParts} parts, ${finalTotalVehiclesProcessed} vehicles.`, results: [] };
    } catch (err) {
      console.error('A critical error occurred in runWithProgress:', err);
      return { error: err.message };
    } finally {
      if (progressInterval) clearInterval(progressInterval);
      isScraping = false; // Release scrape lock
      console.log("Scraping process finished.");
    }
  }
};

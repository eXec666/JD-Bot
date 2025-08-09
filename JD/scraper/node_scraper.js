const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { v4: uuidv4 } = require('uuid');
const storage = require('node-persist');
const { app } = require('electron') || {};
const dataEntry = require('../db/data_entry_point'); // <-- unified DB funnel
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

puppeteer.use(StealthPlugin());

// ======================
// DNS Configuration
// ======================
const DNS_SERVERS = ['8.8.8.8', '1.1.1.1', '208.67.222.222', '9.9.9.9'];
dns.setServers(DNS_SERVERS);

// ======================
// User-Agent Rotation List
// ======================
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
];

// ======================
// Configuration
// ======================
const CONFIG = {
  baseUrl: 'https://partscatalog.deere.com',
  maxConcurrentInstances: Math.max(1, Math.floor(os.cpus().length / 2)),
  requestThrottle: { min: 1500, max: 3500 },

  browser: {
    headless: true,
    executablePath: null,
    userDataDirBase: path.join(process.cwd(), 'data', 'puppeteer_data'),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-gcm',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--lang=en-US,en',
      '--disable-features=TranslateUI,BlinkGenPropertyTrees'
    ],
    dumpio: true,
  },

  navigation: {
    timeout: 90000,
    waitUntil: 'networkidle2',
    taskTimeout: 150000,
    retries: 5,
    retryDelayBase: 5000,
    retryDelayMax: 60000,
  },

  debug: {
    saveScreenshots: true,
    screenshotPath: path.join(os.homedir(), 'gg-node-debug'),
  },

  proxy: {
    enabled: false,
    host: '118.193.58.115',
    port: '2334',
    username: 'ud78dbe07554805b1-zone-custom-region-eu',
    password: 'ud78dbe07554805b1'
  }
};

// --- Batch Processing Configuration for Nodes ---
const NODE_BATCH_SIZE = 100;

// --- State Management Configuration ---
const STATE_DIR_PATH = path.join(process.cwd(), 'data', 'scraper_state');
const STATE_FILE_NAME = 'scraper_state.json';

// ======================
// Helper Functions
// ======================
let sharedTaskQueue = [];
let totalTasksCount = 0;
let tasksProcessed = 0;
let isStopping = false; // Killswitch variable

function getNextTask() {
  if (isStopping) return null;
  const task = sharedTaskQueue.shift() || null;
  if (task) tasksProcessed++;
  return task;
}

async function saveState() {
  try {
    if (!fs.existsSync(STATE_DIR_PATH)) {
      fs.mkdirSync(STATE_DIR_PATH, { recursive: true });
    }
    await storage.init({ dir: STATE_DIR_PATH });
    await storage.setItem('sharedTaskQueue', sharedTaskQueue);
    await storage.setItem('tasksProcessed', tasksProcessed);
    await storage.setItem('totalTasksCount', totalTasksCount);
    console.log(`[STATE] Scraper state saved.`);
  } catch (err) {
    console.error(`[STATE ERROR] Failed to save state: ${err.message}`);
  }
}

async function loadState() {
  try {
    if (!fs.existsSync(STATE_DIR_PATH)) {
      console.log(`[STATE] State directory "${STATE_DIR_PATH}" does not exist. No state to load.`);
      return false;
    }
    await storage.init({ dir: STATE_DIR_PATH });
    const savedQueue = await storage.getItem('sharedTaskQueue');
    const savedProcessed = await storage.getItem('tasksProcessed');
    const savedTotal = await storage.getItem('totalTasksCount');
    if (savedQueue) {
      sharedTaskQueue = savedQueue;
      tasksProcessed = savedProcessed;
      totalTasksCount = savedTotal;
      console.log(`[STATE] Scraper state loaded. ${sharedTaskQueue.length} tasks remaining.`);
      return true;
    }
  } catch (err) {
    console.error(`[STATE ERROR] Failed to load state: ${err.message}`);
  }
  return false;
}

function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error(`Task timed out after ${ms / 1000}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]);
}

async function forceEnglishLanguage(page) {
  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setCookie({ name: 'selectedLocale', value: 'en_US', domain: '.partscatalog.deere.com', path: '/' });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      localStorage.setItem('language', 'en');
      localStorage.setItem('selectedLocale', 'en_US');
    });
  } catch (err) {
    console.warn('Warning: Could not force all English language settings.', err.message);
  }
}

// ======================
// Batch dump via Entry Point (nodes + links)
// ======================
function dumpNodesBatchThroughEntryPoint(nodesBatch) {
  if (!nodesBatch || nodesBatch.length === 0) return 0;

  // 1) Unique node_desc rows
  const seen = new Set();
  const nodeRows = [];
  for (const item of nodesBatch) {
    if (!item || item.error || !item.nodePath) continue;
    const key = item.nodePath;
    if (seen.has(key)) continue;
    seen.add(key);
    nodeRows.push({ node_id: null, node_desc: key });
  }

  if (nodeRows.length > 0) {
    dataEntry.dumpToDb('nodes', nodeRows);
  }

  // 2) Resolve node_ids and create link rows
  const linkRows = [];
  for (const item of nodesBatch) {
    if (!item || item.error || !item.nodePath) continue;
    const nodeId = dataEntry.getNodeIdByDesc(item.nodePath); // <-- requires helper in entry point
    if (!nodeId) continue;
    linkRows.push({
      part_id: item.partId,
      vehicle_id: item.vehicleId,
      node_id: nodeId
    });
  }

  if (linkRows.length > 0) {
    dataEntry.dumpToDb('part_vehicle_nodes', linkRows);
  }

  return linkRows.length;
}

// ======================
// Node Scraper Class
// ======================
class NodeScraper {
  constructor(instanceId) {
    this.instanceId = instanceId;
    this.browser = null;
    this.page = null;
    this.results = [];
    this.currentNodesBatch = [];
    this.nodesProcessedCount = 0;
    this.userDataDir = path.join(CONFIG.browser.userDataDirBase, `instance-${instanceId}`);
  }

  async initialize() {
    // Prefer Puppeteer's own detection
    CONFIG.browser.executablePath = puppeteer.executablePath();

    // Fallback via chrome-launcher
    if (!CONFIG.browser.executablePath) {
      try {
        const { Launcher } = await import('chrome-launcher');
        const installations = Launcher.getInstallations();
        CONFIG.browser.executablePath = installations[0];
      } catch (e) {
        console.warn('Failed to load chrome-launcher:', e.message);
      }
    }

    // Manual fallbacks
    if (!CONFIG.browser.executablePath) {
      const commonPaths = [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      ];
      for (const p of commonPaths) {
        if (fs.existsSync(p)) {
          CONFIG.browser.executablePath = p;
          break;
        }
      }
    }

    if (!CONFIG.browser.executablePath) {
      throw new Error("No Chrome/Chromium executable found. Please ensure Chrome is installed.");
    }

    if (fs.existsSync(this.userDataDir)) {
      fs.rmSync(this.userDataDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.userDataDir, { recursive: true });

    const browserArgs = [...CONFIG.browser.args];
    if (CONFIG.proxy.enabled) {
      const proxyServer = `${CONFIG.proxy.host}:${CONFIG.proxy.port}`;
      browserArgs.push(`--proxy-server=${proxyServer}`);
      console.log(`[Instance ${this.instanceId}] Using proxy: ${proxyServer}`);
    }

    this.browser = await puppeteer.launch({
      executablePath: CONFIG.browser.executablePath,
      headless: CONFIG.browser.headless,
      args: browserArgs,
      userDataDir: this.userDataDir,
      dumpio: CONFIG.browser.dumpio
    });

    this.page = await this.browser.newPage();

    if (CONFIG.proxy.enabled && CONFIG.proxy.username && CONFIG.proxy.password) {
      await this.page.authenticate({
        username: CONFIG.proxy.username,
        password: CONFIG.proxy.password
      });
      console.log(`[Instance ${this.instanceId}] Proxy authentication configured.`);
    }

    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    await this.page.setUserAgent(randomUserAgent);

    console.log(`[Instance ${this.instanceId}] Browser initialized with User-Agent: ${randomUserAgent}`);
  }

  async scrapeNode(task) {
    const { partNumber, equipmentRefId, partId, vehicleId } = task;
    const debugId = `${this.instanceId}-${uuidv4().substr(0, 4)}`;

    try {
      await forceEnglishLanguage(this.page);
      const nodeUrl = `${CONFIG.baseUrl}/jdrc/search/type/parts/equipment/${encodeURIComponent(equipmentRefId)}/term/${encodeURIComponent(partNumber)}`;
      console.log(`[${debugId}] Navigating to: ${nodeUrl}`);

      const responsePromise = this.page.waitForResponse(
        response => response.url().includes('/jdrc-services/v1/search/parts'),
        { timeout: CONFIG.navigation.timeout }
      );
      await this.page.goto(nodeUrl, { waitUntil: 'networkidle2', timeout: CONFIG.navigation.timeout });
      const apiResponse = await responsePromise;

      if (apiResponse.status() === 403) {
        throw new Error('HTTP_403_FORBIDDEN');
      }

      let responseData;
      try {
        responseData = await apiResponse.json();
      } catch (parseError) {
        const responseText = await apiResponse.text();
        console.error(`[${debugId}] FAILED TO PARSE RESPONSE AS JSON for ${partNumber}. Status: ${apiResponse.status()}.`);
        console.error(`[${debugId}] RAW RESPONSE TEXT (first 500 chars):`, responseText.substring(0, 500));
        throw new Error('API response was not valid JSON or was empty.');
      }

      if (!responseData) {
        throw new Error('API response parsed to a null or undefined object.');
      }

      const nodePath = responseData?.searchResults?.[0]?.partLocationPath;
      if (nodePath == null) {
        console.error(`[${debugId}] Node path is null/undefined in the API response for ${partNumber}.`);
        console.error(`[${debugId}] Parsed API Response:`, JSON.stringify(responseData, null, 2));
        throw new Error('Node path is null or undefined in API response.');
      }

      return { partId, vehicleId, nodePath, error: null };
    } catch (err) {
      console.error(`[${debugId}] FAILED task for ${partNumber}: ${err.message}`);
      await this.captureErrorScreenshot(debugId);
      return { partId, vehicleId, nodePath: null, error: err.message };
    }
  }

  async captureErrorScreenshot(debugId) {
    if (CONFIG.debug.saveScreenshots && this.page && !this.page.isClosed()) {
      try {
        if (!fs.existsSync(CONFIG.debug.screenshotPath)) {
          fs.mkdirSync(CONFIG.debug.screenshotPath, { recursive: true });
        }
        const screenshotPath = path.join(CONFIG.debug.screenshotPath, `error-${debugId}-${Date.now()}.png`);
        await this.page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`[${debugId}] Saved error screenshot to: ${screenshotPath}`);
      } catch (screenshotErr) {
        console.error(`[${debugId}] Failed to save screenshot:`, screenshotErr.message);
      }
    }
  }

  async workerLoop() {
    let tasksCompletedInSession = 0;
    while (!isStopping) {
      const task = getNextTask();
      if (!task) {
        console.log(`[Instance ${this.instanceId}] No more tasks. Worker shutting down.`);
        break;
      }

      let attempt = 0;
      const maxAttempts = CONFIG.navigation.retries + 1;
      let scrapedResult = null;

      while (attempt < maxAttempts) {
        attempt++;
        try {
          scrapedResult = await withTimeout(this.scrapeNode(task), CONFIG.navigation.taskTimeout);
          tasksCompletedInSession++;
          break;
        } catch (error) {
          console.error(
            `[Instance ${this.instanceId}] Attempt ${attempt}/${maxAttempts} failed for task ${task.partNumber}: ${error.message}`
          );

          if (error.message === 'HTTP_403_FORBIDDEN' && attempt < maxAttempts) {
            const delay = Math.min(
              CONFIG.navigation.retryDelayMax,
              CONFIG.navigation.retryDelayBase * (2 ** (attempt - 1)) + Math.floor(Math.random() * 2000)
            );
            console.warn(`[Instance ${this.instanceId}] Encountered 403. Retrying after a longer backoff of ${delay}ms...`);
            await this.ensurePageIsClean();
            await sleep(delay);
            continue;
          }

          if (attempt >= maxAttempts) {
            scrapedResult = { partId: task.partId, vehicleId: task.vehicleId, nodePath: null, error: error.message };
          } else {
            await this.ensurePageIsClean();
            await sleep(CONFIG.navigation.retryDelayBase);
          }
        }
      }

      this.results.push(scrapedResult);

      if (scrapedResult && !scrapedResult.error) {
        this.currentNodesBatch.push(scrapedResult);
        if (this.currentNodesBatch.length >= NODE_BATCH_SIZE) {
          const processedCount = dumpNodesBatchThroughEntryPoint(this.currentNodesBatch);
          this.nodesProcessedCount += processedCount;
          this.currentNodesBatch = [];
        }
      }

      const dynamicDelay = CONFIG.requestThrottle.min
        + Math.random() * (CONFIG.requestThrottle.max - CONFIG.requestThrottle.min);
      if (!isStopping) {
        await sleep(dynamicDelay);
      }
    }

    const remainingProcessed = dumpNodesBatchThroughEntryPoint(this.currentNodesBatch);
    this.nodesProcessedCount += remainingProcessed;
    this.currentNodesBatch = [];
    console.log(`[Instance ${this.instanceId}] Gracefully shut down.`);
  }

  async ensurePageIsClean() {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.goto('about:blank', { timeout: 5000 });
      } else {
        this.page = await this.browser.newPage();
      }
    } catch (e) {
      console.warn(`[Instance ${this.instanceId}] Failed to clean page, creating new one.`);
      if (this.page) await this.page.close().catch(() => {});
      this.page = await this.browser.newPage();
    }
  }

  async close() {
    if (this.browser) await this.browser.close().catch(e => console.error('Browser close error:', e));
  }
}

// ======================
// Main Scraping Function
// ======================
async function runWithProgress(progressCallback = () => {}, specificTasks = null) {
  console.log('🚀 Node scraper starting with unified DB entry point...');
  const startTime = Date.now();
  let workers = [];

  try {
    // ---------- NEW bootstrapping logic (resume or fresh fetch) ----------
    let tasks = [];

    // Try to resume from saved state
    const resumed = await loadState();
    if (resumed && Array.isArray(sharedTaskQueue) && sharedTaskQueue.length > 0) {
      tasks = sharedTaskQueue;
      totalTasksCount = tasks.length; // ensure this is set on resume
      console.log(`[STATE] Resuming scraping. ${tasks.length} tasks remain.`);
    } else {
      // If we had an empty saved state, clear it so it won't block future runs
      if (resumed) {
        try {
          await storage.init({ dir: STATE_DIR_PATH });
          await storage.clear();
          console.log('[STATE] Found empty saved state; cleared.');
        } catch (e) {
          console.warn('[STATE] Could not clear empty state:', e.message);
        }
      }

      // Fresh fetch of pending tasks via the entry point (READ through unified funnel)
      tasks = specificTasks || dataEntry.query(`
        SELECT p.part_id            AS partId,
               p.part_number        AS partNumber,
               v.vehicle_id         AS vehicleId,
               v.equipment_ref_id   AS equipmentRefId
        FROM compatibility c
        JOIN parts p   ON c.part_id = p.part_id
        JOIN vehicles v ON c.vehicle_id = v.vehicle_id
        LEFT JOIN part_vehicle_nodes pvn 
               ON pvn.part_id = p.part_id AND pvn.vehicle_id = v.vehicle_id
        WHERE pvn.pvn_id IS NULL
      `);

      sharedTaskQueue = Array.isArray(tasks) ? [...tasks] : [];
      totalTasksCount = sharedTaskQueue.length;

      console.log(`📋 Loaded ${totalTasksCount} pending node tasks from DB.`);
    }
    // --------------------------------------------------------------------

    if (sharedTaskQueue.length === 0) {
      console.log("✅ No pending tasks found.");
      progressCallback(100, "Completed - No tasks to process.");
      return { message: "No pending tasks." };
    }

    console.log(`📋 Found ${totalTasksCount} total tasks. Launching ${CONFIG.maxConcurrentInstances} workers.`);
    console.log(`📋 ${sharedTaskQueue.length} tasks pending from start or loaded state.`);

    workers = await Promise.all(
      Array.from({ length: CONFIG.maxConcurrentInstances }).map(async (_, idx) => {
        const scraper = new NodeScraper(idx + 1);
        await scraper.initialize();
        return scraper;
      })
    );

    let lastProgress = 0;
    const progressInterval = setInterval(async () => {
      const percent = Math.min(100, Math.round((tasksProcessed / totalTasksCount) * 100));
      const totalNodesProcessed = workers.reduce((sum, worker) => sum + worker.nodesProcessedCount, 0);

      if (percent > lastProgress) {
        progressCallback(
          percent,
          `Processing nodes... ${percent}% (${tasksProcessed}/${totalTasksCount} tasks, ${totalNodesProcessed} nodes saved)`
        );
        lastProgress = percent;
        // ---------- NEW guard so we don't save empty state ----------
        if (totalTasksCount > 0) {
          await saveState();
        }
        // ------------------------------------------------------------
      }
      if (isStopping) {
        clearInterval(progressInterval);
      }
    }, 5000);

    await Promise.all(workers.map(worker => worker.workerLoop()));
    clearInterval(progressInterval);

    const allResults = workers.flatMap(worker => worker.results);
    const successCount = allResults.filter(r => r && r.error === null).length;
    const errorCount = allResults.filter(r => r && r.error !== null).length;
    const finalTotalNodesProcessed = workers.reduce((sum, worker) => sum + worker.nodesProcessedCount, 0);

    console.log(`Node scraping finished. Success: ${successCount}/${totalTasksCount} tasks, Errors: ${errorCount} tasks. Total nodes saved: ${finalTotalNodesProcessed}`);
    progressCallback(100, `Scraping finished. Success: ${successCount}/${totalTasksCount} tasks. Total nodes saved: ${finalTotalNodesProcessed}`);

    if (!isStopping && tasksProcessed === totalTasksCount) {
      await storage.init({ dir: STATE_DIR_PATH });
      await storage.clear();
      console.log("[STATE] Scraper state cleared as all tasks completed.");
    }

    return {
      message: `Scraping finished.`,
      results: allResults,
      totalNodesSaved: finalTotalNodesProcessed
    };

  } catch (error) {
    console.error('FATAL ERROR in runWithProgress:', error);
    progressCallback(100, `Fatal Error: ${error.message}`);
    await saveState();
    return { error: error.message };
  } finally {
    if (isStopping) {
      console.log("Shutdown initiated, performing final state save and cleanup.");
      await saveState();
    }
    console.log('🏁 Closing all browser instances...');
    await Promise.all(workers.map(w => w.close()));
    console.log(' Scraping run finished.');
  }
}


// ======================
// Killswitch Signal Handler
// ======================
async function handleShutdown() {
  console.log("Shutdown signal received. Initiating graceful shutdown...");
  isStopping = true;
}
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

module.exports = { runWithProgress };

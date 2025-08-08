/**
 * vehicle_scraper.js
 * Scrapes vehicles for given part numbers.
 * This module does NOT write to DB. It only returns plain objects.
 * entry_point.js handles all DB writes to keep dumping logic centralized.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const ExcelJS = require('exceljs');
const { app } = require('electron');

// Configuration for target site
const CONFIG = {
  baseUrl: 'https://partscatalog.deere.com/jdrc/search/type/parts/term/',
  navigation: {
    timeout: 45000,
    waitUntil: ['domcontentloaded', 'networkidle0'],
  },
  maxConcurrentInstances: 2,
};

/* --------------------------------------
   Browser helpers
--------------------------------------- */
function resolveChromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

async function launchIsolatedBrowser(workerIndex) {
  const executablePath = resolveChromePath();
  if (!executablePath) {
    throw new Error('Chrome/Chromium not found. Set PUPPETEER_EXECUTABLE_PATH.');
  }
  const userDataDir = path.join(
    (app && app.getPath ? app.getPath('userData') : os.tmpdir()),
    `puppeteer_w${workerIndex || 0}`
  );

  return puppeteer.launch({
    headless: true,
    executablePath,
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  });
}

/* --------------------------------------
   Core extraction for one part on an existing page
--------------------------------------- */
async function fetchVehiclesForPart(page, partNumber) {
  const url = CONFIG.baseUrl + encodeURIComponent(String(partNumber));
  await page.goto(url, { timeout: CONFIG.navigation.timeout, waitUntil: CONFIG.navigation.waitUntil });

  // TODO: Replace selectors below with the real ones you already use.
  // The function must return:
  // - vehicles: [{ vehicle_name, equipment_ref_id }]
  // - compatibility: [{ part_number, equipment_ref_id, vehicle_name? }]
  // If the page returns no results, return empty arrays.

  // Example stub; adapt to your DOM:
  const items = await page.evaluate(() => {
    // Replace the query selectors below with actual site selectors
    const cards = Array.from(document.querySelectorAll('[data-vehicle-card]'));
    return cards.map((c) => ({
      vehicle_name: c.querySelector('.title')?.textContent?.trim() || '',
      equipment_ref_id: c.getAttribute('data-eqid') || '',
    }));
  });

  const vehicles = [];
  const compatibility = [];

  for (const it of items) {
    const equipment_ref_id = String(it.equipment_ref_id || '').trim();
    if (!equipment_ref_id) continue;
    vehicles.push({
      vehicle_name: String(it.vehicle_name || '').trim(),
      equipment_ref_id,
    });
    compatibility.push({
      part_number: String(partNumber),
      equipment_ref_id,
      vehicle_name: String(it.vehicle_name || '').trim(),
    });
  }

  return { vehicles, compatibility };
}

/* --------------------------------------
   Batch runner used by entry_point.runVehicles
--------------------------------------- */
async function scrapeVehicleBatch(partNumbers, onProgress) {
  // Launch one browser, reuse one page for simplicity and stability.
  // For higher throughput, you can open multiple pages per browser or multiple browsers,
  // but start with one to avoid Windows profile locking issues.
  const browser = await launchIsolatedBrowser(0);
  let page = null;
  try {
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(CONFIG.navigation.timeout);

    const vehicles = [];
    const compatibility = [];

    for (const pn of partNumbers) {
      try {
        const res = await fetchVehiclesForPart(page, pn);
        if (Array.isArray(res.vehicles)) vehicles.push(...res.vehicles);
        if (Array.isArray(res.compatibility)) compatibility.push(...res.compatibility);
      } catch (err) {
        console.error(`Vehicle scrape failed for ${pn}:`, err.message);
      } finally {
        try {
          onProgress && onProgress(1);
        } catch (_) {}
      }
    }

    return { vehicles, compatibility };
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = {
  scrapeVehicleBatch,
  fetchVehiclesForPart, // exported for testing/custom orchestration
  launchIsolatedBrowser, // exported for advanced use
};

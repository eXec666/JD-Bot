document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const partInput = document.getElementById('partNumberInput');
  const searchResults = document.getElementById('searchResults'); // if not present, we guard below
  const queryPartBtn = document.getElementById('queryPartBtn');
  const startScraperBtn = document.getElementById('startScraperBtn');
  const wipeDbBtn = document.getElementById('wipeDbBtn');
  const selectFileBtn = document.getElementById('selectFileBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');
  const scrapeNodesBtn = document.getElementById('scrapeNodesBtn');
  const openDbBtn = document.getElementById('openDbBtn');

  // DB progress elements
  const dbSection = document.getElementById('db-dump-section');
  const dbBar = document.getElementById('db-progress-bar');
  const dbLabel = document.getElementById('db-progress-label');
  const dbMeta = document.getElementById('db-progress-meta');

  // State variables
  let debounceTimer;
  let selectedFilePath = null;

  // ======================
  // Helper Functions
  // ======================
  function showNotification(message, isError = false) {
    const note = document.createElement('div');
    note.className = `notification ${isError ? 'error' : ''}`;
    note.textContent = message;
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 3000);
  }

  function createModal(title, contentHTML, closeCallback = null) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.innerHTML = `
      <h2>${title}</h2>
      ${contentHTML}
      <button class="modal-close-btn">Close</button>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    // Close button handler
    content.querySelector('.modal-close-btn').addEventListener('click', () => {
      document.body.removeChild(modal);
      if (closeCallback) closeCallback();
    });

    return modal;
  }

  // ======================
  // Search Functionality
  // ======================
  if (partInput) {
    partInput.addEventListener('focus', function () {
      this.select();
      if (searchResults) searchResults.style.display = 'none';
    });

    partInput.addEventListener('input', function (e) {
      clearTimeout(debounceTimer);
      const query = e.target.value.trim();

      if (!searchResults) return;

      if (query.length < 3) {
        searchResults.style.display = 'none';
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const result = await window.electronAPI.queryPartSuggestions(query);
          displayResults(result.suggestions);
        } catch (error) {
          console.error('Search error:', error);
          searchResults.style.display = 'none';
        }
      }, 300);
    });

    partInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        if (searchResults) searchResults.style.display = 'none';
        performSearch();
      }
    });
  }

  function displayResults(suggestions) {
    if (!searchResults) return;
    searchResults.innerHTML = '';
    if (suggestions.length > 0) {
      suggestions.forEach(suggestion => {
        const div = document.createElement('div');
        div.className = 'search-item';
        div.textContent = suggestion;
        div.addEventListener('click', () => {
          partInput.value = suggestion;
          searchResults.style.display = 'none';
          performSearch();
        });
        searchResults.appendChild(div);
      });
      searchResults.style.display = 'block';
    } else {
      searchResults.style.display = 'none';
    }
  }

  async function performSearch() {
    const partNumber = partInput.value.trim();
    if (!partNumber) return;

    try {
      const result = await window.electronAPI.queryPart(partNumber);
      if (result.error) throw new Error(result.error);

      showResultsModal(partNumber, result);
    } catch (error) {
      console.error('Search failed:', error);
      showNotification(`Error: ${error.message}`, true);
    }
  }

  function showResultsModal(partNumber, result) {
    createModal(
      `Compatibility Results for ${partNumber}`,
      `
        <p>Found ${result.totalUnique} compatible vehicles:</p>
        <ul class="vehicle-list">
          ${result.rows.map(row => `
            <li class="vehicle-item" 
                data-vehicle-id="${row.vehicle_id}" 
                data-part-number="${partNumber}">
              ${row.vehicle_name} (${row.cnt} matches)
            </li>
          `).join('')}
        </ul>
      `,
      () => partInput.focus()
    );

    // Add click handlers for vehicle items
    document.querySelectorAll('.vehicle-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const vehicleId = e.currentTarget.dataset.vehicleId;
        const partNumber = e.currentTarget.dataset.partNumber;
        showNodeDetails(partNumber, vehicleId);
      });
    });
  }

  // ======================
  // Node Details
  // ======================
  async function showNodeDetails(partNumber, vehicleId) {
    const loadingModal = createModal(
      'Loading Node Details',
      '<div class="loader"></div>'
    );

    try {
      const result = await window.electronAPI.getNodeDetails(partNumber, vehicleId);
      document.body.removeChild(loadingModal);

      if (result.error) throw new Error(result.error);

      createModal(
        'Node Details',
        `
          <p><strong>Part:</strong> ${partNumber}</p>
          <p><strong>Vehicle:</strong> ${result.vehicleName}</p>
          <div class="node-list">
            ${result.nodes.length > 0
              ? result.nodes.map(node => `<div class="node-item">${node}</div>`).join('')
              : '<p>No nodes found</p>'}
          </div>
        `
      );
    } catch (error) {
      document.body.removeChild(loadingModal);
      console.error('Failed to get node details:', error);
      showNotification(`Error: ${error.message}`, true);
    }
  }

  function displayTableData(data) {
    createModal(
      'Database Table Data',
      `
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Part Number</th>
                <th>Equipment Ref ID</th>
                <th>Node Path</th>
              </tr>
            </thead>
            <tbody>
              ${data.map(row => `
                <tr>
                  <td>${row.partNumber || 'N/A'}</td>
                  <td>${row.equipmentRefId || 'N/A'}</td>
                  <td>${row.nodePath || 'N/A'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <p class="table-meta">Showing ${data.length} records</p>
      `
    );
  }

  // ======================
  // Button Handlers
  // ======================
  if (queryPartBtn) {
    queryPartBtn.addEventListener('click', performSearch);
  }

  if (startScraperBtn) {
    startScraperBtn.addEventListener('click', async () => {
      if (!window.selectedFilePath) {
        showNotification('Please select an Excel file first', true);
        return;
      }

      startScraperBtn.disabled = true;
      startScraperBtn.textContent = 'Scraping Vehicles...';

      try {
        const result = await window.electronAPI.scrapeVehicles(window.selectedFilePath);
        if (result.error) throw new Error(result.error);
        showNotification(result.message || 'Vehicle scraping completed!');
      } catch (err) {
        showNotification(`Error: ${err.message}`, true);
      } finally {
        startScraperBtn.disabled = false;
        startScraperBtn.textContent = 'Start Scraper';
      }
    });
  }

  // Listen for DB dump progress and update the second bar
  if (window.electronAPI?.onDbDumpProgress && dbSection && dbBar && dbLabel && dbMeta) {
    const unsubscribeDb = window.electronAPI.onDbDumpProgress(({ table, done, total, percent }) => {
      if (dbSection.style.display === 'none') dbSection.style.display = 'block';
      const p = Math.max(0, Math.min(100, Number(percent) || 0));
      dbBar.style.width = `${p}%`;
      dbLabel.textContent = `${p}%`;
      dbMeta.textContent = `${done} / ${total} rows • ${table}`;
    });
    window.addEventListener('beforeunload', () => unsubscribeDb && unsubscribeDb());
  }

  if (wipeDbBtn) {
    wipeDbBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to wipe the database?')) {
        window.electronAPI.wipeDb()
          .then(message => showNotification(message))
          .catch(err => showNotification(`Error: ${err.message}`, true));
      }
    });
  }

  if (selectFileBtn) {
    selectFileBtn.addEventListener('click', async () => {
      try {
        const filePath = await window.electronAPI.selectExcelFile();
        if (filePath) {
          document.getElementById('filePathDisplay').textContent =
            `Selected: ${filePath.split('\\').pop()}`;
          window.selectedFilePath = filePath;
          if (startScraperBtn) startScraperBtn.disabled = false;
        } else {
          showNotification('No file selected');
        }
      } catch (err) {
        showNotification(`Error selecting file: ${err.message}`);
      }
    });
  }

  if (openDbBtn) {
    openDbBtn.addEventListener('click', () => {
      window.electronAPI.openDbViewer();
    });
  }

  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener('click', async () => {
      downloadCsvBtn.disabled = true;
      downloadCsvBtn.textContent = 'Generating CSV...';

      try {
        const result = await window.electronAPI.downloadCsv();
        if (result.error) throw new Error(result.error);

        showNotification(result.message || `CSV files saved to: ${result.directory}`);
        window.electronAPI.openFolder(result.directory);
      } catch (error) {
        showNotification(`Error: ${error.message}`, true);
      } finally {
        downloadCsvBtn.disabled = false;
        downloadCsvBtn.textContent = 'Download CSV';
      }
    });
  }

  if (scrapeNodesBtn) {
    scrapeNodesBtn.addEventListener('click', async () => {
      scrapeNodesBtn.disabled = true;
      scrapeNodesBtn.textContent = 'Scraping Nodes...';

      try {
        const result = await window.electronAPI.scrapeNodes();
        if (result.error) throw new Error(result.error);
        showNotification(result.message || 'Node scraping completed!');
      } catch (error) {
        showNotification(`Error: ${error.message}`, true);
      } finally {
        scrapeNodesBtn.disabled = false;
        scrapeNodesBtn.textContent = 'Scrape Nodes';
      }
    });
  }

  // ======================
  // Primary scrape progress (original bar)
  // ======================
  if (window.electronAPI?.onProgress) {
    window.electronAPI.onProgress((percent, message) => {
      const progressBar = document.querySelector('#progressBar div');
      if (progressBar) {
        progressBar.style.width = `${percent}%`;
        progressBar.style.backgroundColor = percent === 100 ? '#4CAF50' : '#4285f4';
        progressBar.textContent = `${percent}%`;

        if (message) {
          const progressText = document.querySelector('#progressBar p'); // optional text node
          if (progressText) progressText.textContent = message;
        }
      }
    });
  }
});

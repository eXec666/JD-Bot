// renderer.js
document.addEventListener('DOMContentLoaded', () => {
  // --- Tabs & panels ---
  const topTabs = document.querySelectorAll('#topTabs button');
  const panels = {
    main: document.getElementById('main'),
    db:   document.getElementById('db'),
    logs: document.getElementById('logs'),
  };

  topTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      // Activate tab button
      topTabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Show corresponding panel
      Object.values(panels).forEach(p => p.classList.remove('active'));
      const tab = btn.dataset.tab;
      panels[tab].classList.add('active');
      // If opening DB tab, init its renderer
      if (tab === 'db') window.dbViewerRenderer.init();
    });
  });

  // --- DOM Elements ---
  // Main
  const partInput         = document.getElementById('partNumberInput');
  const queryPartBtn      = document.getElementById('queryPartBtn');
  const selectFileBtn     = document.getElementById('selectFileBtn');
  const startTechniqueBtn = document.getElementById('startTechniqueBtn');
  const startNodesBtn     = document.getElementById('startNodesBtn');
  const filePathDisplay   = document.getElementById('filePathDisplay');
  const progressBar       = document.querySelector('#progressBar > div');

  // DB
  const wipeDbBtn     = document.getElementById('wipeDbBtn');
  const openDbBtn     = document.getElementById('openDbBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');

  // Logs
  const logsWindow   = document.getElementById('logsWindow');
  const scrollDownBtn = document.getElementById('scrollDownBtn');


  // --- State ---
  let selectedFilePath = null;
  let autoScroll       = true;

  // --- Logging ---
  function appendLog({ level, msg, ts }) {
    const line = document.createElement('div');
    line.textContent = `[${ts}] ${msg}`;
    line.style.color = level === 'error' ? 'red' : '#888';
    logsWindow.appendChild(line);
    if (autoScroll) logsWindow.scrollTop = logsWindow.scrollHeight;
  }
  window.electronAPI.onLog(appendLog);

  logsWindow.addEventListener('scroll', () => {
    const atBottom = logsWindow.scrollTop + logsWindow.clientHeight 
                   >= logsWindow.scrollHeight - 5;
    autoScroll = atBottom;
    scrollDownBtn.style.display = atBottom ? 'none' : 'block';
  });
  scrollDownBtn.addEventListener('click', () => {
    logsWindow.scrollTop = logsWindow.scrollHeight;
    autoScroll = true;
    scrollDownBtn.style.display = 'none';
  });


  // --- Helpers ---
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
    content.querySelector('.modal-close-btn')
           .addEventListener('click', () => {
      document.body.removeChild(modal);
      if (closeCallback) closeCallback();
    });
    return modal;
  }

  // --- Compatibility Query ---
  queryPartBtn.addEventListener('click', performSearch);

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
          ${result.rows.map(r => `
            <li class="vehicle-item" data-vehicle-id="${r.vehicle_id}"
                data-part-number="${partNumber}">
              ${r.vehicle_name} (${r.cnt} matches)
            </li>
          `).join('')}
        </ul>
      `,
      () => partInput.focus()
    );
    document.querySelectorAll('.vehicle-item').forEach(item => {
      item.addEventListener('click', e => {
        showNodeDetails(
          e.currentTarget.dataset.partNumber,
          e.currentTarget.dataset.vehicleId
        );
      });
    });
  }

  async function showNodeDetails(partNumber, vehicleId) {
    const loading = createModal('Loading Node Details', '<div class="loader"></div>');
    try {
      const result = await window.electronAPI.getNodeDetails(partNumber, vehicleId);
      document.body.removeChild(loading);
      if (result.error) throw new Error(result.error);
      createModal(
        'Node Details',
        `
          <p><strong>Part:</strong> ${partNumber}</p>
          <p><strong>Vehicle:</strong> ${result.vehicleName}</p>
          <div class="node-list">
            ${result.nodes.length
              ? result.nodes.map(n => `<div class="node-item">${n}</div>`).join('')
              : '<p>No nodes found</p>'}
          </div>
        `
      );
    } catch (err) {
      document.body.removeChild(loading);
      console.error(err);
      showNotification(`Error: ${err.message}`, true);
    }
  }

  // --- File / Scrape Buttons (Главное меню) ---
  selectFileBtn.addEventListener('click', async () => {
    try {
      const fp = await window.electronAPI.selectExcelFile();
      if (fp) {
        selectedFilePath = fp;
        filePathDisplay.textContent = `Selected: ${fp.split('\\').pop()}`;
        startTechniqueBtn.disabled = false;
      } else {
        showNotification('No file selected');
      }
    } catch (err) {
      showNotification(`Error: ${err.message}`, true);
    }
  });

  startTechniqueBtn.addEventListener('click', async () => {
    if (!selectedFilePath) {
      showNotification('Please select an Excel file first', true);
      return;
    }
    startTechniqueBtn.disabled = true;
    startTechniqueBtn.textContent = 'Запуск техники...';
    try {
      const res = await window.electronAPI.scrapeVehicles(selectedFilePath);
      if (res.error) throw new Error(res.error);
      showNotification(res.message || 'Completed!');
    } catch (err) {
      showNotification(`Error: ${err.message}`, true);
    } finally {
      startTechniqueBtn.disabled = false;
      startTechniqueBtn.textContent = 'Запустить технику';
    }
  });

  startNodesBtn.addEventListener('click', async () => {
    startNodesBtn.disabled = true;
    startNodesBtn.textContent = 'Запуск узлов...';
    try {
      const res = await window.electronAPI.scrapeNodes();
      if (res.error) throw new Error(res.error);
      showNotification(res.message || 'Completed!');
    } catch (err) {
      showNotification(`Error: ${err.message}`, true);
    } finally {
      startNodesBtn.disabled = false;
      startNodesBtn.textContent = 'Запустить узлы';
    }
  });

  // --- DB Tab Buttons ---
  wipeDbBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to wipe the database?')) {
      try {
        await window.electronAPI.resetDatabase();
        showNotification('Database wiped');
        window.dbViewerRenderer.init();
      } catch (err) {
        showNotification(`Error: ${err.message}`, true);
      }
    }
  });

  openDbBtn.addEventListener('click', () => {
    window.electronAPI.openDatabase();
  });

  downloadCsvBtn.addEventListener('click', async () => {
    downloadCsvBtn.disabled = true;
    downloadCsvBtn.textContent = 'CSV...';
    try {
      const res = await window.electronAPI.exportDatabaseCsv();
      if (res.error) throw new Error(res.error);
      showNotification(res.message || 'CSV saved');
      window.electronAPI.openFolder(res.directory);
    } catch (err) {
      showNotification(`Error: ${err.message}`, true);
    } finally {
      downloadCsvBtn.disabled = false;
      downloadCsvBtn.textContent = 'CSV';
    }
  });

  // --- Progress Updates ---
  window.electronAPI.onProgress(( percent, message ) => {
    progressBar.style.width = `${percent}%`;
    progressBar.textContent = `${percent}%`;
  });
});

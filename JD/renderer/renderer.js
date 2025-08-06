document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const partInput = document.getElementById('partNumberInput');
  const searchResults = document.getElementById('searchResults');
  const queryPartBtn = document.getElementById('queryPartBtn');
  const startScraperBtn = document.getElementById('startScraperBtn');
  const wipeDbBtn = document.getElementById('wipeDbBtn');
  const selectFileBtn = document.getElementById('selectFileBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');
  const scrapeNodesBtn = document.getElementById('scrapeNodesBtn');
  const openDbBtn = document.getElementById('openDbBtn');

  const mainMenu = document.getElementById('mainMenu');
  const dbViewer = document.getElementById('dbViewer');
  const dbContent = document.getElementById('dbContent');
  const dbBackBtn = document.getElementById('dbBackBtn');

  let debounceTimer;

  // ======================
  // UI Switching
  // ======================
  function switchToDbView() {
    mainMenu.style.display = 'none';
    dbViewer.style.display = 'block';
  }

  function switchToMainMenu() {
    dbViewer.style.display = 'none';
    mainMenu.style.display = 'block';
  }

  dbBackBtn.addEventListener('click', switchToMainMenu);

  // ======================
  // Notification
  // ======================
  function showNotification(message, isError = false) {
    const note = document.createElement('div');
    note.className = `notification ${isError ? 'error' : ''}`;
    note.textContent = message;
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 3000);
  }

  // ======================
  // Modal
  // ======================
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

    content.querySelector('.modal-close-btn').addEventListener('click', () => {
      document.body.removeChild(modal);
      if (closeCallback) closeCallback();
    });

    return modal;
  }

  // ======================
  // Search Logic
  // ======================
  partInput.addEventListener('focus', function () {
    this.select();
    searchResults.style.display = 'none';
  });

  partInput.addEventListener('input', function (e) {
    clearTimeout(debounceTimer);
    const query = e.target.value.trim();

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
      searchResults.style.display = 'none';
      performSearch();
    }
  });

  function displayResults(suggestions) {
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
      `Совместимость: ${partNumber}`,
      `
        <p>Найдено ${result.totalUnique} подходящих ТС:</p>
        <ul class="vehicle-list">
          ${result.rows.map(row => `
            <li class="vehicle-item" 
                data-vehicle-id="${row.vehicle_id}" 
                data-part-number="${partNumber}">
              ${row.vehicle_name} (${row.cnt} совпадений)
            </li>
          `).join('')}
        </ul>
      `,
      () => partInput.focus()
    );

    document.querySelectorAll('.vehicle-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const vehicleId = e.currentTarget.dataset.vehicleId;
        const partNumber = e.currentTarget.dataset.partNumber;
        showNodeDetails(partNumber, vehicleId);
      });
    });
  }

  async function showNodeDetails(partNumber, vehicleId) {
    const loadingModal = createModal(
      'Загрузка узлов',
      '<div class="loader"></div>'
    );

    try {
      const result = await window.electronAPI.getNodeDetails(partNumber, vehicleId);
      document.body.removeChild(loadingModal);

      if (result.error) throw new Error(result.error);

      createModal(
        'Узлы',
        `
          <p><strong>Артикул:</strong> ${partNumber}</p>
          <p><strong>ТС:</strong> ${result.vehicleName}</p>
          <div class="node-list">
            ${result.nodes.length > 0
              ? result.nodes.map(node => `<div class="node-item">${node}</div>`).join('')
              : '<p>Нет узлов</p>'}
          </div>
        `
      );
    } catch (error) {
      document.body.removeChild(loadingModal);
      console.error('Failed to get node details:', error);
      showNotification(`Error: ${error.message}`, true);
    }
  }

  // ======================
  // DB View (in-app)
  // ======================
  openDbBtn.addEventListener('click', async () => {
    switchToDbView();

    dbContent.innerHTML = '<div class="loader"></div>';

    try {
      const result = await window.electronAPI.getTableData();
      if (!result.success) throw new Error(result.error);

      dbContent.innerHTML = `
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Артикул</th>
                <th>Ref ID</th>
                <th>Путь</th>
              </tr>
            </thead>
            <tbody>
              ${result.data.map(row => `
                <tr>
                  <td>${row.partNumber || '—'}</td>
                  <td>${row.equipmentRefId || '—'}</td>
                  <td>${row.nodePath || '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <p class="table-meta">Всего записей: ${result.data.length}</p>
      `;
    } catch (error) {
      dbContent.innerHTML = '';
      console.error('Ошибка загрузки таблицы:', error);
      showNotification(`Ошибка: ${error.message}`, true);
    }
  });

  // ======================
  // Buttons
  // ======================
  queryPartBtn.addEventListener('click', performSearch);

  selectFileBtn.addEventListener('click', async () => {
    try {
      const filePath = await window.electronAPI.selectExcelFile();
      if (filePath) {
        document.getElementById('filePathDisplay').textContent =
          `Выбран: ${filePath.split('\\').pop()}`;
        window.selectedFilePath = filePath;
        startScraperBtn.disabled = false;
      } else {
        showNotification('Файл не выбран');
      }
    } catch (err) {
      showNotification(`Ошибка выбора файла: ${err.message}`);
    }
  });

  startScraperBtn.addEventListener('click', async () => {
    if (!window.selectedFilePath) {
      showNotification('Сначала выберите Excel файл', true);
      return;
    }

    startScraperBtn.disabled = true;
    startScraperBtn.textContent = 'Сбор данных...';

    try {
      const result = await window.electronAPI.scrapeVehicles(window.selectedFilePath);
      if (result.error) throw new Error(result.error);
      showNotification(result.message || 'Готово');
    } catch (err) {
      showNotification(`Ошибка: ${err.message}`, true);
    } finally {
      startScraperBtn.disabled = false;
      startScraperBtn.textContent = 'Запустить';
    }
  });

  scrapeNodesBtn.addEventListener('click', async () => {
    scrapeNodesBtn.disabled = true;
    scrapeNodesBtn.textContent = 'Сбор узлов...';

    try {
      const result = await window.electronAPI.scrapeNodes();
      if (result.error) throw new Error(result.error);
      showNotification(result.message || 'Готово');
    } catch (error) {
      showNotification(`Ошибка: ${error.message}`, true);
    } finally {
      scrapeNodesBtn.disabled = false;
      scrapeNodesBtn.textContent = 'Узлы';
    }
  });

  wipeDbBtn.addEventListener('click', () => {
    if (confirm('Сбросить базу данных?')) {
      window.electronAPI.wipeDb()
        .then(message => showNotification(message))
        .catch(err => showNotification(`Ошибка: ${err.message}`, true));
    }
  });

  // ======================
  // Progress Updates
  // ======================
  window.electronAPI.onProgress(({ percent, message }) => {
    const progressBar = document.querySelector('#progressBar div');
    if (progressBar) {
      progressBar.style.width = `${percent}%`;
      progressBar.style.backgroundColor = percent === 100 ? '#4CAF50' : '#4285f4';
      progressBar.textContent = `${percent}%`;

      const progressText = document.querySelector('#progressBar p');
      if (progressText && message) progressText.textContent = message;
    }
  });

  downloadCsvBtn.addEventListener('click', async () => {
    downloadCsvBtn.disabled = true;
    downloadCsvBtn.textContent = 'Создание CSV...';

    try {
      const result = await window.electronAPI.downloadCsv();
      if (result.error) throw new Error(result.error);
      showNotification(result.message || `CSV сохранён: ${result.directory}`);
      window.electronAPI.openFolder(result.directory);
    } catch (error) {
      showNotification(`Ошибка: ${error.message}`, true);
    } finally {
      downloadCsvBtn.disabled = false;
      downloadCsvBtn.textContent = 'CSV';
    }
  });
});

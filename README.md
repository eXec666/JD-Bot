<p align="center">
  <img src="gng_logo.png" alt="G&amp;G / JD-BOT" width="160">
</p>

<h1 align="center">JD-BOT</h1>

Небольшое внутреннее приложение на Electron. Ниже — быстрый старт, команды и структура проекта.

---

## Быстрый старт

> При желании установите расширение **Electron** для VS Code (необязательно, но удобно).

```bash
# 1) Установка зависимостей
npm install

# 2) Сборка приложения
npm run build

# 3) Если Electron установлен некорректно (исправление)
npm install --save-dev electron-builder
```
---

## Структура проекта

```
JD
├── JD_clean.xlsx
├── app.env
├── data
│   ├── build files
├── db
│   ├── csvExporter.js
│   ├── dbViewer.html
│   ├── dbViewerRenderer.js
│   ├── db_config.js
│   ├── db_manager.js
│   ├── db_utils.js
│   ├── parts.db
│   └── preloadDbViewer.js
├── dist/
├── jsconfig.json
├── main.js
├── node_modules/
├── package-lock.json
├── package.json
├── preload.js
├── renderer
│   ├── index.html
│   └── renderer.js
└── scraper
    ├── compat_query.js
    ├── entry_point.js
    ├── init_db.js
    ├── node_scraper.js
    └── vehicle_scraper.js
```
---

## Примечания

- Для сборки используйте стандартный сценарий `npm run build`.
- Если столкнулись с проблемами установки Electron, выполните команду из раздела «Быстрый старт» для `electron-builder`.

<p align="center">
  <sub>Логотип: <code>JD-BOT/gng_logo.png</code></sub>
</p>

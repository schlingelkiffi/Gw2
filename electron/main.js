// Desktop-Hülle: lädt die Web-App in ein eigenes Programmfenster.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const isHttp = (url) => /^https?:\/\//i.test(url);

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 950,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#15171c',
    title: 'GW2 Achievement Helper',
    icon: path.join(ROOT, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Externe Links (Wiki im Browser, account.arena.net …) im Standard-Browser öffnen.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isHttp(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadFile(path.join(ROOT, 'index.html'));
}

// Minimales Menü: Zurück/Vor, Neu laden, Zoom, Entwicklerwerkzeuge.
Menu.setApplicationMenu(Menu.buildFromTemplate([
  {
    label: 'View',
    submenu: [
      { label: 'Back', accelerator: 'Alt+Left', click: (_, w) => w?.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'Alt+Right', click: (_, w) => w?.webContents.navigationHistory.goForward() },
      { type: 'separator' },
      { role: 'reload', label: 'Reload' },
      { role: 'resetZoom', label: 'Reset zoom' },
      { role: 'zoomIn', label: 'Zoom in' },
      { role: 'zoomOut', label: 'Zoom out' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Full screen' },
      { role: 'toggleDevTools', label: 'Developer tools' },
    ],
  },
]));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

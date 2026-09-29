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
    title: 'GW2 Erfolgs-Helfer',
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
    label: 'Ansicht',
    submenu: [
      { label: 'Zurück', accelerator: 'Alt+Left', click: (_, w) => w?.webContents.navigationHistory.goBack() },
      { label: 'Vor', accelerator: 'Alt+Right', click: (_, w) => w?.webContents.navigationHistory.goForward() },
      { type: 'separator' },
      { role: 'reload', label: 'Neu laden' },
      { role: 'resetZoom', label: 'Zoom zurücksetzen' },
      { role: 'zoomIn', label: 'Vergrößern' },
      { role: 'zoomOut', label: 'Verkleinern' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Vollbild' },
      { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' },
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

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
  shell,
  session,
} = require('electron');
const path = require('path');

// Ubuntu 23.10+/24.04 restrict unprivileged user-namespace creation via
// AppArmor, which crashes Chromium's zygote/sandbox init for apps that
// don't ship an AppArmor profile (the same issue affects other unpackaged
// Electron/CEF apps). Disabling the OS-level sandbox avoids the crash;
// page-level security (context isolation, no node integration) is unaffected.
app.commandLine.appendSwitch('no-sandbox');

const CHROME_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TRAY_ICON = path.join(__dirname, 'assets', 'tray-icon.png');
const APP_ICON = path.join(__dirname, 'build', 'icon.png');

// A plain startsWith('https://web.whatsapp.com') check is bypassable by a
// hostname like "web.whatsapp.com.evil.com" that merely has the string as a
// prefix; parse the URL and compare the actual hostname instead.
function isWhatsAppOrigin(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname === 'web.whatsapp.com';
  } catch {
    return false;
  }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Single instance lock
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const appIcon = nativeImage.createFromPath(APP_ICON);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: true,
    title: 'WhatsApp Desktop',
    icon: appIcon,
    autoHideMenuBar: true, // hidden by default, Alt reveals it
    backgroundColor: '#111b21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:whatsapp', // persistent session -> no re-scan of QR
      contextIsolation: true,
      nodeIntegration: false,
      // NOTE: `sandbox: true` would be preferable in principle, but it
      // reliably crashes renderer startup on Ubuntu 23.10+/24.04 due to the
      // same AppArmor unprivileged-userns restriction worked around above
      // for the OS-level sandbox (confirmed by reproducing the crash twice
      // with an isolated user-data dir). contextIsolation + nodeIntegration:
      // false already keep the loaded page itself off of Node; this only
      // affects how much access the preload script has.
      sandbox: false,
      spellcheck: true,
    },
  });

  mainWindow.webContents.setUserAgent(CHROME_USER_AGENT);

  // The constructor `icon` option doesn't reliably set the X11 window-icon
  // hint on every WM/desktop combo, so also set it explicitly.
  mainWindow.setIcon(appIcon);

  // Minimal application menu (hidden, revealed with Alt)
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadURL('https://web.whatsapp.com');

  // ---- Background mode: hide instead of quitting ----
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  // ---- Badge count via page title ----
  mainWindow.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    const match = title.match(/^\((\d+)\)/);
    const count = match ? parseInt(match[1], 10) : 0;
    updateBadge(count);
  });

  // ---- External links open in the default browser ----
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isWhatsAppOrigin(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isWhatsAppOrigin(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // ---- Spellcheck context menu ----
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menuItems = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        menuItems.push({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length) {
        menuItems.push({ type: 'separator' });
      }
      menuItems.push({
        label: 'Add to dictionary',
        click: () =>
          mainWindow.webContents.session.addWordToSpellCheckerDictionary(
            params.misspelledWord
          ),
      });
      menuItems.push({ type: 'separator' });
    }

    if (params.isEditable) {
      menuItems.push(
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' }
      );
    } else if (params.selectionText) {
      menuItems.push({ role: 'copy' });
    }

    if (menuItems.length) {
      Menu.buildFromTemplate(menuItems).popup();
    }
  });

  return mainWindow;
}

// ---------------------------------------------------------------------------
// Native notification bridge (page -> main -> native GNOME notification)
// ---------------------------------------------------------------------------
// Notification title/body come from message content, i.e. from whoever
// messages the user. Some Linux notification daemons interpret a small
// markup subset (<b>, <a>, <img>, ...) in the body by default, so strip
// angle brackets rather than passing contact-controlled text through as-is.
function stripMarkup(text) {
  return String(text).replace(/[<>]/g, '');
}

ipcMain.on('wa-notification', (event, { id, title, body, icon }) => {
  const notification = new Notification({
    title: stripMarkup(title || 'WhatsApp'),
    body: stripMarkup(body || ''),
    icon: icon ? nativeImage.createFromDataURL(icon) : APP_ICON,
    silent: false,
  });

  notification.on('click', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    event.sender.send('wa-notification-clicked', id);
  });

  notification.show();
});

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(icon);
  tray.setToolTip('WhatsApp Desktop');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: () => toggleWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => toggleWindow());
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function updateBadge(count) {
  if (!tray) return;
  if (count > 0) {
    tray.setToolTip(`WhatsApp Desktop - ${count} unread message${count === 1 ? '' : 's'}`);
  } else {
    tray.setToolTip('WhatsApp Desktop');
  }
  if (app.isPackaged || process.platform === 'linux') {
    try {
      app.setBadgeCount(count);
    } catch (e) {
      // not supported on this desktop environment, ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Permissions: webRTC (calls), microphone/camera, clipboard, notifications
// ---------------------------------------------------------------------------
function setupPermissions() {
  const ses = session.fromPartition('persist:whatsapp');

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = [
      'media',
      'audioCapture',
      'videoCapture',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'display-capture',
      'fullscreen',
    ];
    callback(allowed.includes(permission) && isWhatsAppOrigin(details.requestingUrl));
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const allowed = [
      'media',
      'audioCapture',
      'videoCapture',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'display-capture',
    ];
    return allowed.includes(permission) && isWhatsAppOrigin(requestingOrigin);
  });

  // Basic Content-Security-Policy (only applied when the response has none)
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    const hasCsp = Object.keys(headers).some(
      (h) => h.toLowerCase() === 'content-security-policy'
    );

    if (!hasCsp) {
      headers['Content-Security-Policy'] = [
        "default-src 'self' https: wss: data: blob:; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
          "style-src 'self' 'unsafe-inline' https:; " +
          "img-src 'self' data: blob: https:; " +
          "media-src 'self' data: blob: https:; " +
          "connect-src 'self' https: wss:; " +
          "font-src 'self' data: https:; " +
          "object-src 'none'; " +
          "frame-ancestors 'none';",
      ];
    }

    callback({ responseHeaders: headers });
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  app.setName('WhatsApp Desktop');
  setupPermissions();
  createWindow();
  createTray();

  // Screen sharing support for WhatsApp video calls
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const { desktopCapturer } = require('electron');
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        if (!sources.length) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      });
    },
    { useSystemPicker: true }
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  // keep running in the tray; do not quit
});

app.on('before-quit', () => {
  isQuitting = true;
});

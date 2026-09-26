const {
  app,
  BrowserWindow,
  Tray,
  nativeImage,
  Menu,
  session,
} = require('electron');

const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

// ---------- CHROME UA ----------
// Update the Chrome version here occasionally to stay current
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// ---------- APP IDENTITY ----------
// Must be set before app.whenReady so Windows registers the correct app name
// in the System Media Transport Controls overlay
app.setAppUserModelId('com.sviz.soundcloudplayer');
app.name = "Sviz's SoundCloud";

// ---------- SINGLE INSTANCE LOCK ----------
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// Top-level flag instead of a dynamic property on `app`
let isQuitting = false;

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

// ---------- COMMAND LINE SWITCHES ----------
app.commandLine.appendSwitch(
  'disable-features',
  'TranslateUI,AutoplayIgnoreWebAudio'
);
app.commandLine.appendSwitch(
  'enable-features',
  'HardwareMediaKeyHandling,MediaSessionService'
);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disk-cache-size', '209715200');
app.commandLine.appendSwitch('use-angle', 'gl');

// Removes the AutomationControlled flag that sites use to detect Electron
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// ---------- STATE ----------
let mainWindow;
let tray;
let trayInterval;
let currentFrame = 0;
let trayFrames = []; // Only populated when idle.png exists

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
let settings = { windowBounds: { width: 1200, height: 800 } };

// ---------- SETTINGS ----------
function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      settings = {
        ...settings,
        ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
      };
    }
  } catch (err) {
    console.error('Settings load error:', err);
  }
}

async function saveSettings() {
  try {
    await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Settings save error:', err);
  }
}

// Sync version used on quit to guarantee the write completes before exit
function saveSettingsSync() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Settings save error (sync):', err);
  }
}

// ---------- TRAY ANIMATION ----------
function loadTrayFrames() {
  // Called only when we know the tray will be used — avoids wasted allocations
  for (let i = 2; i <= 36; i++) {
    const img = nativeImage
      .createFromPath(path.join(__dirname, 'tray', `Frame ${i}.png`))
      .resize({ width: 16, height: 16 });
    trayFrames.push(img);
  }
}

function startTrayAnimation() {
  if (trayInterval || !tray || trayFrames.length === 0) return;

  // Interval only runs while the window is hidden — no visibility check needed inside
  trayInterval = setInterval(() => {
    tray.setImage(trayFrames[currentFrame]);
    currentFrame = (currentFrame + 1) % trayFrames.length;
  }, 60);
}

function stopTrayAnimation() {
  if (trayInterval) {
    clearInterval(trayInterval);
    trayInterval = null;
  }
  // Reset so the animation restarts cleanly next time
  currentFrame = 0;
}

// ---------- WINDOW ----------
function createWindow() {
  loadSettings();

  mainWindow = new BrowserWindow({
    width: settings.windowBounds.width,
    height: settings.windowBounds.height,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    title: "Sviz's SoundCloud",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
      offscreen: false,
      spellcheck: false,
      contextIsolation: true,
      partition: 'persist:soundcloud',
    },
  });

  // Set UA on the webContents before loading so the initial request is clean
  mainWindow.webContents.setUserAgent(CHROME_UA);
  mainWindow.loadURL('https://soundcloud.com');

  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Debounced window size save
  let saveTimeout;
  mainWindow.on('resize', () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
        settings.windowBounds = mainWindow.getBounds();
        saveSettings();
      }
    }, 300);
  });

  // Minimize to tray on close
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      startTrayAnimation();
    }
  });

  mainWindow.on('show', () => {
    stopTrayAnimation();
  });
}

// ---------- APP ----------
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // Apply UA and request header patches to the persistent session so every
  // request (XHR, fetch, subframes) uses the spoofed UA — not just the main frame
  const sc = session.fromPartition('persist:soundcloud');

  sc.setUserAgent(CHROME_UA);

  sc.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };

    // Strip the header that directly exposes Electron
    delete headers['X-Electron-Version'];

    // Enforce the clean UA on every outgoing request
    headers['User-Agent'] = CHROME_UA;

    callback({ requestHeaders: headers });
  });

  createWindow();

  // ---------- TRAY ----------
  const idlePath = path.join(__dirname, 'tray', 'idle.png');

  if (fs.existsSync(idlePath)) {
    // Load frames only now that we know the tray will be created
    loadTrayFrames();

    tray = new Tray(
      nativeImage.createFromPath(idlePath).resize({ width: 16, height: 16 })
    );

    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Show SoundCloud',
          click: () => mainWindow.show(),
        },
        {
          label: 'Quit',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ])
    );

    tray.on('click', () => {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    });
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  // Sync write guarantees settings are saved before the process exits
  saveSettingsSync();
});
const { BrowserWindow, Tray, Menu, nativeImage, clipboard, Notification, shell } = require('electron');
const path = require('path');

const SETTINGS_WINDOW_WIDTH = 800;
const SETTINGS_WINDOW_HEIGHT = 600;
const SETTINGS_WINDOW_MIN_WIDTH = 600;
const SETTINGS_WINDOW_MIN_HEIGHT = 450;

function createTrayIcon(iconPath) {
  let icon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') {
    icon = icon.resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
  }
  return icon;
}

function createAppUiController({
  app,
  fs,
  remoteMain,
  startServer,
  stopServer,
  isServerRunning,
  getLanguagePreference,
  proxyPort,
  backendPort
}) {
  let tray = null;
  let settingsWindow = null;

  function getMenuText() {
    if (getLanguagePreference && getLanguagePreference() === 'en') {
      return {
        serverRunning: (port) => `Server: Running (port ${port})`,
        serverStopped: 'Server: Stopped',
        openSettings: 'Open Settings',
        stopServer: 'Stop Server',
        startServer: 'Start Server',
        copyServerUrl: 'Copy Server URL',
        copied: 'Copied',
        copiedBody: 'Server URL copied to clipboard',
        openDashboard: 'Open Dashboard',
        quit: 'Quit'
      };
    }

    return {
      serverRunning: (port) => `服务：运行中（端口 ${port}）`,
      serverStopped: '服务：未启动',
      openSettings: '打开设置',
      stopServer: '停止服务',
      startServer: '启动服务',
      copyServerUrl: '复制服务地址',
      copied: '已复制',
      copiedBody: '服务地址已复制到剪贴板',
      openDashboard: '打开面板',
      quit: '退出'
    };
  }

  function showNotification(title, body) {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  }

  function openDashboard() {
    shell.openExternal(`http://localhost:${backendPort}/management.html`);
  }

  function openSettings() {
    if (settingsWindow) {
      settingsWindow.setMinimumSize(SETTINGS_WINDOW_MIN_WIDTH, SETTINGS_WINDOW_MIN_HEIGHT);
      settingsWindow.setSize(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT);
      settingsWindow.center();
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }

    settingsWindow = new BrowserWindow({
      width: SETTINGS_WINDOW_WIDTH,
      height: SETTINGS_WINDOW_HEIGHT,
      minWidth: SETTINGS_WINDOW_MIN_WIDTH,
      minHeight: SETTINGS_WINDOW_MIN_HEIGHT,
      resizable: true,
      title: 'BeitaProxy',
      titleBarStyle: 'hiddenInset',
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    remoteMain.enable(settingsWindow.webContents);
    settingsWindow.loadFile(path.join(__dirname, '../ui/settings.html'));
    settingsWindow.once('ready-to-show', () => {
      settingsWindow.show();
      settingsWindow.focus();
    });

    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
  }

  function updateTray() {
    if (!tray) return;

    const text = getMenuText();
    const iconName = isServerRunning() ? 'icon-active.png' : 'icon-inactive.png';
    const iconPath = path.join(__dirname, '../assets', iconName);
    if (fs.existsSync(iconPath)) {
      tray.setImage(createTrayIcon(iconPath));
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: isServerRunning() ? text.serverRunning(proxyPort) : text.serverStopped,
        enabled: false
      },
      { type: 'separator' },
      { label: text.openSettings, accelerator: 'CmdOrCtrl+S', click: openSettings },
      { type: 'separator' },
      {
        label: isServerRunning() ? text.stopServer : text.startServer,
        click: () => isServerRunning() ? stopServer() : startServer()
      },
      { type: 'separator' },
      {
        label: text.copyServerUrl,
        accelerator: 'CmdOrCtrl+C',
        enabled: isServerRunning(),
        click: () => {
          clipboard.writeText(`http://localhost:${proxyPort}`);
          showNotification(text.copied, text.copiedBody);
        }
      },
      {
        label: text.openDashboard,
        accelerator: 'CmdOrCtrl+D',
        enabled: isServerRunning(),
        click: openDashboard
      },
      { type: 'separator' },
      {
        label: text.quit,
        accelerator: 'CmdOrCtrl+Q',
        click: async () => {
          await stopServer();
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
  }

  function createTray() {
    const iconPath = path.join(__dirname, '../assets/icon-inactive.png');
    tray = new Tray(createTrayIcon(iconPath));
    tray.setToolTip('BeitaProxy');
    updateTray();
  }

  return {
    showNotification,
    createTray,
    updateTray,
    openDashboard,
    openSettings
  };
}

module.exports = { createAppUiController };

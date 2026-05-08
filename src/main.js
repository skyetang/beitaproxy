const { app, clipboard, shell, net: electronNet, session } = require('electron');
const remoteMain = require('@electron/remote/main');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { normalizeCodexUsageResponse } = require('./codex-usage');
const {
  buildDisabledOAuthProviders,
  composeRuntimeConfig,
  loadBaseConfigRoot,
  loadZaiApiKeys,
  writeMergedConfig
} = require('./runtime-config');
const { createObservedInputsMonitor } = require('./observed-inputs');
const { createAppUiController } = require('./app-ui');

remoteMain.initialize();

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); }

// Constants
const PROXY_PORT = 8317;
const BACKEND_PORT = 8318;
const AUTH_DIR = path.join(os.homedir(), '.cli-proxy-api');
const USER_CONFIG_PATH = path.join(AUTH_DIR, 'config.yaml');
const MERGED_CONFIG_PATH = path.join(AUTH_DIR, 'merged-config.yaml');
const ENABLED_PROVIDERS_FILE = path.join(AUTH_DIR, 'enabled-providers.json');
const MANAGEMENT_SECRET_FILE = path.join(AUTH_DIR, 'beitaproxy-management-secret');
const CODEX_LOCAL_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');
const APP_VERSION = '1.0.1';
const CONFIG_FILE = path.join(AUTH_DIR, 'beitaproxy-config.json');
const TOKEN_STATS_FILE = path.join(app.getPath('userData'), 'token-stats.json');
const TOKEN_STATS_STORE_VERSION = 3;
const STARTUP_READINESS_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 4000;
const OBSERVED_INPUTS_DEBOUNCE_MS = 400;
const AUTH_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_COMPLETION_POLL_MS = 500;
const AUTH_PROCESS_EXIT_GRACE_MS = 3000;
const TOKEN_STATS_BACKGROUND_SYNC_DELAY_MS = 1500;

// State
let serverProcess = null;
let thinkingProxyServer = null;
let isServerRunning = false;
let enabledProviders = {};
let launchAtLogin = false;
let localProxyUrl = '';
let currentLanguage = 'zh';
let authSessions = {};
let serverOperationQueue = Promise.resolve();
let observedInputsMonitor = null;
let kiroAutoSyncTimer = null;
let statsAttributionIndexes = {};
let activeManagementSecretKey = null;
let tokenStatsSyncTimer = null;
let tokenStatsSyncInFlight = false;
let tokenStatsSyncPending = false;
let tokenStatsSyncActivePromise = null;
let tokenStatsStoreQueue = Promise.resolve();
let quitCleanupComplete = false;
let quitCleanupPromise = null;

// OAuth provider keys mapping (same as Swift version)
const OAUTH_PROVIDER_KEYS = {
  'claude': 'claude',
  'codex': 'codex',
  'gemini': 'gemini-cli',
  'github-copilot': 'github-copilot',
  'antigravity': 'antigravity',
  'qwen': 'qwen',
  'kiro': 'kiro',
  'zai': 'zai'
};

const AUTH_COMMANDS = {
  '-codex-login': {
    serviceType: 'codex',
    expectedCallbackPort: 1455,
    keepAlivePattern: /callback|browser|open.*auth|waiting.*login/i,
    keepAliveDelayMs: 12000
  },
  '-codex-device-login': {
    serviceType: 'codex'
  },
  '-claude-login': {
    serviceType: 'claude'
  },
  '-login': {
    serviceType: 'gemini',
    promptPattern: /default project|press enter|select.*project/i,
    fallbackInput: '\n',
    fallbackDelayMs: 3000
  },
  '-github-copilot-login': {
    serviceType: 'github-copilot'
  },
  '-qwen-login': {
    serviceType: 'qwen',
    promptPattern: /email|mail/i,
    fallbackDelayMs: 10000
  },
  '-antigravity-login': {
    serviceType: 'antigravity'
  }
};

// ============== Utility Functions ==============

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

function normalizeManagementSecret(value) {
  const secret = String(value || '').trim();
  return secret.length > 0 ? secret : null;
}

function getInternalManagementSecret() {
  ensureAuthDir();
  try {
    if (fs.existsSync(MANAGEMENT_SECRET_FILE)) {
      const existing = normalizeManagementSecret(fs.readFileSync(MANAGEMENT_SECRET_FILE, 'utf8'));
      if (existing) return existing;
    }
  } catch (e) {}

  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(MANAGEMENT_SECRET_FILE, `${secret}\n`, 'utf8');
  try { fs.chmodSync(MANAGEMENT_SECRET_FILE, 0o600); } catch (e) {}
  return secret;
}

function getRuntimeManagementSecret(baseRoot = null) {
  const remoteManagement = baseRoot && typeof baseRoot === 'object' ? baseRoot['remote-management'] : null;
  const configuredSecret = remoteManagement && typeof remoteManagement === 'object'
    ? normalizeManagementSecret(remoteManagement['secret-key'] || remoteManagement.secretKey)
    : null;
  return configuredSecret || getInternalManagementSecret();
}

function getSystemProxy() {
  try {
    const output = execSync('scutil --proxy', { encoding: 'utf8' });
    const httpEnabled = output.match(/HTTPEnable\s*:\s*1/);
    const httpProxy = output.match(/HTTPProxy\s*:\s*(\S+)/);
    const httpPort = output.match(/HTTPPort\s*:\s*(\d+)/);
    if (httpEnabled && httpProxy && httpPort) {
      return `http://${httpProxy[1]}:${httpPort[1]}`;
    }
  } catch (e) {}
  return null;
}

function getEnvProxy() {
  return process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    null;
}

function getResourcePath(filename) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, filename);
  }
  return path.join(__dirname, '..', filename);
}

function getBackendBinaryName() {
  return process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
}

function getBackendBinaryPath() {
  return getResourcePath(getBackendBinaryName());
}

function sanitizeFilenamePart(value, fallback = 'account') {
  const sanitized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function decodeJwtPayload(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function readAppConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function writeAppConfig(config) {
  ensureAuthDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (e) {}
}

function getSelectedAccounts() {
  const config = readAppConfig();
  return config && typeof config.selectedAccounts === 'object' && config.selectedAccounts !== null
    ? config.selectedAccounts
    : {};
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeProxyUrl(proxyUrl) {
  return String(proxyUrl || '').trim();
}

function getActiveProxyUrl() {
  return normalizeProxyUrl(localProxyUrl) || getEnvProxy() || getSystemProxy();
}

async function applyNetworkProxy() {
  if (!app.isReady()) {
    return;
  }

  const activeProxy = getActiveProxyUrl();
  if (activeProxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: activeProxy,
      proxyBypassRules: '<local>;127.0.0.1;localhost'
    });
    console.log(`[Network] Using proxy: ${activeProxy}`);
  } else {
    await session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[Network] Using direct connection');
  }
}

function saveAppSettings() {
  try {
    const config = readAppConfig();
    config.launchAtLogin = launchAtLogin;
    config.language = currentLanguage;
    delete config.selectedAccounts;
    config.localProxyUrl = localProxyUrl;
    writeAppConfig(config);
  } catch (e) {}
}

function getLanguagePreference() {
  return currentLanguage === 'en' ? 'en' : 'zh';
}

function setLanguagePreference(language) {
  currentLanguage = language === 'en' ? 'en' : 'zh';
  saveAppSettings();
  updateTray();
  return currentLanguage;
}

function mapAuthTypeToService(type) {
  const normalized = (type || '').toLowerCase();
  if (normalized === 'copilot') return 'github-copilot';
  if (normalized === 'gemini-cli' || normalized === 'gemini') return 'gemini';
  return normalized;
}

function readAuthFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeAuthFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  try { fs.chmodSync(filePath, 0o600); } catch (e) {}
}

function listAuthAccountEntries(serviceType = null) {
  const entries = [];
  ensureAuthDir();

  try {
    const files = fs.readdirSync(AUTH_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(AUTH_DIR, file);
        const data = readAuthFile(filePath);
        const stat = fs.statSync(filePath);
        const mappedType = mapAuthTypeToService(data.type);
        if (!mappedType) continue;
        if (serviceType && mappedType !== serviceType) continue;
        const createdAt = stat && Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
          ? stat.birthtime.toISOString()
          : (stat && stat.mtime ? stat.mtime.toISOString() : null);

        entries.push({
          id: file,
          filePath,
          type: mappedType,
          createdAt,
          data
        });
      } catch (e) {}
    }
  } catch (e) {}

  return entries.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
}

function createAuthEntrySnapshot(serviceType) {
  const fingerprints = new Map();
  for (const entry of listAuthAccountEntries(serviceType)) {
    fingerprints.set(entry.id, JSON.stringify(entry.data));
  }
  return fingerprints;
}

function hasAuthEntrySnapshotChanged(previousSnapshot, nextSnapshot) {
  for (const [id, fingerprint] of nextSnapshot.entries()) {
    if (!previousSnapshot.has(id) || previousSnapshot.get(id) !== fingerprint) {
      return true;
    }
  }
  return false;
}

function getKiroAuthUrl() {
  return `http://127.0.0.1:${BACKEND_PORT}/v0/oauth/kiro`;
}

function formatAuthFailureOutput(output, fallbackMessage) {
  const trimmed = String(output || '').trim();
  if (!trimmed) {
    return fallbackMessage;
  }
  return `${fallbackMessage}\n\n${trimmed}`;
}

function shouldUseCodexDeviceLoginFallback(output, exitCode) {
  if (process.platform !== 'win32') return false;
  if (exitCode === 0) return false;
  const normalized = String(output || '').toLowerCase();
  return normalized.includes('required port is already in use')
    || normalized.includes('port 3000')
    || normalized.includes('failed to start codex callback forwarder');
}

function createAuthCompletionWaiter(serviceType, previousSnapshot) {
  let settled = false;
  let resolvePromise = () => {};
  let intervalId = null;
  let timeoutId = null;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (intervalId) clearInterval(intervalId);
    if (timeoutId) clearTimeout(timeoutId);
    resolvePromise(result);
  };

  const check = () => {
    if (settled) return;
    const nextSnapshot = createAuthEntrySnapshot(serviceType);
    if (hasAuthEntrySnapshotChanged(previousSnapshot, nextSnapshot)) {
      finish({ changed: true, snapshot: nextSnapshot });
    }
  };

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    intervalId = setInterval(check, AUTH_COMPLETION_POLL_MS);
    timeoutId = setTimeout(() => finish({ changed: false, reason: 'timeout' }), AUTH_COMPLETION_TIMEOUT_MS);
    check();
  });

  return {
    promise,
    check,
    cancel: () => {
      if (settled) return;
      settled = true;
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
    }
  };
}

function findAuthAccountEntry(accountId) {
  return listAuthAccountEntries().find((entry) => entry.id === accountId) || null;
}

function getEnabledAccountCount(serviceType) {
  return listAuthAccountEntries(serviceType).filter((entry) => entry.data.disabled !== true).length;
}

function extractCodexLocalAuthMetadata(localAuth) {
  const tokens = localAuth && localAuth.tokens ? localAuth.tokens : {};
  const accessPayload = decodeJwtPayload(tokens.access_token);
  const idPayload = decodeJwtPayload(tokens.id_token);
  const accessAuth = accessPayload && accessPayload['https://api.openai.com/auth'];
  const accessProfile = accessPayload && accessPayload['https://api.openai.com/profile'];
  const idAuth = idPayload && idPayload['https://api.openai.com/auth'];

  const email = (idPayload && idPayload.email) ||
    (accessProfile && accessProfile.email) ||
    localAuth.email ||
    'codex-user';
  const accountId = tokens.account_id ||
    (accessAuth && accessAuth.chatgpt_account_id) ||
    (idAuth && idAuth.chatgpt_account_id) ||
    null;
  const expired = accessPayload && accessPayload.exp
    ? new Date(accessPayload.exp * 1000).toISOString()
    : null;
  const planType = (idAuth && idAuth.chatgpt_plan_type) ||
    (accessAuth && accessAuth.chatgpt_plan_type) ||
    'account';

  return {
    email,
    accountId,
    expired,
    planType
  };
}

function getCodexLocalAuthCandidates() {
  const candidates = [CODEX_LOCAL_AUTH_FILE];

  if (process.platform === 'win32') {
    const windowsCandidates = [
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex', 'auth.json') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Codex', 'auth.json') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Codex', 'auth.json') : null
    ].filter(Boolean);

    for (const candidate of windowsCandidates) {
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function readCodexLocalAuth() {
  for (const filePath of getCodexLocalAuthCandidates()) {
    try {
      if (!fs.existsSync(filePath)) continue;
      return {
        filePath,
        data: JSON.parse(fs.readFileSync(filePath, 'utf8'))
      };
    } catch (e) {}
  }
  return null;
}

function getCodexLocalAuthStatus() {
  try {
    const result = readCodexLocalAuth();
    if (!result) {
      return {
        found: false,
        importable: false,
        filePath: getCodexLocalAuthCandidates()[0] || CODEX_LOCAL_AUTH_FILE,
        error: 'Local Codex auth file not found'
      };
    }

    const localAuth = result.data;
    const hasTokens = !!(localAuth && localAuth.tokens);
    const hasAccessToken = !!(hasTokens && localAuth.tokens.access_token);
    const hasIdToken = !!(hasTokens && localAuth.tokens.id_token);
    const importable = hasAccessToken || hasIdToken;

    return {
      found: true,
      importable,
      filePath: result.filePath,
      error: importable ? null : 'Local Codex auth is missing a usable token'
    };
  } catch (e) {
    return {
      found: false,
      importable: false,
      filePath: getCodexLocalAuthCandidates()[0] || CODEX_LOCAL_AUTH_FILE,
      error: e.message
    };
  }
}

function cleanupAuthSession(type) {
  const active = authSessions[type];
  if (!active) return;
  if (active.timeout) clearTimeout(active.timeout);
  delete authSessions[type];
}

function stopAuthSession(type, reason = 'Authentication cancelled.') {
  const active = authSessions[type];
  if (!active) return;

  try {
    const proc = active.proc;
    if (proc && proc.exitCode === null && !proc.killed) {
      if (process.platform === 'win32') {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { encoding: 'utf8' }); } catch (e) {}
      } else {
        try { proc.kill('SIGTERM'); } catch (e) {}
      }
    }
    if (typeof active.cancel === 'function') {
      active.cancel(reason);
    }
  } finally {
    cleanupAuthSession(type);
  }
}

function cleanupAllAuthSessions() {
  for (const type of Object.keys(authSessions)) {
    stopAuthSession(type);
  }
}

function getConfigPath() {
  ensureAuthDir();
  const bundledConfigPath = getResourcePath('config.yaml');
  const { root: baseRoot, isUserConfig } = loadBaseConfigRoot({
    fs,
    bundledConfigPath,
    userConfigPath: USER_CONFIG_PATH
  });
  const disabledProviders = buildDisabledOAuthProviders({
    oauthProviderKeys: OAUTH_PROVIDER_KEYS,
    isProviderEnabled
  });
  const zaiKeys = loadZaiApiKeys({
    fs,
    authDir: AUTH_DIR,
    ensureAuthDir
  });
  const managementSecretKey = getRuntimeManagementSecret(baseRoot);
  activeManagementSecretKey = managementSecretKey;
  const needsMergedConfig = isUserConfig || disabledProviders.length > 0 || zaiKeys.length > 0 || !!managementSecretKey;

  if (!needsMergedConfig) {
    return bundledConfigPath;
  }

  const runtimeRoot = composeRuntimeConfig({
    baseRoot: baseRoot,
    disabledProviders,
    zaiKeys,
    zaiEnabled: isProviderEnabled('zai'),
    managementSecretKey
  });
  return writeMergedConfig({
    fs,
    mergedConfigPath: MERGED_CONFIG_PATH,
    runtimeRoot
  });
}

function scheduleObservedInputsRefresh(reason) {
  if (observedInputsMonitor) {
    observedInputsMonitor.trigger(reason);
  }
}

function startObservedInputMonitoring() {
  if (!observedInputsMonitor) {
    observedInputsMonitor = createObservedInputsMonitor({
      fs,
      authDir: AUTH_DIR,
      mergedConfigPath: MERGED_CONFIG_PATH,
      userConfigPath: USER_CONFIG_PATH,
      debounceMs: OBSERVED_INPUTS_DEBOUNCE_MS,
      ensureAuthDir,
      getCodexLocalAuthCandidates,
      rebuildConfig: getConfigPath,
      restartServerIfRunning,
      log: console
    });
  }
  observedInputsMonitor.start();
}

function stopObservedInputMonitoring() {
  if (observedInputsMonitor) {
    observedInputsMonitor.stop();
  }
}

function waitForPort(host, port, timeoutMs = STARTUP_READINESS_TIMEOUT_MS) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.createConnection({ host, port });
      let settled = false;

      const finishResolve = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve();
      };
      const retry = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 150);
        }
      };

      socket.setTimeout(1000, retry);
      socket.once('connect', finishResolve);
      socket.once('error', retry);
    }

    attempt();
  });
}

function canListenOnPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (server.listening) {
        server.close(() => resolve(value));
        return;
      }
      resolve(value);
    };

    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    server.listen(port, host);
  });
}

function enqueueServerOperation(operation) {
  const run = serverOperationQueue.then(operation, operation);
  serverOperationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function requestRestartAfterConfigChange() {
  resetStatsAttributionIndexes();
  return restartServerIfRunning();
}

// ============== Provider Management ==============

function loadEnabledProviders() {
  try {
    if (fs.existsSync(ENABLED_PROVIDERS_FILE)) {
      enabledProviders = JSON.parse(fs.readFileSync(ENABLED_PROVIDERS_FILE, 'utf8'));
    }
  } catch (e) {
    enabledProviders = {};
  }
}

function saveEnabledProviders() {
  try {
    ensureAuthDir();
    fs.writeFileSync(ENABLED_PROVIDERS_FILE, JSON.stringify(enabledProviders, null, 2));
  } catch (e) {}
}

// ============== Launch at Login ==============

function loadLaunchAtLogin() {
  try {
    const config = readAppConfig();
    launchAtLogin = config.launchAtLogin || false;
    localProxyUrl = normalizeProxyUrl(config.localProxyUrl || '');
    currentLanguage = config.language === 'en' ? 'en' : 'zh';
  } catch (e) {
    launchAtLogin = false;
    localProxyUrl = '';
    currentLanguage = 'zh';
  }
  app.setLoginItemSettings({ openAtLogin: launchAtLogin });
}

function setLaunchAtLogin(enabled) {
  launchAtLogin = enabled;
  app.setLoginItemSettings({ openAtLogin: enabled });
  saveAppSettings();
  console.log(`[Config] Launch at login: ${enabled}`);
}

function getLaunchAtLogin() {
  return launchAtLogin;
}

function getLocalProxyUrl() {
  return localProxyUrl;
}

async function setLocalProxyUrl(proxyUrl) {
  try {
    localProxyUrl = normalizeProxyUrl(proxyUrl);
    saveAppSettings();
    await applyNetworkProxy();
    return { success: true, proxyUrl: localProxyUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function isProviderEnabled(key) {
  return enabledProviders[key] !== false;
}

function setProviderEnabled(key, enabled) {
  enabledProviders[key] = enabled;
  saveEnabledProviders();
  getConfigPath();
  requestRestartAfterConfigChange();
  console.log(`[Config] Provider ${key} ${enabled ? 'enabled' : 'disabled'}`);
}

// ============== Kiro Token Import & Auto-Sync ==============

function checkKiroToken() {
  const kiroTokenPath = path.join(os.homedir(), '.aws/sso/cache/kiro-auth-token.json');
  return fs.existsSync(kiroTokenPath);
}

function syncKiroTokenFromIDE() {
  try {
    const kiroTokenPath = path.join(os.homedir(), '.aws/sso/cache/kiro-auth-token.json');

    if (!fs.existsSync(kiroTokenPath)) {
      return { success: false, error: 'Kiro IDE token not found' };
    }

    const kiroToken = JSON.parse(fs.readFileSync(kiroTokenPath, 'utf8'));
    const kiroExpired = new Date(kiroToken.expiresAt) < new Date();
    if (kiroExpired) {
      console.log('[Kiro] Kiro IDE token is also expired, skipping sync');
      return { success: false, error: 'Kiro IDE token expired' };
    }

    ensureAuthDir();
    const files = fs.readdirSync(AUTH_DIR);
    let updated = 0;

    for (const file of files) {
      if (!file.startsWith('kiro-') || !file.endsWith('.json')) continue;
      try {
        const filePath = path.join(AUTH_DIR, file);
        const authData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (authData.imported_from !== 'kiro-ide') continue;

        const needsUpdate = authData.access_token !== kiroToken.accessToken || authData.refresh_token !== kiroToken.refreshToken;
        if (!needsUpdate) continue;

        authData.access_token = kiroToken.accessToken || kiroToken.token;
        authData.refresh_token = kiroToken.refreshToken;
        authData.expired = kiroToken.expiresAt;
        authData.last_synced = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(authData, null, 2));
        fs.chmodSync(filePath, 0o600);
        updated++;
        console.log(`[Kiro] Synced token from IDE: ${file} (expires: ${kiroToken.expiresAt})`);
      } catch (e) {
        console.error(`[Kiro] Failed to sync ${file}:`, e.message);
      }
    }

    if (updated > 0) {
      getConfigPath();
      requestRestartAfterConfigChange();
      return { success: true, updated };
    }

    return { success: false, error: 'No updates needed' };
  } catch (e) {
    console.error('[Kiro] Sync failed:', e);
    return { success: false, error: e.message };
  }
}

function startKiroAutoSync() {
  const initialResult = syncKiroTokenFromIDE();
  if (initialResult.success) {
    console.log(`[Kiro] Initial sync completed: ${initialResult.updated} token(s) updated`);
  } else {
    console.log(`[Kiro] Initial sync: ${initialResult.error}`);
  }

  if (kiroAutoSyncTimer) {
    clearInterval(kiroAutoSyncTimer);
  }

  kiroAutoSyncTimer = setInterval(() => {
    const result = syncKiroTokenFromIDE();
    if (result.success) {
      console.log(`[Kiro] Auto-sync completed: ${result.updated} token(s) updated`);
    } else if (result.error !== 'No updates needed') {
      console.log(`[Kiro] Auto-sync: ${result.error}`);
    }
  }, 5 * 60 * 1000);

  console.log('[Kiro] Auto-sync enabled (every 5 minutes)');
}

function stopKiroAutoSync() {
  if (kiroAutoSyncTimer) {
    clearInterval(kiroAutoSyncTimer);
    kiroAutoSyncTimer = null;
  }
}

function importKiroToken() {
  try {
    const kiroTokenPath = path.join(os.homedir(), '.aws/sso/cache/kiro-auth-token.json');

    if (!fs.existsSync(kiroTokenPath)) {
      return { success: false, error: 'Kiro token not found. Please login to Kiro IDE first.' };
    }

    const kiroToken = JSON.parse(fs.readFileSync(kiroTokenPath, 'utf8'));
    ensureAuthDir();
    const filename = `kiro-${Date.now()}.json`;
    const authData = {
      type: 'kiro',
      email: kiroToken.email || 'kiro-user',
      access_token: kiroToken.accessToken || kiroToken.token,
      refresh_token: kiroToken.refreshToken,
      expired: kiroToken.expiresAt,
      created: new Date().toISOString(),
      imported_from: 'kiro-ide'
    };

    const filePath = path.join(AUTH_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(authData, null, 2));
    fs.chmodSync(filePath, 0o600);

    console.log(`[Kiro] Token imported from Kiro IDE with refresh token: ${filename}`);
    getConfigPath();
    requestRestartAfterConfigChange();

    return { success: true };
  } catch (e) {
    console.error('[Kiro] Import failed:', e);
    return { success: false, error: e.message };
  }
}

// ============== Auth Account Management ==============

function getAuthAccounts() {
  const accounts = [];
  for (const entry of listAuthAccountEntries()) {
    const data = entry.data;

    let expired = false;
    if (data.expired) {
      try {
        const expDate = new Date(data.expired);
        expired = expDate < new Date();
      } catch (e) {}
    }

    const statsKey = buildAccountStatsKey(entry);
    const temporaryKey = buildTemporaryStatsKey(entry);

    accounts.push({
      id: entry.id,
      type: entry.type,
      email: data.email || data.login || entry.id,
      login: data.login,
      expired,
      expiredDate: data.expired,
      disabled: data.disabled === true,
      path: entry.filePath,
      statsKey,
      temporaryKey
    });
  }

  return accounts;
}

function ensureTokenStatsAccountMetadata(store, entries = listAuthAccountEntries()) {
  for (const entry of entries) {
    const statsKey = buildAccountStatsKey(entry);
    const temporaryKey = buildTemporaryStatsKey(entry);
    if (!statsKey) continue;
    mergeAccountStatsAliases(store, entry, entries);
    ensureAccountMeta(store, entry, { statsKey, temporaryKey });
    ensureTemporaryAccountStats(store, temporaryKey);
  }
}

function toggleAccountDisabled(accountId) {
  try {
    const entry = findAuthAccountEntry(accountId);
    if (!entry) {
      return { success: false, error: 'Account not found' };
    }

    const currentlyDisabled = entry.data.disabled === true;
    if (!currentlyDisabled && getEnabledAccountCount(entry.type) <= 1) {
      return {
        success: false,
        code: 'LAST_ENABLED_ACCOUNT',
        error: 'At least one account must remain enabled.'
      };
    }

    entry.data.disabled = !currentlyDisabled;
    writeAuthFile(entry.filePath, entry.data);
    getConfigPath();
    requestRestartAfterConfigChange();

    return {
      success: true,
      accountId,
      disabled: entry.data.disabled,
      type: entry.type
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function designateAccountForUse(accountId) {
  try {
    const entry = findAuthAccountEntry(accountId);
    if (!entry) {
      return { success: false, error: 'Account not found' };
    }

    const siblingEntries = listAuthAccountEntries(entry.type);
    if (siblingEntries.length === 0) {
      return { success: false, error: 'No accounts found for provider' };
    }

    for (const sibling of siblingEntries) {
      sibling.data.disabled = sibling.id === entry.id ? false : true;
      writeAuthFile(sibling.filePath, sibling.data);
    }

    getConfigPath();
    requestRestartAfterConfigChange();

    return {
      success: true,
      accountId,
      type: entry.type,
      designatedAccountId: entry.id
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function deleteAccount(filePath) {
  try {
    const entry = listAuthAccountEntries().find((item) => item.filePath === filePath);
    if (entry) {
      await queueTokenStatsStoreUpdate(async () => {
        const store = readTokenStatsStore();
        const statsKey = buildAccountStatsKey(entry);
        const temporaryKey = buildTemporaryStatsKey(entry);
        const meta = ensureAccountMeta(store, entry, { statsKey, temporaryKey, deleted: true });
        if (meta) {
          meta.deletedAt = new Date().toISOString();
          store.accountMeta[statsKey] = meta;
        }
        if (temporaryKey) {
          delete store.temporaryAccounts[temporaryKey];
          if (store.temporaryAccountResets) {
            delete store.temporaryAccountResets[temporaryKey];
          }
        }
        writeTokenStatsStore(store);
      });
    }
    fs.unlinkSync(filePath);
    getConfigPath();
    requestRestartAfterConfigChange();
    return true;
  } catch (e) {
    return false;
  }
}

async function resetTemporaryTokenStats(temporaryKey) {
  try {
    if (!temporaryKey) {
      return { success: false, error: 'Temporary token key is required' };
    }
    return await queueTokenStatsStoreUpdate(async () => {
      const syncInputs = await fetchCliProxyUsageSyncInputs().catch(() => null);
      const store = readTokenStatsStore();
      if (syncInputs && syncInputs.success) {
        syncCliProxyUsageStatistics(store, syncInputs.payload, syncInputs.authFiles);
      }
      const now = new Date();
      const resetAt = now.toISOString();
      const resetDay = getLocalDayKey(now);
      const statsKey = findStatsKeyByTemporaryKey(store, temporaryKey);
      const baseline = statsKey
        ? getDailyAccountBreakdown(store, resetDay, statsKey)
        : createEmptyTokenBreakdown();

      store.temporaryAccountResets = store.temporaryAccountResets || {};
      store.temporaryAccounts[temporaryKey] = createEmptyTokenBreakdown();
      store.temporaryAccountResets[temporaryKey] = {
        resetAt,
        resetDay,
        baseline
      };
      store.updatedAt = new Date().toISOString();
      writeTokenStatsStore(store);
      return { success: true, stats: buildTokenStatisticsPayload(store) };
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function resetTemporaryTokenStatsForAccount(accountId) {
  try {
    const entry = findAuthAccountEntry(accountId);
    if (!entry) {
      return { success: false, error: 'Account not found' };
    }
    const temporaryKey = buildTemporaryStatsKey(entry);
    const result = await resetTemporaryTokenStats(temporaryKey);
    return {
      ...result,
      accountId,
      temporaryKey
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function saveZaiApiKey(apiKey) {
  ensureAuthDir();
  const keyPreview = apiKey.substring(0, 8) + '...' + apiKey.slice(-4);
  const filename = `zai-${Date.now()}.json`;
  const data = {
    type: 'zai',
    email: keyPreview,
    api_key: apiKey,
    created: new Date().toISOString()
  };

  const filePath = path.join(AUTH_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  fs.chmodSync(filePath, 0o600);
  getConfigPath();
  requestRestartAfterConfigChange();
  return true;
}

function checkCodexLocalAuth() {
  return getCodexLocalAuthStatus().found;
}

function getCodexLocalAuthPath() {
  return getCodexLocalAuthStatus().filePath;
}

function buildCodexLocalAuthPayload(entry, existingLocalAuth = null) {
  const data = entry && entry.data ? entry.data : {};
  const base = existingLocalAuth && typeof existingLocalAuth === 'object' && !Array.isArray(existingLocalAuth)
    ? { ...existingLocalAuth }
    : {};
  const existingTokens = base.tokens && typeof base.tokens === 'object' && !Array.isArray(base.tokens)
    ? base.tokens
    : {};
  const tokens = { ...existingTokens };

  tokens.access_token = data.access_token;
  tokens.refresh_token = data.refresh_token || null;
  tokens.id_token = data.id_token || null;
  tokens.account_id = data.account_id || null;

  return {
    ...base,
    email: data.email || data.login || base.email || 'codex-user',
    last_refresh: data.last_refresh || new Date().toISOString(),
    tokens
  };
}

function switchCodexLocalAuth(accountId) {
  try {
    const entry = findAuthAccountEntry(accountId);
    if (!entry) {
      return { success: false, error: 'Account not found' };
    }
    if (entry.type !== 'codex') {
      return { success: false, error: 'Account is not a Codex account' };
    }
    if (!entry.data.access_token) {
      return { success: false, error: 'CODEX_SWITCH_MISSING_ACCESS_TOKEN' };
    }

    const existingResult = readCodexLocalAuth();
    const filePath = existingResult
      ? existingResult.filePath
      : (getCodexLocalAuthCandidates()[0] || CODEX_LOCAL_AUTH_FILE);
    let existingLocalAuth = existingResult ? existingResult.data : null;

    if (!existingLocalAuth && fs.existsSync(filePath)) {
      try {
        existingLocalAuth = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        return { success: false, error: `Invalid Codex local auth JSON at ${filePath}: ${e.message}` };
      }
    }

    const payload = buildCodexLocalAuthPayload(entry, existingLocalAuth);

    ensureParentDir(filePath);
    writeAuthFile(filePath, payload);
    scheduleObservedInputsRefresh('Codex local auth changed');

    return {
      success: true,
      filePath,
      email: payload.email,
      accountId: entry.data.account_id || null
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function importCodexLocalAuth() {
  try {
    const result = readCodexLocalAuth();
    if (!result) {
      return { success: false, error: `Local Codex auth not found at ${getCodexLocalAuthPath()}` };
    }

    const localAuth = result.data;
    if (!localAuth.tokens || !localAuth.tokens.access_token) {
      return { success: false, error: 'Local Codex auth is missing an access token' };
    }

    const metadata = extractCodexLocalAuthMetadata(localAuth);
    const existingCodexAccounts = listAuthAccountEntries('codex');
    const existingEntry = existingCodexAccounts.find((entry) =>
      (metadata.accountId && entry.data.account_id === metadata.accountId) ||
      (metadata.email && entry.data.email === metadata.email && entry.data.imported_from === 'codex-local')
    );

    const filename = existingEntry
      ? existingEntry.id
      : `codex-${sanitizeFilenamePart(metadata.accountId || Date.now(), 'local')}-${sanitizeFilenamePart(metadata.email, 'user')}-${sanitizeFilenamePart(metadata.planType, 'account')}.json`;
    const filePath = existingEntry ? existingEntry.filePath : path.join(AUTH_DIR, filename);

    const authData = {
      type: 'codex',
      email: metadata.email,
      access_token: localAuth.tokens.access_token,
      refresh_token: localAuth.tokens.refresh_token || null,
      id_token: localAuth.tokens.id_token || null,
      account_id: metadata.accountId,
      expired: metadata.expired,
      last_refresh: localAuth.last_refresh || new Date().toISOString(),
      imported_from: 'codex-local',
      auth_source_path: result.filePath,
      disabled: existingEntry ? existingEntry.data.disabled === true : false
    };

    if (existingEntry && existingEntry.data.created) {
      authData.created = existingEntry.data.created;
    } else {
      authData.created = new Date().toISOString();
    }

    ensureAuthDir();
    writeAuthFile(filePath, authData);
    getConfigPath();
    requestRestartAfterConfigChange();

    return {
      success: true,
      account: {
        id: filename,
        email: metadata.email,
        accountId: metadata.accountId,
        updated: !!existingEntry
      }
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function buildAccountStatsKey(entry) {
  if (!entry) return null;
  const data = entry.data || {};
  const normalizedType = String(entry.type || mapAuthTypeToService(data.type) || '').trim().toLowerCase();
  const normalizedAccountId = String(
    data.account_id
      || data.accountId
      || data.chatgpt_account_id
      || data.chatgptAccountId
      || ''
  ).trim().toLowerCase();
  const normalizedEmail = String(data.email || data.login || '').trim().toLowerCase();
  return [normalizedType, normalizedAccountId || normalizedEmail || entry.id].join('::');
}

function buildAccountStatsKeyCandidates(entry) {
  if (!entry) return [];
  const data = entry.data || {};
  const normalizedType = String(entry.type || mapAuthTypeToService(data.type) || '').trim().toLowerCase();
  if (!normalizedType) return [];
  const values = [
    data.account_id,
    data.accountId,
    data.chatgpt_account_id,
    data.chatgptAccountId,
    data.email,
    data.login,
    entry.id
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(values.map((value) => `${normalizedType}::${value}`)));
}

function buildTemporaryStatsKey(entry) {
  if (!entry) return null;
  const statsKey = buildAccountStatsKey(entry);
  if (!statsKey) return null;
  return `${entry.id}::${statsKey}`;
}

function mergeTemporaryStatsAlias(store, fromTemporaryKey, toTemporaryKey) {
  if (!fromTemporaryKey || !toTemporaryKey || fromTemporaryKey === toTemporaryKey) return;
  if (store.temporaryAccounts && store.temporaryAccounts[fromTemporaryKey]) {
    store.temporaryAccounts[toTemporaryKey] = mergeTokenBreakdowns(
      store.temporaryAccounts[toTemporaryKey] || createEmptyTokenBreakdown(),
      store.temporaryAccounts[fromTemporaryKey]
    );
    delete store.temporaryAccounts[fromTemporaryKey];
  }
  const fromReset = store.temporaryAccountResets && store.temporaryAccountResets[fromTemporaryKey];
  if (fromReset) {
    const toReset = store.temporaryAccountResets[toTemporaryKey];
    if (!toReset) {
      store.temporaryAccountResets[toTemporaryKey] = fromReset;
    } else {
      const fromTime = new Date(fromReset.resetAt || 0).getTime();
      const toTime = new Date(toReset.resetAt || 0).getTime();
      if (Number.isFinite(fromTime) && (!Number.isFinite(toTime) || fromTime > toTime)) {
        store.temporaryAccountResets[toTemporaryKey] = fromReset;
      }
    }
    delete store.temporaryAccountResets[fromTemporaryKey];
  }
}

function mergeAccountStatsKey(store, fromStatsKey, toStatsKey) {
  if (!fromStatsKey || !toStatsKey || fromStatsKey === toStatsKey) return;
  for (const dayEntry of Object.values(store.daily || {})) {
    if (!dayEntry || !dayEntry.accounts || !dayEntry.accounts[fromStatsKey]) continue;
    dayEntry.accounts[toStatsKey] = mergeTokenBreakdowns(
      dayEntry.accounts[toStatsKey] || createEmptyTokenBreakdown(),
      dayEntry.accounts[fromStatsKey]
    );
    delete dayEntry.accounts[fromStatsKey];
  }
  if (store.accounts && store.accounts[fromStatsKey]) {
    store.accounts[toStatsKey] = mergeTokenBreakdowns(
      store.accounts[toStatsKey] || createEmptyTokenBreakdown(),
      store.accounts[fromStatsKey]
    );
    delete store.accounts[fromStatsKey];
  }
  for (const event of Object.values(store.usageEvents || {})) {
    if (event && event.statsKey === fromStatsKey) {
      event.statsKey = toStatsKey;
    }
  }
  const fromMeta = store.accountMeta && store.accountMeta[fromStatsKey];
  if (fromMeta) {
    const toMeta = store.accountMeta[toStatsKey] || createEmptyAccountMeta();
    store.accountMeta[toStatsKey] = {
      ...fromMeta,
      ...toMeta,
      statsKey: toStatsKey,
      temporaryKey: toMeta.temporaryKey || fromMeta.temporaryKey || null,
      firstSeenAt: fromMeta.firstSeenAt || toMeta.firstSeenAt || null,
      lastSeenAt: toMeta.lastSeenAt || fromMeta.lastSeenAt || null
    };
    delete store.accountMeta[fromStatsKey];
  }
}

function mergeAccountStatsAliases(store, entry, entries = []) {
  const canonicalStatsKey = buildAccountStatsKey(entry);
  if (!store || !entry || !canonicalStatsKey) return;
  const canonicalTemporaryKey = buildTemporaryStatsKey(entry);
  const candidates = buildAccountStatsKeyCandidates(entry);
  const data = entry.data || {};
  const canonicalProvider = normalizeIdentityValue(entry.type || mapAuthTypeToService(data.type));
  const canonicalAccountId = normalizeIdentityValue(data.account_id || data.accountId || data.chatgpt_account_id || data.chatgptAccountId);
  const canonicalIdentity = normalizeIdentityValue(data.email || data.login);
  for (const candidate of candidates) {
    if (!candidate || candidate === canonicalStatsKey) continue;
    const sharedCandidate = entries.some((otherEntry) => (
      otherEntry !== entry
        && buildAccountStatsKey(otherEntry) !== canonicalStatsKey
        && buildAccountStatsKeyCandidates(otherEntry).includes(candidate)
    ));
    if (sharedCandidate) continue;
    const candidateMeta = store.accountMeta && store.accountMeta[candidate];
    if (candidateMeta) {
      const candidateProvider = normalizeIdentityValue(candidateMeta.provider);
      const candidateAccountId = normalizeIdentityValue(candidateMeta.accountId);
      const candidateIdentity = normalizeIdentityValue(candidateMeta.email || candidateMeta.login);
      if (candidateProvider && canonicalProvider && candidateProvider !== canonicalProvider) continue;
      if (candidateAccountId && canonicalAccountId && candidateAccountId !== canonicalAccountId) continue;
      if (candidateIdentity && canonicalIdentity && candidateIdentity !== canonicalIdentity) continue;
    }
    mergeAccountStatsKey(store, candidate, canonicalStatsKey);
    mergeTemporaryStatsAlias(store, `${entry.id}::${candidate}`, canonicalTemporaryKey);
  }
}

function guessProviderFromModel(model) {
  const value = String(model || '').trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('claude-')) return 'claude';
  if (value.startsWith('gemini-claude-') || value.startsWith('gemini-3-') || value.startsWith('rev19-')) return 'antigravity';
  if (value.startsWith('gpt-') || value.startsWith('o1') || value.startsWith('o3') || value.startsWith('o4') || value.includes('codex')) return 'codex';
  if (value.startsWith('gemini-') || value.startsWith('gemma-')) return 'gemini';
  if (value.startsWith('glm-')) return 'zai';
  if (value.startsWith('qwen-')) return 'qwen';
  if (value.startsWith('kimi-') || value.includes('moonshot')) return 'kiro';
  return null;
}

function resetStatsAttributionIndexes(provider = null) {
  if (provider) {
    delete statsAttributionIndexes[String(provider)];
    return;
  }
  statsAttributionIndexes = {};
}

function getRequestHeaderValue(headers, names) {
  const source = headers || {};
  for (const name of names) {
    const direct = source[name];
    if (direct != null) return Array.isArray(direct) ? direct[0] : direct;
    const lower = source[String(name).toLowerCase()];
    if (lower != null) return Array.isArray(lower) ? lower[0] : lower;
  }
  return null;
}

function findFirstStringValue(root, keys) {
  const targets = new Set(keys.map(key => String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase()));
  const visited = new Set();

  function walk(value) {
    if (!value || typeof value !== 'object') return null;
    if (visited.has(value)) return null;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }

    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (targets.has(normalizedKey) && nested != null && typeof nested !== 'object') {
        const text = String(nested).trim();
        if (text) return text;
      }
    }

    for (const nested of Object.values(value)) {
      const found = walk(nested);
      if (found) return found;
    }
    return null;
  }

  return walk(root);
}

function findAccountEntryByAccountId(provider, accountId) {
  const normalizedAccountId = String(accountId || '').trim().toLowerCase();
  if (!provider || !normalizedAccountId) return null;
  return listAuthAccountEntries(provider).find((entry) => {
    const data = entry.data || {};
    return [
      data.account_id,
      data.accountId,
      data.chatgpt_account_id,
      data.chatgptAccountId
    ].some((value) => String(value || '').trim().toLowerCase() === normalizedAccountId);
  }) || null;
}

function resolveRoundRobinAccountEntry(provider) {
  const enabledEntries = listAuthAccountEntries(provider).filter((entry) => entry.data.disabled !== true);
  if (enabledEntries.length === 0) return null;
  if (enabledEntries.length === 1) return enabledEntries[0];

  const key = String(provider || 'unknown');
  const index = statsAttributionIndexes[key] || 0;
  const entry = enabledEntries[index % enabledEntries.length];
  statsAttributionIndexes[key] = (index + 1) % enabledEntries.length;
  return entry;
}

function resolveAccountEntryForRequest(body, headers = {}) {
  let provider = null;
  let parsedBody = null;
  try {
    parsedBody = JSON.parse(body || '{}');
    provider = guessProviderFromModel(parsedBody.model);
  } catch (e) {}
  if (!provider) return null;

  const headerAccountId = getRequestHeaderValue(headers, [
    'chatgpt-account-id',
    'x-chatgpt-account-id',
    'openai-account-id',
    'x-openai-account-id',
    'account-id',
    'x-account-id'
  ]);
  const bodyAccountId = parsedBody ? findFirstStringValue(parsedBody, [
    'account_id',
    'accountId',
    'chatgpt_account_id',
    'chatgptAccountId'
  ]) : null;
  const accountMatchedEntry = findAccountEntryByAccountId(provider, headerAccountId || bodyAccountId);
  if (accountMatchedEntry) return accountMatchedEntry;

  const selectedAccounts = getSelectedAccounts();
  const selectedId = selectedAccounts[provider];
  if (selectedId) {
    const selectedEntry = findAuthAccountEntry(selectedId);
    if (selectedEntry && selectedEntry.type === provider && selectedEntry.data.disabled !== true) {
      return selectedEntry;
    }
  }

  return resolveRoundRobinAccountEntry(provider);
}

function sanitizeTokenCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.round(numeric);
}

function createEmptyTokenBreakdown() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requestCount: 0
  };
}

function createEmptyTokenStatsStore() {
  return {
    version: TOKEN_STATS_STORE_VERSION,
    updatedAt: null,
    usageResetAt: null,
    global: createEmptyTokenBreakdown(),
    accounts: {},
    temporaryAccounts: {},
    temporaryAccountResets: {},
    accountMeta: {},
    daily: {},
    usageEvents: {}
  };
}

function createEmptyAccountMeta() {
  return {
    statsKey: null,
    temporaryKey: null,
    provider: null,
    email: null,
    login: null,
    accountId: null,
    firstSeenAt: null,
    lastSeenAt: null,
    lastKnownAccountId: null,
    deletedAt: null
  };
}

function getLocalDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeIsoTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ensureDailyBucket(store, dayKey) {
  if (!store.daily[dayKey]) {
    store.daily[dayKey] = {
      global: createEmptyTokenBreakdown(),
      accounts: {}
    };
  }
  return store.daily[dayKey];
}

function ensureAccountMeta(store, entry, options = {}) {
  const statsKey = options.statsKey || buildAccountStatsKey(entry);
  if (!statsKey) return null;
  const data = (entry && entry.data) || {};
  const existing = store.accountMeta[statsKey] || createEmptyAccountMeta();
  const now = new Date().toISOString();
  const next = {
    ...existing,
    statsKey,
    temporaryKey: options.temporaryKey || existing.temporaryKey || buildTemporaryStatsKey(entry),
    provider: entry ? entry.type : (options.provider || existing.provider || null),
    email: data.email || existing.email || null,
    login: data.login || existing.login || null,
    accountId: data.account_id || data.accountId || data.chatgpt_account_id || data.chatgptAccountId || existing.accountId || null,
    firstSeenAt: existing.firstSeenAt || data.created_at || data.createdAt || (entry && entry.createdAt) || now,
    lastSeenAt: now,
    lastKnownAccountId: entry ? entry.id : (options.lastKnownAccountId || existing.lastKnownAccountId || null),
    deletedAt: options.deleted ? (existing.deletedAt || now) : null
  };
  store.accountMeta[statsKey] = next;
  return next;
}

function ensureTemporaryAccountStats(store, temporaryKey) {
  if (!temporaryKey) return false;
  if (store.temporaryAccounts[temporaryKey]) return false;
  store.temporaryAccounts[temporaryKey] = createEmptyTokenBreakdown();
  return true;
}

function normalizeTemporaryAccountResetMap(value) {
  const next = {};
  for (const [temporaryKey, resetState] of Object.entries(value || {})) {
    const resetAt = typeof resetState === 'string'
      ? resetState
      : (resetState && (resetState.resetAt || resetState.updatedAt || resetState.at));
    if (!resetAt) continue;

    const normalizedResetAt = normalizeIsoTimestamp(resetAt);
    if (!normalizedResetAt) continue;
    const resetDate = new Date(normalizedResetAt);

    next[temporaryKey] = {
      resetAt: normalizedResetAt,
      resetDay: (resetState && resetState.resetDay) || getLocalDayKey(resetDate),
      baseline: mergeTokenBreakdowns(createEmptyTokenBreakdown(), (resetState && resetState.baseline) || {})
    };
  }
  return next;
}

function getTemporaryAccountResetState(store, temporaryKey) {
  if (!temporaryKey) return null;
  const resetState = store.temporaryAccountResets && store.temporaryAccountResets[temporaryKey];
  if (!resetState || !resetState.resetAt) return null;
  return resetState;
}

function getDailyAccountBreakdown(store, dayKey, statsKey) {
  const dayEntry = store.daily && store.daily[dayKey];
  return dayEntry && dayEntry.accounts && dayEntry.accounts[statsKey]
    ? mergeTokenBreakdowns(createEmptyTokenBreakdown(), dayEntry.accounts[statsKey])
    : createEmptyTokenBreakdown();
}

function addUsageToTemporaryResetBaselineIfNeeded(store, temporaryKey, detail, dayKey, usage) {
  const resetState = getTemporaryAccountResetState(store, temporaryKey);
  if (!resetState || resetState.resetDay !== dayKey) return;
  const usageDate = getCliProxyUsageDetailDate(detail);
  const resetAt = normalizeIsoTimestamp(resetState.resetAt);
  if (!usageDate || !resetAt || usageDate.getTime() > new Date(resetAt).getTime()) return;
  resetState.baseline = mergeTokenBreakdowns(resetState.baseline || createEmptyTokenBreakdown(), usage || {});
}

function subtractUsageFromTemporaryResetBaselineIfNeeded(store, temporaryKey, detail, dayKey, usage) {
  const resetState = getTemporaryAccountResetState(store, temporaryKey);
  if (!resetState || resetState.resetDay !== dayKey) return;
  const usageDate = getCliProxyUsageDetailDate(detail);
  const resetAt = normalizeIsoTimestamp(resetState.resetAt);
  if (!usageDate || !resetAt || usageDate.getTime() > new Date(resetAt).getTime()) return;
  resetState.baseline = subtractTokenBreakdowns(resetState.baseline || createEmptyTokenBreakdown(), usage || {});
}

function sumAccountDailyTotals(store, statsKey, options = {}) {
  const totals = createEmptyTokenBreakdown();
  let hasSource = false;
  if (!statsKey) return { totals, hasSource };

  for (const [dayKey, dayEntry] of Object.entries(store.daily || {})) {
    if (options.fromDay && String(dayKey) < String(options.fromDay)) continue;
    const source = dayEntry && dayEntry.accounts && dayEntry.accounts[statsKey];
    if (!source) continue;
    hasSource = true;
    const merged = mergeTokenBreakdowns(totals, source);
    totals.inputTokens = merged.inputTokens;
    totals.outputTokens = merged.outputTokens;
    totals.cachedTokens = merged.cachedTokens;
    totals.reasoningTokens = merged.reasoningTokens;
    totals.totalTokens = merged.totalTokens;
    totals.requestCount = merged.requestCount;
  }

  return { totals, hasSource };
}

function getAccountTotalsFromSource(store, statsKey) {
  const dailyTotals = sumAccountDailyTotals(store, statsKey);
  if (dailyTotals.hasSource) return dailyTotals.totals;
  return mergeTokenBreakdowns(createEmptyTokenBreakdown(), (store.accounts && store.accounts[statsKey]) || {});
}

function getMetaStartDay(meta) {
  const startAt = meta && meta.firstSeenAt;
  if (!startAt) return null;
  const startDate = new Date(startAt);
  return Number.isNaN(startDate.getTime()) ? null : getLocalDayKey(startDate);
}

function buildTemporaryAccountStats(store, statsKey, temporaryKey) {
  const resetState = getTemporaryAccountResetState(store, temporaryKey);
  if (!resetState) {
    const startDay = getMetaStartDay(store.accountMeta && store.accountMeta[statsKey]);
    const dailyTotals = sumAccountDailyTotals(store, statsKey, startDay ? { fromDay: startDay } : {});
    if (dailyTotals.hasSource) return dailyTotals.totals;
    const accountTotals = mergeTokenBreakdowns(createEmptyTokenBreakdown(), (store.accounts && store.accounts[statsKey]) || {});
    if (hasTokenBreakdownStats(accountTotals)) return accountTotals;
    return mergeTokenBreakdowns(createEmptyTokenBreakdown(), (store.temporaryAccounts && store.temporaryAccounts[temporaryKey]) || {});
  }

  const dailyTotals = sumAccountDailyTotals(store, statsKey, { fromDay: resetState.resetDay });
  return subtractTokenBreakdowns(dailyTotals.totals, resetState.baseline || createEmptyTokenBreakdown());
}

function findStatsKeyByTemporaryKey(store, temporaryKey) {
  for (const [statsKey, meta] of Object.entries(store.accountMeta || {})) {
    if (meta && meta.temporaryKey === temporaryKey) return statsKey;
  }
  for (const entry of listAuthAccountEntries()) {
    if (buildTemporaryStatsKey(entry) === temporaryKey) {
      const statsKey = buildAccountStatsKey(entry);
      ensureAccountMeta(store, entry, { statsKey, temporaryKey });
      return statsKey;
    }
  }
  return null;
}

function mergeBreakdownEntries(recordMap) {
  return Object.fromEntries(Object.entries(recordMap || {}).map(([key, value]) => [key, mergeTokenBreakdowns(createEmptyTokenBreakdown(), value || {})]));
}

function normalizeAccountMetaMap(value) {
  const next = {};
  for (const [key, meta] of Object.entries(value || {})) {
    next[key] = {
      ...createEmptyAccountMeta(),
      ...(meta || {}),
      statsKey: key,
      temporaryKey: meta && meta.temporaryKey ? meta.temporaryKey : null
    };
  }
  return next;
}

function normalizeDailyMap(value) {
  const next = {};
  for (const [dayKey, entry] of Object.entries(value || {})) {
    next[dayKey] = {
      global: mergeTokenBreakdowns(createEmptyTokenBreakdown(), (entry && entry.global) || {}),
      accounts: mergeBreakdownEntries(entry && entry.accounts)
    };
  }
  return next;
}

function normalizeUsageEventIndex(value) {
  const next = {};
  for (const [eventKey, event] of Object.entries(value || {})) {
    if (!eventKey) continue;
    const fallbackBreakdown = {
      totalTokens: event && event.totalTokens,
      requestCount: event && event.requestCount
    };
    const breakdown = mergeTokenBreakdowns(createEmptyTokenBreakdown(), (event && event.breakdown) || fallbackBreakdown);
    next[eventKey] = {
      day: event && event.day ? String(event.day) : null,
      statsKey: event && event.statsKey ? String(event.statsKey) : null,
      breakdown,
      totalTokens: sanitizeTokenCount(breakdown.totalTokens),
      requestCount: sanitizeTokenCount(breakdown.requestCount),
      seenAt: event && event.seenAt ? String(event.seenAt) : null
    };
  }
  return next;
}

function normalizeDailyEntry(entry) {
  const next = {
    global: mergeTokenBreakdowns(createEmptyTokenBreakdown(), (entry && entry.global) || {}),
    accounts: mergeBreakdownEntries(entry && entry.accounts)
  };
  const accountTotals = Object.values(next.accounts || {})
    .reduce((acc, totals) => mergeTokenBreakdowns(acc, totals || {}), createEmptyTokenBreakdown());
  next.global = maxTokenBreakdowns(next.global, accountTotals);
  return next;
}

function reconcileTokenStatsStore(store) {
  const storedGlobal = mergeTokenBreakdowns(createEmptyTokenBreakdown(), store.global || {});
  for (const dayEntry of Object.values(store.daily || {})) {
    const accountTotals = Object.values((dayEntry && dayEntry.accounts) || {})
      .reduce((acc, totals) => mergeTokenBreakdowns(acc, totals || {}), createEmptyTokenBreakdown());
    dayEntry.global = maxTokenBreakdowns(dayEntry.global || createEmptyTokenBreakdown(), accountTotals);
  }

  const dailyStatsKeys = new Set(
    Object.values(store.daily || {}).flatMap((dayEntry) => Object.keys((dayEntry && dayEntry.accounts) || {}))
  );
  const nextAccounts = {};
  for (const statsKey of dailyStatsKeys) {
    nextAccounts[statsKey] = sumStoreDailyTotals(store, statsKey);
  }
  store.accounts = nextAccounts;

  const accountTotals = Object.values(store.accounts || {})
    .reduce((acc, totals) => mergeTokenBreakdowns(acc, totals || {}), createEmptyTokenBreakdown());
  const dailyTotals = sumStoreDailyTotals(store, null);
  store.global = hasTokenBreakdownValue(dailyTotals) || hasTokenBreakdownValue(accountTotals)
    ? maxTokenBreakdowns(dailyTotals, accountTotals)
    : storedGlobal;
  return store;
}

function addUsageToDailyStore(store, dayKey, statsKey, usage) {
  const bucket = ensureDailyBucket(store, dayKey);
  bucket.global = mergeTokenBreakdowns(bucket.global || createEmptyTokenBreakdown(), usage);
  bucket.accounts[statsKey] = mergeTokenBreakdowns(bucket.accounts[statsKey] || createEmptyTokenBreakdown(), usage);
}

function getRecentDayKeys(days) {
  const keys = [];
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    keys.push(getLocalDayKey(date));
  }
  return keys;
}

function buildHistorySeries(store, keys, days = 7) {
  const dayKeys = getRecentDayKeys(days);
  return dayKeys.map((dayKey) => {
    const dayEntry = store.daily[dayKey] || {};
    if (!keys) {
      return {
        day: dayKey,
        ...mergeTokenBreakdowns(createEmptyTokenBreakdown(), dayEntry.global || {})
      };
    }

    const total = keys.reduce((acc, key) => mergeTokenBreakdowns(acc, (dayEntry.accounts && dayEntry.accounts[key]) || {}), createEmptyTokenBreakdown());
    return { day: dayKey, ...total };
  });
}

function buildPeriodTotals(store, keys, days) {
  return buildHistorySeries(store, keys, days)
    .reduce((acc, entry) => mergeTokenBreakdowns(acc, entry), createEmptyTokenBreakdown());
}

function buildPeriodStats(store, keys = null) {
  return {
    day: {
      global: buildPeriodTotals(store, keys, 1),
      history: buildHistorySeries(store, keys, 1)
    },
    week: {
      global: buildPeriodTotals(store, keys, 7),
      history: buildHistorySeries(store, keys, 7)
    },
    month: {
      global: buildPeriodTotals(store, keys, 30),
      history: buildHistorySeries(store, keys, 30)
    }
  };
}

function buildDailyDetailRows(store) {
  const rows = [];
  for (const [dayKey, dayEntry] of Object.entries(store.daily || {})) {
    for (const [statsKey, totals] of Object.entries((dayEntry && dayEntry.accounts) || {})) {
      const breakdown = mergeTokenBreakdowns(createEmptyTokenBreakdown(), totals || {});
      const hasStats = breakdown.totalTokens
        || breakdown.inputTokens
        || breakdown.outputTokens
        || breakdown.cachedTokens
        || breakdown.reasoningTokens
        || breakdown.requestCount;
      if (!hasStats) continue;

      const meta = store.accountMeta[statsKey] || createEmptyAccountMeta();
      const provider = meta.provider || String(statsKey.split('::')[0] || 'unknown');
      rows.push({
        id: `${dayKey}::${statsKey}`,
        day: dayKey,
        statsKey,
        provider,
        email: meta.email || meta.login || statsKey,
        login: meta.login || null,
        accountId: meta.accountId || null,
        ...breakdown
      });
    }
  }

  rows.sort((a, b) => {
    const dayOrder = String(b.day || '').localeCompare(String(a.day || ''));
    if (dayOrder !== 0) return dayOrder;
    const providerOrder = String(a.provider || '').localeCompare(String(b.provider || ''));
    if (providerOrder !== 0) return providerOrder;
    return String(a.email || '').localeCompare(String(b.email || ''));
  });

  return rows;
}

function buildDailySummaryRows(store) {
  const rows = [];
  for (const [dayKey, dayEntry] of Object.entries(store.daily || {})) {
    const accountTotals = Object.values((dayEntry && dayEntry.accounts) || {})
      .reduce((acc, totals) => mergeTokenBreakdowns(acc, totals || {}), createEmptyTokenBreakdown());
    const globalTotals = mergeTokenBreakdowns(createEmptyTokenBreakdown(), (dayEntry && dayEntry.global) || {});
    const mergedTotals = maxTokenBreakdowns(globalTotals, accountTotals);
    const hasStats = mergedTotals.totalTokens
      || mergedTotals.inputTokens
      || mergedTotals.outputTokens
      || mergedTotals.cachedTokens
      || mergedTotals.reasoningTokens
      || mergedTotals.requestCount;
    if (!hasStats) continue;

    rows.push({
      id: dayKey,
      day: dayKey,
      ...mergeTokenBreakdowns(createEmptyTokenBreakdown(), mergedTotals)
    });
  }

  rows.sort((a, b) => String(b.day || '').localeCompare(String(a.day || '')));
  return rows;
}

function hasTokenBreakdownStats(value) {
  return !!(value
    && (value.totalTokens
      || value.inputTokens
      || value.outputTokens
      || value.cachedTokens
      || value.reasoningTokens
      || value.requestCount));
}

function buildTokenStatisticsPayload(store) {
  const currentAccounts = getAuthAccounts();
  const currentStatsById = {};
  const temporaryAccounts = {};
  const historicalAccounts = [];
  const historicalByProvider = {};

  for (const account of currentAccounts) {
    const storedTotals = getAccountTotalsFromSource(store, account.statsKey);
    const temporary = buildTemporaryAccountStats(store, account.statsKey, account.temporaryKey);
    temporaryAccounts[account.temporaryKey] = temporary;
    currentStatsById[account.id] = storedTotals;
  }

  const statsKeys = new Set([
    ...Object.keys(store.accounts || {}),
    ...currentAccounts.map((account) => account.statsKey).filter(Boolean)
  ]);

  for (const statsKey of statsKeys) {
    const meta = store.accountMeta[statsKey] || createEmptyAccountMeta();
    const activeAccount = currentAccounts.find((account) => account.statsKey === statsKey) || null;
    const provider = meta.provider || (activeAccount && activeAccount.type) || String(statsKey.split('::')[0] || 'unknown');
    const temporaryKey = activeAccount ? activeAccount.temporaryKey : meta.temporaryKey;
    const temporary = temporaryKey ? buildTemporaryAccountStats(store, statsKey, temporaryKey) : createEmptyTokenBreakdown();
    const totals = getAccountTotalsFromSource(store, statsKey);
    const history = buildHistorySeries(store, [statsKey]);
    const periodStats = buildPeriodStats(store, [statsKey]);
    const record = {
      statsKey,
      provider,
      email: (activeAccount && activeAccount.email) || meta.email || meta.login || statsKey,
      login: (activeAccount && activeAccount.login) || meta.login || null,
      accountId: meta.accountId || null,
      currentAccountId: activeAccount ? activeAccount.id : null,
      deleted: !activeAccount,
      totals: mergeTokenBreakdowns(createEmptyTokenBreakdown(), totals || {}),
      periodTotals: {
        day: periodStats.day.global,
        week: periodStats.week.global,
        month: periodStats.month.global
      },
      temporary,
      history7d: history,
      firstSeenAt: meta.firstSeenAt,
      lastSeenAt: meta.lastSeenAt,
      deletedAt: activeAccount ? null : meta.deletedAt
    };
    historicalAccounts.push(record);
    if (!historicalByProvider[provider]) historicalByProvider[provider] = [];
    historicalByProvider[provider].push(record);
  }

  historicalAccounts.sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
  for (const records of Object.values(historicalByProvider)) {
    records.sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
  }

  return {
    updatedAt: store.updatedAt,
    global: mergeTokenBreakdowns(createEmptyTokenBreakdown(), store.global || {}),
    accounts: currentStatsById,
    temporaryAccounts,
    temporaryAccountResets: store.temporaryAccountResets || {},
    historicalAccounts,
    historicalByProvider,
    periods: buildPeriodStats(store, null),
    history7d: {
      global: buildHistorySeries(store, null)
    },
    dailySummary: buildDailySummaryRows(store),
    dailyDetails: buildDailyDetailRows(store)
  };
}

function mergeTokenBreakdowns(base, extra) {
  const next = {
    inputTokens: sanitizeTokenCount((base && base.inputTokens) || 0) + sanitizeTokenCount((extra && extra.inputTokens) || 0),
    outputTokens: sanitizeTokenCount((base && base.outputTokens) || 0) + sanitizeTokenCount((extra && extra.outputTokens) || 0),
    cachedTokens: sanitizeTokenCount((base && base.cachedTokens) || 0) + sanitizeTokenCount((extra && extra.cachedTokens) || 0),
    reasoningTokens: sanitizeTokenCount((base && base.reasoningTokens) || 0) + sanitizeTokenCount((extra && extra.reasoningTokens) || 0),
    totalTokens: sanitizeTokenCount((base && base.totalTokens) || 0) + sanitizeTokenCount((extra && extra.totalTokens) || 0),
    requestCount: sanitizeTokenCount((base && base.requestCount) || 0) + sanitizeTokenCount((extra && extra.requestCount) || 0)
  };

  if (!next.totalTokens) {
    next.totalTokens = next.inputTokens + next.outputTokens + next.cachedTokens + next.reasoningTokens;
  }

  return next;
}

function subtractTokenBreakdowns(base, extra) {
  return {
    inputTokens: Math.max(0, sanitizeTokenCount((base && base.inputTokens) || 0) - sanitizeTokenCount((extra && extra.inputTokens) || 0)),
    outputTokens: Math.max(0, sanitizeTokenCount((base && base.outputTokens) || 0) - sanitizeTokenCount((extra && extra.outputTokens) || 0)),
    cachedTokens: Math.max(0, sanitizeTokenCount((base && base.cachedTokens) || 0) - sanitizeTokenCount((extra && extra.cachedTokens) || 0)),
    reasoningTokens: Math.max(0, sanitizeTokenCount((base && base.reasoningTokens) || 0) - sanitizeTokenCount((extra && extra.reasoningTokens) || 0)),
    totalTokens: Math.max(0, sanitizeTokenCount((base && base.totalTokens) || 0) - sanitizeTokenCount((extra && extra.totalTokens) || 0)),
    requestCount: Math.max(0, sanitizeTokenCount((base && base.requestCount) || 0) - sanitizeTokenCount((extra && extra.requestCount) || 0))
  };
}

function tokenCountOrNull(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

function firstTokenCount(...values) {
  for (const value of values) {
    const count = tokenCountOrNull(value);
    if (count != null) return count;
  }
  return null;
}

function sumTokenCounts(...values) {
  let total = 0;
  let found = false;
  for (const value of values) {
    const count = tokenCountOrNull(value);
    if (count == null) continue;
    total += count;
    found = true;
  }
  return found ? total : null;
}

function getUsageDetailTokenCount(usage, detailKeys, tokenKeys) {
  for (const detailKey of detailKeys) {
    const detail = usage[detailKey];
    if (!detail || typeof detail !== 'object') continue;
    const count = firstTokenCount(...tokenKeys.map((tokenKey) => detail[tokenKey]));
    if (count != null) return count;
  }
  return null;
}

function normalizeUsageBlock(usage) {
  if (!usage || typeof usage !== 'object') {
    return createEmptyTokenBreakdown();
  }

  const inputTokens = firstTokenCount(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.inputTokens,
    usage.promptTokens,
    usage.prompt
  ) ?? 0;
  const outputTokens = firstTokenCount(
    usage.output_tokens,
    usage.completion_tokens,
    usage.outputTokens,
    usage.completionTokens,
    usage.completion
  ) ?? 0;
  const separateCachedTokens = sumTokenCounts(
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens
  );
  const nestedCachedTokens = getUsageDetailTokenCount(
    usage,
    ['input_tokens_details', 'inputTokensDetails', 'prompt_tokens_details', 'promptTokensDetails'],
    ['cached_tokens', 'cachedTokens']
  );
  const aggregateCachedTokens = firstTokenCount(
    usage.input_cached_tokens,
    usage.inputCachedTokens,
    usage.prompt_cached_tokens,
    usage.promptCachedTokens
  );
  const topLevelCachedTokens = firstTokenCount(
    usage.cached_tokens,
    usage.cache_tokens,
    usage.cachedTokens,
    usage.cacheTokens
  );
  const cachedTokens = separateCachedTokens ?? nestedCachedTokens ?? aggregateCachedTokens ?? topLevelCachedTokens ?? 0;
  const nestedReasoningTokens = getUsageDetailTokenCount(
    usage,
    ['output_tokens_details', 'outputTokensDetails', 'completion_tokens_details', 'completionTokensDetails'],
    ['reasoning_tokens', 'reasoningTokens']
  );
  const separateReasoningTokens = firstTokenCount(
    usage.reasoning_tokens,
    usage.thinking_tokens,
    usage.reasoningTokens,
    usage.thinkingTokens
  );
  const aggregateReasoningTokens = firstTokenCount(
    usage.output_reasoning_tokens,
    usage.outputReasoningTokens,
    usage.completion_reasoning_tokens,
    usage.completionReasoningTokens
  );
  const reasoningTokens = nestedReasoningTokens ?? separateReasoningTokens ?? aggregateReasoningTokens ?? 0;
  const explicitTotalTokens = firstTokenCount(
    usage.total_tokens,
    usage.totalTokens,
    usage.total
  );
  const derivedTotalTokens = inputTokens
    + outputTokens
    + (
      separateCachedTokens != null
        || topLevelCachedTokens != null
        || (aggregateCachedTokens != null && inputTokens === 0 && outputTokens === 0)
        ? cachedTokens
        : 0
    )
    + (
      nestedReasoningTokens == null && aggregateReasoningTokens == null && separateReasoningTokens != null
        ? reasoningTokens
        : 0
    );
  const totalTokens = explicitTotalTokens ?? derivedTotalTokens;

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    totalTokens,
    requestCount: 1
  };
}

function normalizeTokenStatsStorePayload(parsed) {
  if (!parsed || parsed.version !== TOKEN_STATS_STORE_VERSION) {
    return createEmptyTokenStatsStore();
  }

  const store = createEmptyTokenStatsStore();
  store.updatedAt = parsed.updatedAt || null;
  store.usageResetAt = normalizeIsoTimestamp(parsed.usageResetAt || null);
  store.global = mergeTokenBreakdowns(createEmptyTokenBreakdown(), parsed.global || {});
  store.accounts = mergeBreakdownEntries(parsed.accounts || {});
  store.temporaryAccounts = mergeBreakdownEntries(parsed.temporaryAccounts || {});
  store.temporaryAccountResets = normalizeTemporaryAccountResetMap(parsed.temporaryAccountResets || {});
  store.accountMeta = normalizeAccountMetaMap(parsed.accountMeta || {});
  store.daily = normalizeDailyMap(parsed.daily || {});
  store.usageEvents = normalizeUsageEventIndex(parsed.usageEvents || {});

  return reconcileTokenStatsStore(store);
}

function readTokenStatsStoreFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return normalizeTokenStatsStorePayload(parsed);
}

function readTokenStatsStore() {
  try {
    const store = readTokenStatsStoreFile(TOKEN_STATS_FILE);
    if (store) return store;
  } catch (e) {
    console.warn('[TokenStats] Failed to read primary token stats file:', e.message);
  }

  return createEmptyTokenStatsStore();
}

function writeTokenStatsStore(store) {
  ensureParentDir(TOKEN_STATS_FILE);
  const tempFile = `${TOKEN_STATS_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(store, null, 2), 'utf8');
    try { fs.chmodSync(tempFile, 0o600); } catch (e) {}
    fs.renameSync(tempFile, TOKEN_STATS_FILE);
  } catch (e) {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (cleanupError) {}
    throw e;
  }
  try { fs.chmodSync(TOKEN_STATS_FILE, 0o600); } catch (e) {}
}

function queueTokenStatsStoreUpdate(task) {
  const run = tokenStatsStoreQueue.then(task, task);
  tokenStatsStoreQueue = run.catch(() => {});
  return run;
}

function fetchJsonWithElectronNet({ url, headers = {}, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    try {
      const request = electronNet.request({ method: 'GET', url });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        try { request.abort(); } catch (e) {}
        finish({ success: false, error: 'Request timed out' });
      }, timeoutMs);

      for (const [key, value] of Object.entries(headers)) {
        if (value != null && value !== '') {
          request.setHeader(key, value);
        }
      }

      request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            finish({ success: false, error: `HTTP ${response.statusCode}`, details: body.slice(0, 500) });
            return;
          }
          try {
            finish({ success: true, payload: JSON.parse(body || '{}') });
          } catch (e) {
            finish({ success: false, error: 'Response was not valid JSON', details: body.slice(0, 500) });
          }
        });
      });

      request.on('error', (err) => {
        finish({ success: false, error: err.message });
      });

      request.end();
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

function isPlainObjectValue(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getActiveManagementSecretKey() {
  if (activeManagementSecretKey) return activeManagementSecretKey;
  getConfigPath();
  return activeManagementSecretKey || getInternalManagementSecret();
}

function fetchCliProxyUsageStatistics() {
  const managementSecretKey = getActiveManagementSecretKey();
  if (!managementSecretKey) {
    return Promise.resolve({ success: false, error: 'Management key is unavailable' });
  }

  return fetchJsonWithElectronNet({
    url: `http://127.0.0.1:${BACKEND_PORT}/v0/management/usage`,
    headers: {
      Authorization: `Bearer ${managementSecretKey}`,
      Accept: 'application/json'
    },
    timeoutMs: 10000
  });
}

function fetchCliProxyAuthFiles() {
  const managementSecretKey = getActiveManagementSecretKey();
  if (!managementSecretKey) {
    return Promise.resolve({ success: false, error: 'Management key is unavailable' });
  }

  return fetchJsonWithElectronNet({
    url: `http://127.0.0.1:${BACKEND_PORT}/v0/management/auth-files`,
    headers: {
      Authorization: `Bearer ${managementSecretKey}`,
      Accept: 'application/json'
    },
    timeoutMs: 10000
  });
}

function getCliProxyUsageRoot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (isPlainObjectValue(payload.usage)) return payload.usage;
  if (isPlainObjectValue(payload.data) && isPlainObjectValue(payload.data.usage)) return payload.data.usage;
  return isPlainObjectValue(payload) ? payload : null;
}

function getCliProxyAuthFiles(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.files)) return payload.files.filter(isPlainObjectValue);
  if (Array.isArray(payload.data)) return payload.data.filter(isPlainObjectValue);
  if (Array.isArray(payload)) return payload.filter(isPlainObjectValue);
  return [];
}

function stringifyIdentifier(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeIdentityValue(value) {
  return String(value || '').trim().toLowerCase();
}

function addAccountIndexValue(map, value, record) {
  const key = normalizeIdentityValue(value);
  if (!key || map.has(key)) return;
  map.set(key, record);
}

function getCliProxyAuthFileId(authFile) {
  const rawId = stringifyIdentifier(authFile.id || authFile.name || authFile.filename || authFile.file);
  if (rawId) return path.basename(rawId);
  const rawPath = stringifyIdentifier(authFile.path);
  return rawPath ? path.basename(rawPath) : null;
}

function getCliProxyAuthFileAccountId(authFile) {
  const idToken = isPlainObjectValue(authFile.id_token) ? authFile.id_token : {};
  return stringifyIdentifier(
    authFile.account_id
      || authFile.accountId
      || authFile.chatgpt_account_id
      || authFile.chatgptAccountId
      || idToken.chatgpt_account_id
      || idToken.chatgptAccountId
  );
}

function getCliProxyAuthFileIdentity(authFile) {
  return stringifyIdentifier(
    authFile.email
      || authFile.account
      || authFile.login
      || authFile.label
      || authFile.name
  );
}

function buildSyntheticStatsKey(provider, accountId, identity, authFileId) {
  const normalizedProvider = mapAuthTypeToService(provider);
  if (!normalizedProvider || normalizedProvider === 'unknown') return null;
  const suffix = normalizeIdentityValue(accountId || identity || authFileId);
  return suffix ? `${normalizedProvider}::${suffix}` : null;
}

function ensureAuthFileAccountMeta(store, authFile, statsKey, provider, accountId, identity) {
  if (!statsKey) return;
  const existing = store.accountMeta[statsKey] || createEmptyAccountMeta();
  const now = new Date().toISOString();
  store.accountMeta[statsKey] = {
    ...existing,
    statsKey,
    provider: provider || existing.provider || null,
    email: identity || existing.email || null,
    login: existing.login || null,
    accountId: accountId || existing.accountId || null,
    firstSeenAt: existing.firstSeenAt || now,
    lastSeenAt: now,
    lastKnownAccountId: getCliProxyAuthFileId(authFile) || existing.lastKnownAccountId || null,
    deletedAt: authFile.disabled === true ? (existing.deletedAt || now) : existing.deletedAt || null
  };
}

function buildCliProxyUsageAccountIndexes(store, entries, authFiles = []) {
  const indexes = {
    byAuthIndex: new Map(),
    byAccountId: new Map(),
    byIdentity: new Map(),
    byStatsKey: new Map(),
    entriesByProvider: new Map()
  };
  const entriesById = new Map();
  const entriesByPath = new Map();

  for (const entry of entries) {
    const statsKey = buildAccountStatsKey(entry);
    const temporaryKey = buildTemporaryStatsKey(entry);
    if (!statsKey) continue;
    entriesById.set(entry.id, entry);
    entriesByPath.set(path.resolve(entry.filePath), entry);
    ensureAccountMeta(store, entry, { statsKey, temporaryKey });

    const data = entry.data || {};
    const record = { statsKey, entry, temporaryKey, provider: entry.type };
    indexes.byStatsKey.set(statsKey, record);
    addAccountIndexValue(indexes.byAuthIndex, data.auth_index ?? data.authIndex, record);
    addAccountIndexValue(indexes.byAccountId, data.account_id ?? data.accountId, record);
    addAccountIndexValue(indexes.byAccountId, data.chatgpt_account_id ?? data.chatgptAccountId, record);
    addAccountIndexValue(indexes.byIdentity, data.email, record);
    addAccountIndexValue(indexes.byIdentity, data.login, record);
    addAccountIndexValue(indexes.byIdentity, data.name, record);

    const providerEntries = indexes.entriesByProvider.get(entry.type) || [];
    providerEntries.push(record);
    indexes.entriesByProvider.set(entry.type, providerEntries);
  }

  for (const authFile of authFiles) {
    const provider = mapAuthTypeToService(authFile.provider || authFile.type);
    if (!provider || provider === 'unknown') continue;

    const authFileId = getCliProxyAuthFileId(authFile);
    const authFilePath = stringifyIdentifier(authFile.path);
    const entry = (authFileId && entriesById.get(authFileId))
      || (authFilePath && entriesByPath.get(path.resolve(authFilePath)))
      || null;
    const accountId = getCliProxyAuthFileAccountId(authFile);
    const identity = getCliProxyAuthFileIdentity(authFile);
    const statsKey = entry ? buildAccountStatsKey(entry) : buildSyntheticStatsKey(provider, accountId, identity, authFileId);
    if (!statsKey) continue;

    const temporaryKey = entry ? buildTemporaryStatsKey(entry) : null;
    const record = { statsKey, entry, temporaryKey, provider };
    if (!indexes.byStatsKey.has(statsKey)) indexes.byStatsKey.set(statsKey, record);
    addAccountIndexValue(indexes.byAuthIndex, authFile.auth_index ?? authFile.authIndex, record);
    addAccountIndexValue(indexes.byAccountId, accountId, record);
    addAccountIndexValue(indexes.byIdentity, identity, record);
    ensureAuthFileAccountMeta(store, authFile, statsKey, provider, accountId, identity);

    const providerEntries = indexes.entriesByProvider.get(provider) || [];
    if (!providerEntries.some((item) => item.statsKey === statsKey)) {
      providerEntries.push(record);
      indexes.entriesByProvider.set(provider, providerEntries);
    }
  }

  for (const [statsKey, meta] of Object.entries(store.accountMeta || {})) {
    if (!statsKey || indexes.byStatsKey.has(statsKey)) continue;
    const provider = meta.provider || String(statsKey.split('::')[0] || 'unknown');
    const record = { statsKey, entry: null, temporaryKey: meta.temporaryKey || null, provider };
    indexes.byStatsKey.set(statsKey, record);
    addAccountIndexValue(indexes.byAccountId, meta.accountId, record);
    addAccountIndexValue(indexes.byIdentity, meta.email, record);
    addAccountIndexValue(indexes.byIdentity, meta.login, record);
  }

  return indexes;
}

function getUsageDetailAuthIndex(detail) {
  return stringifyIdentifier(
    detail.auth_index
      ?? detail.authIndex
      ?? findFirstStringValue(detail, ['auth_index', 'authIndex'])
  );
}

function getUsageDetailProvider(detail, model) {
  const explicitProvider = stringifyIdentifier(findFirstStringValue(detail, [
    'provider',
    'provider_type',
    'providerType',
    'service',
    'service_type',
    'serviceType'
  ]));
  return mapAuthTypeToService(explicitProvider) || guessProviderFromModel(model);
}

function resolveCliProxyUsageAccountRecord(detail, model, indexes) {
  const explicitStatsKey = stringifyIdentifier(detail.statsKey ?? detail.stats_key);
  if (explicitStatsKey && indexes.byStatsKey.has(explicitStatsKey)) {
    return indexes.byStatsKey.get(explicitStatsKey);
  }

  const accountId = stringifyIdentifier(findFirstStringValue(detail, [
    'account_id',
    'accountId',
    'chatgpt_account_id',
    'chatgptAccountId'
  ]));
  const accountRecord = indexes.byAccountId.get(normalizeIdentityValue(accountId));
  if (accountRecord) return accountRecord;

  const authIndex = getUsageDetailAuthIndex(detail);
  const authRecord = indexes.byAuthIndex.get(normalizeIdentityValue(authIndex));
  if (authRecord) return authRecord;

  const identity = stringifyIdentifier(findFirstStringValue(detail, [
    'email',
    'login',
    'account',
    'username',
    'user'
  ]));
  const identityRecord = indexes.byIdentity.get(normalizeIdentityValue(identity));
  if (identityRecord) return identityRecord;

  const provider = getUsageDetailProvider(detail, model);
  const providerEntries = provider ? indexes.entriesByProvider.get(provider) || [] : [];
  return providerEntries.length === 1 ? providerEntries[0] : null;
}

function getCliProxyUsageDetailDate(detail) {
  const timestamp = stringifyIdentifier(detail.timestamp ?? detail.time ?? detail.created_at ?? detail.createdAt);
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getCliProxyUsageDetailDayKey(detail) {
  const date = getCliProxyUsageDetailDate(detail);
  return date ? getLocalDayKey(date) : getLocalDayKey();
}

function shouldIncludeUsageDetailAfterReset(store, detail) {
  const resetAt = normalizeIsoTimestamp(store && store.usageResetAt);
  if (!resetAt) return true;
  const date = getCliProxyUsageDetailDate(detail);
  return !!(date && date.getTime() > new Date(resetAt).getTime());
}

function normalizeCliProxyUsageDetailBreakdown(detail) {
  const tokenSource = isPlainObjectValue(detail.tokens) ? detail.tokens : detail;
  const breakdown = normalizeUsageBlock(tokenSource);
  breakdown.requestCount = 1;
  return breakdown;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (isPlainObjectValue(value)) {
    const next = {};
    for (const key of Object.keys(value).sort()) {
      next[key] = stableJsonValue(value[key]);
    }
    return next;
  }
  return value;
}

function hashUsageEventIdentity(identity) {
  return crypto.createHash('sha256').update(JSON.stringify(stableJsonValue(identity))).digest('hex');
}

function getUsageDetailEndpoint(detail) {
  return stringifyIdentifier(
    detail.endpoint
      ?? detail.path
      ?? detail.route
      ?? detail.url
      ?? detail.api
      ?? detail.api_path
      ?? detail.apiPath
  );
}

function getUsageEventFallbackIdentity(event, breakdown = null) {
  const detail = (event && event.detail) || {};
  const timestamp = stringifyIdentifier(detail.timestamp ?? detail.time ?? detail.created_at ?? detail.createdAt);
  const normalizedTimestamp = normalizeIsoTimestamp(timestamp);
  if (!normalizedTimestamp) return { detail };

  const normalizedBreakdown = mergeTokenBreakdowns(createEmptyTokenBreakdown(), breakdown || normalizeCliProxyUsageDetailBreakdown(detail));
  const detailModel = stringifyIdentifier(detail.model ?? detail.model_name ?? detail.modelName);
  const detailEndpoint = getUsageDetailEndpoint(detail);

  return {
    timestamp: normalizedTimestamp,
    endpoint: detailEndpoint || null,
    model: detailModel || null,
    tokens: {
      inputTokens: normalizedBreakdown.inputTokens,
      outputTokens: normalizedBreakdown.outputTokens,
      cachedTokens: normalizedBreakdown.cachedTokens,
      reasoningTokens: normalizedBreakdown.reasoningTokens,
      totalTokens: normalizedBreakdown.totalTokens
    }
  };
}

function buildUsageEventKey(event, breakdown = null) {
  const detail = (event && event.detail) || {};
  const explicitId = stringifyIdentifier(
    detail.request_id
      ?? detail.requestId
      ?? detail.requestID
      ?? detail.trace_id
      ?? detail.traceId
      ?? findFirstStringValue(detail, ['request_id', 'requestId', 'requestID', 'trace_id', 'traceId'])
  );
  if (explicitId) {
    return `id:${normalizeIdentityValue(explicitId)}`;
  }

  return `hash:${hashUsageEventIdentity(getUsageEventFallbackIdentity(event, breakdown))}`;
}

function collectCliProxyUsageDetails(usageRoot) {
  const events = [];
  const addDetails = (details, context = {}) => {
    if (!Array.isArray(details)) return;
    for (const detail of details) {
      if (!isPlainObjectValue(detail)) continue;
      events.push({
        detail,
        model: stringifyIdentifier(detail.model ?? detail.model_name ?? detail.modelName) || context.model || null,
        endpoint: context.endpoint || null
      });
    }
  };

  addDetails(usageRoot.details, {});

  const apis = isPlainObjectValue(usageRoot.apis) ? usageRoot.apis : {};
  for (const [endpoint, apiStats] of Object.entries(apis)) {
    if (!isPlainObjectValue(apiStats)) continue;
    addDetails(apiStats.details, { endpoint });
    const models = isPlainObjectValue(apiStats.models) ? apiStats.models : {};
    for (const [model, modelStats] of Object.entries(models)) {
      if (!isPlainObjectValue(modelStats)) continue;
      addDetails(modelStats.details, { endpoint, model });
    }
  }

  return events;
}

function addUsageToDailyGlobalStore(store, dayKey, usage) {
  const bucket = ensureDailyBucket(store, dayKey);
  bucket.global = mergeTokenBreakdowns(bucket.global || createEmptyTokenBreakdown(), usage);
}

function hasTokenBreakdownValue(value) {
  return !!(value && (
    value.totalTokens
      || value.inputTokens
      || value.outputTokens
      || value.cachedTokens
      || value.reasoningTokens
      || value.requestCount
  ));
}

function hasTokenBreakdownTokens(value) {
  return !!(value && (
    value.totalTokens
      || value.inputTokens
      || value.outputTokens
      || value.cachedTokens
      || value.reasoningTokens
  ));
}

function maxTokenBreakdowns(base, extra) {
  const next = {
    inputTokens: Math.max(sanitizeTokenCount((base && base.inputTokens) || 0), sanitizeTokenCount((extra && extra.inputTokens) || 0)),
    outputTokens: Math.max(sanitizeTokenCount((base && base.outputTokens) || 0), sanitizeTokenCount((extra && extra.outputTokens) || 0)),
    cachedTokens: Math.max(sanitizeTokenCount((base && base.cachedTokens) || 0), sanitizeTokenCount((extra && extra.cachedTokens) || 0)),
    reasoningTokens: Math.max(sanitizeTokenCount((base && base.reasoningTokens) || 0), sanitizeTokenCount((extra && extra.reasoningTokens) || 0)),
    totalTokens: Math.max(sanitizeTokenCount((base && base.totalTokens) || 0), sanitizeTokenCount((extra && extra.totalTokens) || 0)),
    requestCount: Math.max(sanitizeTokenCount((base && base.requestCount) || 0), sanitizeTokenCount((extra && extra.requestCount) || 0))
  };
  if (!next.totalTokens) {
    next.totalTokens = next.inputTokens + next.outputTokens + next.cachedTokens + next.reasoningTokens;
  }
  return next;
}

function normalizeCliProxyAggregateBreakdown(tokenValue, requestValue = null) {
  let breakdown = createEmptyTokenBreakdown();
  if (isPlainObjectValue(tokenValue)) {
    breakdown = normalizeUsageBlock(tokenValue);
  } else {
    breakdown.totalTokens = sanitizeTokenCount(tokenValue);
  }
  breakdown.requestCount = sanitizeTokenCount(
    requestValue
      ?? (isPlainObjectValue(tokenValue) ? tokenValue.total_requests ?? tokenValue.totalRequests ?? tokenValue.request_count ?? tokenValue.requestCount : 0)
  );
  return breakdown;
}

function buildCliProxyAggregateStore(usageRoot) {
  const aggregateStore = createEmptyTokenStatsStore();
  let hasStats = false;

  const rootBreakdown = normalizeCliProxyAggregateBreakdown(
    {
      input_tokens: usageRoot.input_tokens,
      output_tokens: usageRoot.output_tokens,
      cached_tokens: usageRoot.cached_tokens,
      cache_tokens: usageRoot.cache_tokens,
      reasoning_tokens: usageRoot.reasoning_tokens,
      total_tokens: usageRoot.total_tokens
    },
    usageRoot.total_requests ?? usageRoot.totalRequests
  );
  if (hasTokenBreakdownValue(rootBreakdown)) {
    aggregateStore.global = maxTokenBreakdowns(aggregateStore.global, rootBreakdown);
    hasStats = true;
  }

  const tokensByDay = isPlainObjectValue(usageRoot.tokens_by_day)
    ? usageRoot.tokens_by_day
    : (isPlainObjectValue(usageRoot.tokensByDay) ? usageRoot.tokensByDay : {});
  const requestsByDay = isPlainObjectValue(usageRoot.requests_by_day)
    ? usageRoot.requests_by_day
    : (isPlainObjectValue(usageRoot.requestsByDay) ? usageRoot.requestsByDay : {});
  const dayKeys = new Set([...Object.keys(tokensByDay), ...Object.keys(requestsByDay)]);

  for (const dayKey of dayKeys) {
    const breakdown = normalizeCliProxyAggregateBreakdown(tokensByDay[dayKey], requestsByDay[dayKey]);
    if (!hasTokenBreakdownValue(breakdown)) continue;
    addUsageToDailyGlobalStore(aggregateStore, dayKey, breakdown);
    aggregateStore.global = maxTokenBreakdowns(aggregateStore.global, breakdown);
    hasStats = true;
  }

  return { store: aggregateStore, hasStats };
}

function applyCliProxyAggregateStore(store, aggregateStore) {
  store.global = maxTokenBreakdowns(store.global || createEmptyTokenBreakdown(), aggregateStore.global || createEmptyTokenBreakdown());
  for (const [dayKey, dayEntry] of Object.entries(aggregateStore.daily || {})) {
    const target = ensureDailyBucket(store, dayKey);
    target.global = maxTokenBreakdowns(target.global || createEmptyTokenBreakdown(), (dayEntry && dayEntry.global) || createEmptyTokenBreakdown());
  }
}

function sumStoreDailyTotals(store, statsKey = null) {
  let totals = createEmptyTokenBreakdown();
  for (const dayEntry of Object.values(store.daily || {})) {
    const source = statsKey
      ? ((dayEntry && dayEntry.accounts && dayEntry.accounts[statsKey]) || null)
      : ((dayEntry && dayEntry.global) || null);
    if (source) {
      totals = mergeTokenBreakdowns(totals, source);
    }
  }
  return totals;
}

function appendDailyEntryFromCliProxyDetails(store, dayKey, sourceDayEntry) {
  const sourceNextDayEntry = normalizeDailyEntry(sourceDayEntry || null);
  const bucket = ensureDailyBucket(store, dayKey);
  bucket.global = mergeTokenBreakdowns(bucket.global || createEmptyTokenBreakdown(), sourceNextDayEntry.global);
  for (const [statsKey, totals] of Object.entries(sourceNextDayEntry.accounts || {})) {
    bucket.accounts[statsKey] = mergeTokenBreakdowns(bucket.accounts[statsKey] || createEmptyTokenBreakdown(), totals || {});
  }
}

function appendAccountUsageToDailyStore(store, dayKey, statsKey, usage) {
  if (!statsKey) return;
  const bucket = ensureDailyBucket(store, dayKey);
  bucket.accounts[statsKey] = mergeTokenBreakdowns(bucket.accounts[statsKey] || createEmptyTokenBreakdown(), usage || {});
}

function subtractAccountUsageFromDailyStore(store, dayKey, statsKey, usage) {
  if (!statsKey) return;
  const bucket = store.daily && store.daily[dayKey];
  if (!bucket || !bucket.accounts || !bucket.accounts[statsKey]) return;
  const next = subtractTokenBreakdowns(bucket.accounts[statsKey], usage || {});
  if (hasTokenBreakdownValue(next)) {
    bucket.accounts[statsKey] = next;
  } else {
    delete bucket.accounts[statsKey];
  }
}

function getTemporaryKeyForStatsKey(store, indexes, statsKey) {
  if (!statsKey) return null;
  const indexedRecord = indexes && indexes.byStatsKey ? indexes.byStatsKey.get(statsKey) : null;
  if (indexedRecord && indexedRecord.temporaryKey) return indexedRecord.temporaryKey;
  const meta = store.accountMeta && store.accountMeta[statsKey];
  return meta && meta.temporaryKey ? meta.temporaryKey : null;
}

function applyCliProxyDetailedStore(store, detailedStore) {
  for (const [dayKey, dayEntry] of Object.entries(detailedStore.daily || {})) {
    appendDailyEntryFromCliProxyDetails(store, dayKey, dayEntry);
  }
  store.accountMeta = {
    ...(store.accountMeta || {}),
    ...(detailedStore.accountMeta || {})
  };
}

function syncCliProxyUsageStatistics(store, payload, authFiles = []) {
  const usageRoot = getCliProxyUsageRoot(payload);
  if (!usageRoot) {
    return { success: false, error: 'Usage payload is empty' };
  }

  const entries = listAuthAccountEntries();
  ensureTokenStatsAccountMetadata(store, entries);
  const rebuiltStore = createEmptyTokenStatsStore();
  rebuiltStore.accountMeta = normalizeAccountMetaMap(store.accountMeta || {});
  const existingUsageEvents = normalizeUsageEventIndex(store.usageEvents || {});
  const nextUsageEvents = { ...existingUsageEvents };
  const indexes = buildCliProxyUsageAccountIndexes(rebuiltStore, entries, authFiles);
  const sourceEvents = collectCliProxyUsageDetails(usageRoot);
  const events = sourceEvents.filter((event) => shouldIncludeUsageDetailAfterReset(store, event.detail));
  const hasExistingEventIndex = Object.keys(existingUsageEvents).length > 0;
  const hasTokenEvents = events.some((event) => hasTokenBreakdownTokens(normalizeCliProxyUsageDetailBreakdown(event.detail)));
  const rebuildFromDetailedEvents = hasTokenEvents && !hasExistingEventIndex;
  const now = new Date().toISOString();
  let attributedCount = 0;

  if (rebuildFromDetailedEvents) {
    store.global = createEmptyTokenBreakdown();
    store.accounts = {};
    store.daily = {};
    store.temporaryAccounts = {};
    store.usageEvents = {};
  }

  for (const event of events) {
    const breakdown = normalizeCliProxyUsageDetailBreakdown(event.detail);
    if (!hasTokenBreakdownTokens(breakdown)) continue;

    const dayKey = getCliProxyUsageDetailDayKey(event.detail);
    const eventKey = buildUsageEventKey(event, breakdown);
    const accountRecord = resolveCliProxyUsageAccountRecord(event.detail, event.model, indexes);
    const existingEvent = eventKey ? nextUsageEvents[eventKey] : null;
    if (existingEvent) {
      let nextEventRecord = existingEvent;
      if (accountRecord && accountRecord.statsKey && existingEvent.statsKey !== accountRecord.statsKey) {
        const attributedDayKey = existingEvent.day || dayKey;
        const attributedBreakdown = hasTokenBreakdownTokens(existingEvent.breakdown)
          ? existingEvent.breakdown
          : breakdown;
        if (existingEvent.statsKey) {
          const previousTemporaryKey = getTemporaryKeyForStatsKey(store, indexes, existingEvent.statsKey);
          subtractUsageFromTemporaryResetBaselineIfNeeded(store, previousTemporaryKey, event.detail, attributedDayKey, attributedBreakdown);
          subtractAccountUsageFromDailyStore(store, attributedDayKey, existingEvent.statsKey, attributedBreakdown);
          subtractAccountUsageFromDailyStore(rebuiltStore, attributedDayKey, existingEvent.statsKey, attributedBreakdown);
        }
        addUsageToTemporaryResetBaselineIfNeeded(store, accountRecord.temporaryKey, event.detail, attributedDayKey, attributedBreakdown);
        appendAccountUsageToDailyStore(store, attributedDayKey, accountRecord.statsKey, attributedBreakdown);
        nextEventRecord = {
          ...existingEvent,
          day: attributedDayKey,
          statsKey: accountRecord.statsKey,
          breakdown: mergeTokenBreakdowns(createEmptyTokenBreakdown(), attributedBreakdown),
          totalTokens: sanitizeTokenCount(attributedBreakdown.totalTokens),
          requestCount: sanitizeTokenCount(attributedBreakdown.requestCount),
          seenAt: existingEvent.seenAt || now
        };
        attributedCount += 1;
      }
      if (eventKey) {
        nextUsageEvents[eventKey] = nextEventRecord;
      }
      continue;
    }

    if (eventKey) {
      nextUsageEvents[eventKey] = {
        day: dayKey,
        statsKey: accountRecord && accountRecord.statsKey ? accountRecord.statsKey : null,
        breakdown: mergeTokenBreakdowns(createEmptyTokenBreakdown(), breakdown),
        totalTokens: sanitizeTokenCount(breakdown.totalTokens),
        requestCount: sanitizeTokenCount(breakdown.requestCount),
        seenAt: now
      };
    }

    if (accountRecord && accountRecord.statsKey) {
      attributedCount += 1;
      addUsageToTemporaryResetBaselineIfNeeded(store, accountRecord.temporaryKey, event.detail, dayKey, breakdown);
      addUsageToDailyStore(rebuiltStore, dayKey, accountRecord.statsKey, breakdown);
      if (accountRecord.entry) {
        ensureAccountMeta(rebuiltStore, accountRecord.entry, {
          statsKey: accountRecord.statsKey,
          temporaryKey: accountRecord.temporaryKey
        });
      }
    } else {
      addUsageToDailyGlobalStore(rebuiltStore, dayKey, breakdown);
    }
  }

  if (hasTokenEvents) {
    applyCliProxyDetailedStore(store, rebuiltStore);
    store.usageEvents = nextUsageEvents;
    store.updatedAt = now;
    reconcileTokenStatsStore(store);
    return { success: true, detailed: true, detailCount: events.length, attributedCount };
  }

  const aggregate = buildCliProxyAggregateStore(usageRoot);
  if (aggregate.hasStats && normalizeIsoTimestamp(store.usageResetAt)) {
    return { success: false, error: 'Aggregate usage cannot be safely applied after token statistics were reset' };
  }
  if (aggregate.hasStats) {
    applyCliProxyAggregateStore(store, aggregate.store);
    store.updatedAt = now;
    reconcileTokenStatsStore(store);
    return { success: true, detailed: false, aggregate: true };
  }

  return { success: false, error: 'Usage payload has no token statistics' };
}

async function fetchCliProxyUsageSyncInputs() {
  const cliProxyUsageResult = await fetchCliProxyUsageStatistics();
  if (!cliProxyUsageResult.success) {
    return cliProxyUsageResult;
  }

  const authFilesResult = await fetchCliProxyAuthFiles();
  const authFiles = authFilesResult.success ? getCliProxyAuthFiles(authFilesResult.payload) : [];
  return {
    success: true,
    payload: cliProxyUsageResult.payload,
    authFiles
  };
}

async function runBackgroundTokenStatsSync() {
  if (tokenStatsSyncInFlight) {
    tokenStatsSyncPending = true;
    return tokenStatsSyncActivePromise || Promise.resolve();
  }

  tokenStatsSyncInFlight = true;
  tokenStatsSyncActivePromise = (async () => {
    try {
      await queueTokenStatsStoreUpdate(async () => {
        const inputs = await fetchCliProxyUsageSyncInputs();
        if (!inputs.success) {
          return;
        }
        const store = readTokenStatsStore();
        const syncResult = syncCliProxyUsageStatistics(store, inputs.payload, inputs.authFiles);
        if (syncResult.success) {
          writeTokenStatsStore(store);
        }
      });
    } catch (e) {
    } finally {
      tokenStatsSyncInFlight = false;
      tokenStatsSyncActivePromise = null;
      if (tokenStatsSyncPending) {
        tokenStatsSyncPending = false;
        scheduleBackgroundTokenStatsSync();
      }
    }
  })();
  return tokenStatsSyncActivePromise;
}

function scheduleBackgroundTokenStatsSync() {
  if (tokenStatsSyncTimer) {
    clearTimeout(tokenStatsSyncTimer);
  }
  tokenStatsSyncTimer = setTimeout(() => {
    tokenStatsSyncTimer = null;
    runBackgroundTokenStatsSync();
  }, TOKEN_STATS_BACKGROUND_SYNC_DELAY_MS);
}

async function flushPendingTokenStatsSync() {
  if (tokenStatsSyncTimer) {
    clearTimeout(tokenStatsSyncTimer);
    tokenStatsSyncTimer = null;
  }
  await runBackgroundTokenStatsSync();
  if (tokenStatsSyncTimer) {
    clearTimeout(tokenStatsSyncTimer);
    tokenStatsSyncTimer = null;
    await runBackgroundTokenStatsSync();
  }
}

async function refreshTokenStatistics() {
  try {
    return await queueTokenStatsStoreUpdate(async () => {
      const entries = listAuthAccountEntries();
      const cliProxyInputs = await fetchCliProxyUsageSyncInputs().catch((error) => ({
        success: false,
        error: error && error.message ? error.message : 'Usage sync failed'
      }));

      const store = readTokenStatsStore();
      ensureTokenStatsAccountMetadata(store, entries);

      if (cliProxyInputs.success) {
        syncCliProxyUsageStatistics(store, cliProxyInputs.payload, cliProxyInputs.authFiles);
      }
      writeTokenStatsStore(store);
      return {
        success: true,
        stats: buildTokenStatisticsPayload(store)
      };
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getTokenStatistics() {
  try {
    const store = readTokenStatsStore();
    ensureTokenStatsAccountMetadata(store);
    return {
      success: true,
      stats: buildTokenStatisticsPayload(store)
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function resetAllTokenStatistics() {
  try {
    return await queueTokenStatsStoreUpdate(async () => {
      const resetAt = new Date().toISOString();
      const store = createEmptyTokenStatsStore();
      store.updatedAt = resetAt;
      store.usageResetAt = resetAt;
      writeTokenStatsStore(store);
      return {
        success: true,
        stats: buildTokenStatisticsPayload(store)
      };
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getCodexUsage(accountId) {
  return new Promise((resolve) => {
    try {
      const account = listAuthAccountEntries('codex').find(entry => entry.id === accountId);
      if (!account) {
        resolve({ success: false, error: 'Codex account not found' });
        return;
      }

      const accessToken = account.data.access_token || account.data.token;
      if (!accessToken) {
        resolve({ success: false, error: 'This Codex account is missing an access token' });
        return;
      }

      const request = electronNet.request({
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/usage'
      });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        try { request.abort(); } catch (e) {}
        finish({ success: false, error: 'Usage query timed out' });
      }, 15000);

      request.setHeader('Authorization', `Bearer ${accessToken}`);
      request.setHeader('Accept', 'application/json');
      request.setHeader('User-Agent', 'ToapiProxy');
      if (account.data.account_id) {
        request.setHeader('ChatGPT-Account-Id', account.data.account_id);
      }

      request.on('response', (response) => {
        let body = '';

        response.on('data', (chunk) => {
          body += chunk.toString();
        });

        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            finish({
              success: false,
              error: `Usage query failed with HTTP ${response.statusCode}`,
              details: body.slice(0, 500)
            });
            return;
          }

          try {
            const payload = JSON.parse(body || '{}');
            const usage = normalizeCodexUsageResponse(payload);
            usage.retrievedAt = new Date().toISOString();
            finish({ success: true, usage });
          } catch (e) {
            finish({
              success: false,
              error: 'Usage response was not valid JSON',
              details: body.slice(0, 500)
            });
          }
        });
      });

      request.on('error', (err) => {
        finish({ success: false, error: err.message });
      });

      request.end();
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

// ============== Thinking Proxy ==============

function startThinkingProxy() {
  return new Promise((resolve, reject) => {
    if (thinkingProxyServer) {
      resolve();
      return;
    }

    let settled = false;
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    thinkingProxyServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        let modifiedBody = body;
        let thinkingEnabled = false;

        if (req.method === 'POST' && body) {
          const result = processThinkingParameter(body);
          if (result) {
            modifiedBody = result.body;
            thinkingEnabled = result.thinkingEnabled;
          }
        }

        const options = {
          hostname: '127.0.0.1',
          port: BACKEND_PORT,
          path: req.url,
          method: req.method,
          headers: { ...req.headers }
        };

        options.headers['content-length'] = Buffer.byteLength(modifiedBody);
        options.headers.host = `127.0.0.1:${BACKEND_PORT}`;

        if (thinkingEnabled) {
          const beta = 'interleaved-thinking-2025-05-14';
          if (options.headers['anthropic-beta']) {
            if (!options.headers['anthropic-beta'].includes(beta)) {
              options.headers['anthropic-beta'] += `,${beta}`;
            }
          } else {
            options.headers['anthropic-beta'] = beta;
          }
        }

        const proxyReq = http.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);

          proxyRes.on('data', (chunk) => {
            res.write(chunk);
          });

          proxyRes.on('end', () => {
            res.end();
            scheduleBackgroundTokenStatsSync();
          });
        });

        proxyReq.on('error', () => {
          res.writeHead(502);
          res.end('Bad Gateway');
        });

        proxyReq.write(modifiedBody);
        proxyReq.end();
      });
    });

    thinkingProxyServer.on('error', (err) => {
      thinkingProxyServer = null;
      if (err && err.code === 'EADDRINUSE') {
        finishReject(new Error(
          `Port ${PROXY_PORT} is already in use on 127.0.0.1. Another BeitaProxy instance or another app is already running there. Please quit the old instance and try again.`
        ));
        return;
      }
      finishReject(err);
    });

    thinkingProxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
      console.log(`[Proxy] Listening on port ${PROXY_PORT}`);
      finishResolve();
    });
  });
}

function processThinkingParameter(jsonString) {
  try {
    const json = JSON.parse(jsonString);
    const model = json.model;
    if (!model || (!model.startsWith('claude-') && !model.startsWith('gemini-claude-'))) {
      return null;
    }

    const match = model.match(/-thinking-(\d+)$/);
    if (match) {
      const budget = Math.min(parseInt(match[1], 10), 31999);
      const cleanModel = model.replace(/-thinking-\d+$/, '');
      json.model = cleanModel;
      json.thinking = { type: 'enabled', budget_tokens: budget };

      const requiredMax = budget + Math.max(1024, Math.floor(budget * 0.1));
      if (!json.max_tokens || json.max_tokens <= budget) {
        json.max_tokens = Math.min(requiredMax, 32000);
      }

      console.log(`[Proxy] Transformed ${model} -> ${cleanModel} with thinking budget ${budget}`);
      return { body: JSON.stringify(json), thinkingEnabled: true };
    }

    if (model.endsWith('-thinking')) {
      return { body: jsonString, thinkingEnabled: true };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function stopThinkingProxy() {
  return new Promise((resolve) => {
    if (!thinkingProxyServer) {
      resolve();
      return;
    }
    const server = thinkingProxyServer;
    thinkingProxyServer = null;
    server.close(() => resolve());
  });
}

// ============== Backend Server ==============

function waitForBackendExit(proc) {
  return new Promise((resolve) => {
    if (!proc) {
      resolve();
      return;
    }
    proc.once('close', () => resolve());
  });
}

async function startBackendServer() {
  const binaryPath = getBackendBinaryPath();
  const configPath = getConfigPath();

  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Binary not found: ${binaryPath}`);
  }

  try { fs.chmodSync(binaryPath, 0o755); } catch (e) {}

  const env = { ...process.env };
  const proxyUrl = getActiveProxyUrl();
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env.all_proxy = proxyUrl;
    console.log(`[Backend] Using proxy: ${proxyUrl}`);
  }

  const proc = spawn(binaryPath, ['-config', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });

  serverProcess = proc;
  let startupError = null;

  proc.stdout.on('data', (data) => console.log(`[Backend] ${data}`));
  proc.stderr.on('data', (data) => console.log(`[Backend] ${data}`));

  proc.on('error', (err) => {
    startupError = err;
    console.error('[Backend] Failed to start:', err);
  });

  proc.on('close', (code) => {
    console.log(`[Backend] Exited with code ${code}`);
    if (serverProcess === proc) {
      serverProcess = null;
      isServerRunning = false;
      updateTray();
    }
  });

  await waitForPort('127.0.0.1', BACKEND_PORT).catch((error) => {
    throw startupError || error;
  });
}

async function stopBackendServer() {
  if (!serverProcess) {
    return;
  }

  const proc = serverProcess;
  const exitPromise = waitForBackendExit(proc);

  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { encoding: 'utf8' }); } catch (e) {}
  } else {
    try { proc.kill('SIGTERM'); } catch (e) {}
  }

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        if (process.platform === 'win32') {
          try { execSync(`taskkill /PID ${proc.pid} /T /F`, { encoding: 'utf8' }); } catch (e) {}
        } else {
          try { process.kill(proc.pid, 'SIGKILL'); } catch (e) {}
        }
      }
      resolve();
    }, STOP_TIMEOUT_MS);
  });

  await Promise.race([exitPromise, timeoutPromise]);
  await exitPromise;
}

// ============== Server Control ==============

async function startServerInternal() {
  if (isServerRunning) return;

  ensureAuthDir();
  resetStatsAttributionIndexes();
  await startThinkingProxy();
  await waitForPort('127.0.0.1', PROXY_PORT);
  await startBackendServer();
  await waitForPort('127.0.0.1', BACKEND_PORT);
  isServerRunning = true;
  updateTray();
  showNotification('Server Started', `BeitaProxy is running on port ${PROXY_PORT}`);
}

async function stopServerInternal() {
  await stopThinkingProxy();
  await flushPendingTokenStatsSync();
  await stopBackendServer();
  isServerRunning = false;
  updateTray();
}

function startServer() {
  return enqueueServerOperation(async () => {
    if (isServerRunning) return;
    try {
      await startServerInternal();
    } catch (err) {
      console.error('Failed to start server:', err);
      await stopServerInternal().catch(() => {});
      showNotification('Server Failed', err.message);
      throw err;
    }
  });
}

function stopServer() {
  return enqueueServerOperation(async () => {
    if (!isServerRunning && !serverProcess && !thinkingProxyServer) return;
    await stopServerInternal();
  });
}

function restartServerIfRunning() {
  return enqueueServerOperation(async () => {
    if (!isServerRunning) return false;
    await stopServerInternal();
    await startServerInternal();
    return true;
  });
}

// ============== Auth Commands ==============

function runAuthCommand(command, email = null, options = {}) {
  return new Promise((resolve) => {
    const allowCodexDeviceFallback = options.allowCodexDeviceFallback !== false;
    const commandConfig = AUTH_COMMANDS[command] || {};
    const serviceType = commandConfig.serviceType || null;
    if (serviceType && authSessions[serviceType]) {
      resolve({ success: false, code: 'AUTH_ALREADY_RUNNING', output: `${serviceType} authentication already in progress. Please finish or wait for it to close.` });
      return;
    }

    const binaryPath = getBackendBinaryPath();
    const configPath = getConfigPath();
    const env = { ...process.env };
    const proxyUrl = getActiveProxyUrl();
    if (proxyUrl) {
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;
      env.ALL_PROXY = proxyUrl;
      env.all_proxy = proxyUrl;
    }

    const args = ['--config', configPath, command];
    const expectedCallbackPort = commandConfig.expectedCallbackPort || null;

    const startCodexDeviceLogin = () => {
      runAuthCommand('-codex-device-login', email, { allowCodexDeviceFallback: false })
        .then(resolve)
        .catch((err) => {
          resolve({
            success: false,
            output: formatAuthFailureOutput(err.message, 'Codex browser authentication failed, and automatic device login fallback also failed.')
          });
        });
    };

    const startAuthProcess = () => {
      const proc = spawn(binaryPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env
      });

      let output = '';
      let settled = false;
      let browserOpened = false;
      let copiedDeviceCode = null;
      let promptHandled = false;
      let keepAliveSent = false;
      let processClosed = false;
      let authDetected = false;
      const previousSnapshot = serviceType ? createAuthEntrySnapshot(serviceType) : null;
      const completionWaiter = serviceType ? createAuthCompletionWaiter(serviceType, previousSnapshot) : null;

      const cleanupBeforeResolve = () => {
        if (completionWaiter) completionWaiter.cancel();
        if (serviceType) cleanupAuthSession(serviceType);
      };

      const resolveOnce = (result) => {
        if (settled) return;
        settled = true;
        cleanupBeforeResolve();
        resolve(result);
      };

      const fallbackToCodexDeviceLogin = () => {
        if (settled) return;
        settled = true;
        cleanupBeforeResolve();
        startCodexDeviceLogin();
      };

      const sendInput = (value) => {
        if (!value || proc.exitCode !== null || proc.killed) return false;
        try {
          proc.stdin.write(value);
          return true;
        } catch (e) {
          return false;
        }
      };

      const sendPromptInput = () => {
        if (command === '-qwen-login') {
          return email ? sendInput(email + '\n') : false;
        }
        return sendInput(commandConfig.fallbackInput || '\n');
      };

      const sendKeepAlive = () => sendInput('\n');

      const markBrowserOpened = () => {
        if (browserOpened) return;
        browserOpened = true;
        if ((command === '-github-copilot-login' || command === '-codex-device-login') && copiedDeviceCode) {
          const providerName = command === '-codex-device-login' ? 'Codex' : 'GitHub Copilot';
          showNotification(providerName, `Device code copied to clipboard: ${copiedDeviceCode}`);
        }
        if (completionWaiter) completionWaiter.check();
      };

      if (serviceType) {
        authSessions[serviceType] = {
          proc,
          cancel: (reason) => {
            resolveOnce({
              success: false,
              code: 'AUTH_CANCELLED',
              output: reason
            });
          }
        };
      }

      if (completionWaiter) {
        completionWaiter.promise.then((result) => {
          if (settled) return;
          if (result.changed) {
            authDetected = true;
            if (processClosed) {
              scheduleObservedInputsRefresh('Authentication credentials detected');
              resolveOnce({ success: true, output });
            }
            return;
          }
          if (!processClosed && serviceType) {
            stopAuthSession(serviceType, formatAuthFailureOutput(output, 'Timed out waiting for authentication to complete.'));
            return;
          }
          resolveOnce({
            success: false,
            code: 'AUTH_TIMEOUT',
            output: formatAuthFailureOutput(output, 'Timed out waiting for credentials to be saved.')
          });
        });
      }

      const handleOutput = (chunk) => {
        const text = chunk.toString();
        output += text;
        console.log('[Auth]', text);
        const normalized = output.toLowerCase();

        if (commandConfig.promptPattern && !promptHandled && commandConfig.promptPattern.test(output)) {
          promptHandled = sendPromptInput() || promptHandled;
        }

        if (commandConfig.keepAlivePattern && !keepAliveSent && commandConfig.keepAlivePattern.test(output)) {
          keepAliveSent = true;
          setTimeout(() => {
            sendKeepAlive();
          }, 1000);
        }

        const codeMatch = output.match(/enter(?: the)? code:\s*([A-Z0-9-]+)/i);
        if (codeMatch && !copiedDeviceCode) {
          copiedDeviceCode = codeMatch[1];
          clipboard.writeText(copiedDeviceCode);
        }

        if (/opening browser|open this url|open url|visit the following url|visit|device login|authenticate in browser|browser opened|enter(?: the)? code/i.test(normalized) || copiedDeviceCode) {
          markBrowserOpened();
        }
      };

      proc.stdout.on('data', handleOutput);
      proc.stderr.on('data', handleOutput);

      proc.on('error', (err) => {
        processClosed = true;
        resolveOnce({ success: false, output: err.message });
      });

      const fallbackDelayMs = commandConfig.fallbackDelayMs || commandConfig.keepAliveDelayMs;
      if (fallbackDelayMs) {
        setTimeout(() => {
          if (settled || proc.exitCode !== null || proc.killed) return;
          if (commandConfig.keepAlivePattern) {
            if (!keepAliveSent) {
              keepAliveSent = sendKeepAlive();
            }
            return;
          }
          if (!promptHandled) {
            promptHandled = sendPromptInput() || promptHandled;
          }
        }, fallbackDelayMs);
      }

      proc.on('close', (code) => {
        processClosed = true;
        scheduleObservedInputsRefresh('Auth command completed');

        if (!completionWaiter) {
          resolveOnce({ success: code === 0, output });
          return;
        }

        if (allowCodexDeviceFallback && command === '-codex-login' && shouldUseCodexDeviceLoginFallback(output, code)) {
          fallbackToCodexDeviceLogin();
          return;
        }

        if (code !== 0 && !browserOpened && !copiedDeviceCode) {
          resolveOnce({
            success: false,
            output: formatAuthFailureOutput(output, `Authentication process exited with code ${code}.`)
          });
          return;
        }

        setTimeout(() => {
          if (settled) return;
          completionWaiter.check();
          if (settled) return;
          if (authDetected) {
            scheduleObservedInputsRefresh('Authentication credentials detected');
            resolveOnce({ success: true, output });
            return;
          }
          resolveOnce({
            success: false,
            output: formatAuthFailureOutput(
              output,
              code === 0
                ? 'Authentication finished but no new credentials were detected.'
                : 'Authentication failed before new credentials were saved.'
            )
          });
        }, AUTH_PROCESS_EXIT_GRACE_MS);
      });
    };

    if (allowCodexDeviceFallback && command === '-codex-login' && expectedCallbackPort) {
      canListenOnPort('127.0.0.1', expectedCallbackPort)
        .then((canListen) => {
          if (!canListen) {
            startCodexDeviceLogin();
            return;
          }
          startAuthProcess();
        })
        .catch(() => startAuthProcess());
      return;
    }

    startAuthProcess();
  });
}

// ============== UI ==============

const {
  showNotification,
  createTray,
  updateTray,
  openDashboard,
  openSettings
} = createAppUiController({
  app,
  fs,
  remoteMain,
  startServer,
  stopServer,
  isServerRunning: () => isServerRunning,
  getLanguagePreference,
  proxyPort: PROXY_PORT,
  backendPort: BACKEND_PORT
});

// ============== App Lifecycle ==============

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  loadEnabledProviders();
  loadLaunchAtLogin();
  ensureAuthDir();
  getConfigPath();
  startObservedInputMonitoring();
  await applyNetworkProxy();
  createTray();
  startServer().catch(() => {});

  if (checkKiroToken()) {
    startKiroAutoSync();
  }

  setTimeout(openSettings, 1000);
});

app.on('window-all-closed', (e) => e.preventDefault());

async function cleanupBeforeQuit() {
  if (tokenStatsSyncTimer) {
    clearTimeout(tokenStatsSyncTimer);
    tokenStatsSyncTimer = null;
  }
  cleanupAllAuthSessions();
  stopObservedInputMonitoring();
  stopKiroAutoSync();
  await stopServer();
}

app.on('before-quit', (event) => {
  if (quitCleanupComplete) return;
  event.preventDefault();

  if (!quitCleanupPromise) {
    quitCleanupPromise = cleanupBeforeQuit()
      .catch((error) => {
        console.warn('[App] Failed during quit cleanup:', error && error.message ? error.message : error);
      })
      .finally(() => {
        quitCleanupComplete = true;
        app.quit();
      });
  }
});

app.on('second-instance', () => {
  openSettings();
});

// ============== Export for Settings Window ==============

global.beitaProxy = {
  // Server
  isServerRunning: () => isServerRunning,
  startServer,
  stopServer,
  restartServerIfRunning,
  getPort: () => PROXY_PORT,
  openDashboard,

  // Providers
  isProviderEnabled,
  setProviderEnabled,

  // Auth
  getAuthAccounts,
  toggleAccountDisabled,
  designateAccountForUse,
  deleteAccount,
  checkCodexLocalAuth,
  getCodexLocalAuthStatus,
  getCodexLocalAuthPath,
  importCodexLocalAuth,
  switchCodexLocalAuth,
  stopCodexAuth: () => stopAuthSession('codex'),
  getCodexUsage,
  getTokenStatistics,
  refreshTokenStatistics,
  resetTemporaryTokenStats,
  resetTemporaryTokenStatsForAccount,
  resetAllTokenStatistics,
  runAuthCommand,
  saveZaiApiKey,

  // Kiro
  checkKiroToken,
  importKiroToken,
  syncKiroTokenFromIDE,
  getKiroAuthUrl,

  // Launch at login
  getLaunchAtLogin,
  setLaunchAtLogin,
  getLocalProxyUrl,
  setLocalProxyUrl,
  getLanguagePreference,
  setLanguagePreference,

  // Utility
  openAuthFolder: () => {
    ensureAuthDir();
    shell.openPath(AUTH_DIR);
  },
  getVersion: () => APP_VERSION
};

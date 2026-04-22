const { app, clipboard, shell, net: electronNet, session } = require('electron');
const remoteMain = require('@electron/remote/main');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
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
const CODEX_LOCAL_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');
const APP_VERSION = '1.0.0';
const CONFIG_FILE = path.join(AUTH_DIR, 'beitaproxy-config.json');
const TOKEN_STATS_FILE = path.join(app.getPath('userData'), 'token-stats.json');
const STARTUP_READINESS_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 4000;
const OBSERVED_INPUTS_DEBOUNCE_MS = 400;
const AUTH_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_COMPLETION_POLL_MS = 500;
const AUTH_PROCESS_EXIT_GRACE_MS = 3000;

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
  return process.platform === 'win32' ? 'cli-proxy-api-plus.exe' : 'cli-proxy-api-plus';
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
        const mappedType = mapAuthTypeToService(data.type);
        if (!mappedType) continue;
        if (serviceType && mappedType !== serviceType) continue;

        entries.push({
          id: file,
          filePath,
          type: mappedType,
          data
        });
      } catch (e) {}
    }
  } catch (e) {}

  return entries;
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
  const needsMergedConfig = isUserConfig || disabledProviders.length > 0 || zaiKeys.length > 0;

  if (!needsMergedConfig) {
    return bundledConfigPath;
  }

  const runtimeRoot = composeRuntimeConfig({
    baseRoot: baseRoot,
    disabledProviders,
    zaiKeys,
    zaiEnabled: isProviderEnabled('zai')
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
  const store = readTokenStatsStore();
  let changed = false;

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
    const meta = ensureAccountMeta(store, entry, { statsKey, temporaryKey });
    if (meta) changed = true;
    if (ensureTemporaryAccountStats(store, temporaryKey)) {
      changed = true;
    }

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

  if (changed) {
    writeTokenStatsStore(store);
  }

  return accounts;
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

function deleteAccount(filePath) {
  try {
    const entry = listAuthAccountEntries().find((item) => item.filePath === filePath);
    if (entry) {
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
      }
      writeTokenStatsStore(store);
    }
    fs.unlinkSync(filePath);
    getConfigPath();
    requestRestartAfterConfigChange();
    return true;
  } catch (e) {
    return false;
  }
}

function resetTemporaryTokenStats(temporaryKey) {
  try {
    if (!temporaryKey) {
      return { success: false, error: 'Temporary token key is required' };
    }
    const store = readTokenStatsStore();
    store.temporaryAccounts[temporaryKey] = createEmptyTokenBreakdown();
    store.updatedAt = new Date().toISOString();
    writeTokenStatsStore(store);
    return { success: true, stats: buildTokenStatisticsPayload(store) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function resetTemporaryTokenStatsForAccount(accountId) {
  try {
    const entry = findAuthAccountEntry(accountId);
    if (!entry) {
      return { success: false, error: 'Account not found' };
    }
    const temporaryKey = buildTemporaryStatsKey(entry);
    const result = resetTemporaryTokenStats(temporaryKey);
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
  const normalizedAccountId = String(data.account_id || '').trim().toLowerCase();
  const normalizedEmail = String(data.email || data.login || '').trim().toLowerCase();
  return [normalizedType, normalizedAccountId || normalizedEmail || entry.id].join('::');
}

function buildTemporaryStatsKey(entry) {
  if (!entry) return null;
  const statsKey = buildAccountStatsKey(entry);
  if (!statsKey) return null;
  return `${entry.id}::${statsKey}`;
}

function guessProviderFromModel(model) {
  const value = String(model || '').trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('claude-')) return 'claude';
  if (value.startsWith('gpt-') || value.startsWith('o1') || value.startsWith('o3') || value.startsWith('o4') || value.includes('codex')) return 'codex';
  if (value.startsWith('gemini-') || value.startsWith('gemma-')) return 'gemini';
  if (value.startsWith('glm-')) return 'zai';
  if (value.startsWith('qwen-')) return 'qwen';
  if (value.startsWith('kimi-') || value.includes('moonshot')) return 'kiro';
  return null;
}

function resolveAccountEntryForRequest(body) {
  let provider = null;
  try {
    const json = JSON.parse(body || '{}');
    provider = guessProviderFromModel(json.model);
  } catch (e) {}
  if (!provider) return null;

  const selectedAccounts = getSelectedAccounts();
  const selectedId = selectedAccounts[provider];
  if (selectedId) {
    const selectedEntry = findAuthAccountEntry(selectedId);
    if (selectedEntry && selectedEntry.type === provider && selectedEntry.data.disabled !== true) {
      return selectedEntry;
    }
  }

  const enabledEntries = listAuthAccountEntries(provider).filter((entry) => entry.data.disabled !== true);
  if (enabledEntries.length === 1) {
    return enabledEntries[0];
  }

  return null;
}

function sanitizeTokenCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.round(numeric);
}

function findFirstNumericValue(root, keys) {
  const targets = new Set(keys.map(key => String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase()));
  const visited = new Set();

  function walk(value) {
    if (!value || typeof value !== 'object') return null;
    if (visited.has(value)) return null;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found != null) return found;
      }
      return null;
    }

    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (targets.has(normalizedKey)) {
        const numeric = Number(nested);
        if (Number.isFinite(numeric)) return numeric;
      }
    }

    for (const nested of Object.values(value)) {
      const found = walk(nested);
      if (found != null) return found;
    }

    return null;
  }

  return walk(root);
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
    version: 2,
    updatedAt: null,
    global: createEmptyTokenBreakdown(),
    accounts: {},
    temporaryAccounts: {},
    accountMeta: {},
    daily: {},
    providerSnapshots: {}
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
    accountId: data.account_id || existing.accountId || null,
    firstSeenAt: existing.firstSeenAt || now,
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

function buildTokenStatisticsPayload(store) {
  const currentAccounts = getAuthAccounts();
  const currentStatsById = {};
  const temporaryAccounts = {};
  const historicalAccounts = [];
  const historicalByProvider = {};

  for (const account of currentAccounts) {
    currentStatsById[account.id] = mergeTokenBreakdowns(createEmptyTokenBreakdown(), store.accounts[account.statsKey] || {});
    ensureTemporaryAccountStats(store, account.temporaryKey);
    temporaryAccounts[account.temporaryKey] = mergeTokenBreakdowns(createEmptyTokenBreakdown(), store.temporaryAccounts[account.temporaryKey] || {});
  }

  for (const [statsKey, totals] of Object.entries(store.accounts || {})) {
    const meta = store.accountMeta[statsKey] || createEmptyAccountMeta();
    const activeAccount = currentAccounts.find((account) => account.statsKey === statsKey) || null;
    const provider = meta.provider || (activeAccount && activeAccount.type) || String(statsKey.split('::')[0] || 'unknown');
    const temporaryKey = activeAccount ? buildTemporaryStatsKey({ id: activeAccount.id, type: activeAccount.type, data: { account_id: meta.accountId, email: activeAccount.email, login: activeAccount.login } }) : meta.temporaryKey;
    const temporary = temporaryKey ? mergeTokenBreakdowns(createEmptyTokenBreakdown(), store.temporaryAccounts[temporaryKey] || {}) : createEmptyTokenBreakdown();
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
    historicalAccounts,
    historicalByProvider,
    periods: buildPeriodStats(store, null),
    history7d: {
      global: buildHistorySeries(store, null)
    }
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

function normalizeUsageBlock(usage) {
  if (!usage || typeof usage !== 'object') {
    return createEmptyTokenBreakdown();
  }

  const inputTokens = sanitizeTokenCount(
    usage.input_tokens
      ?? usage.prompt_tokens
      ?? usage.inputTokens
      ?? usage.promptTokens
      ?? usage.prompt
      ?? 0
  );
  const outputTokens = sanitizeTokenCount(
    usage.output_tokens
      ?? usage.completion_tokens
      ?? usage.outputTokens
      ?? usage.completionTokens
      ?? usage.completion
      ?? 0
  );
  const cachedTokens = sanitizeTokenCount(
    usage.cache_creation_input_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_tokens
      ?? usage.cachedTokens
      ?? usage.cacheTokens
      ?? 0
  );
  const reasoningTokens = sanitizeTokenCount(
    usage.reasoning_tokens
      ?? usage.thinking_tokens
      ?? usage.reasoningTokens
      ?? usage.thinkingTokens
      ?? 0
  );
  const hasDetailedBreakdown = !!(
    usage.input_tokens != null
      || usage.prompt_tokens != null
      || usage.inputTokens != null
      || usage.promptTokens != null
      || usage.output_tokens != null
      || usage.completion_tokens != null
      || usage.outputTokens != null
      || usage.completionTokens != null
      || usage.reasoning_tokens != null
      || usage.thinking_tokens != null
      || usage.reasoningTokens != null
      || usage.thinkingTokens != null
  );
  const derivedTotalTokens = inputTokens + outputTokens + cachedTokens + reasoningTokens;
  const totalTokens = hasDetailedBreakdown
    ? sanitizeTokenCount(derivedTotalTokens)
    : sanitizeTokenCount(
        usage.total_tokens
          ?? usage.totalTokens
          ?? usage.total
          ?? derivedTotalTokens
      );

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    totalTokens,
    requestCount: 1
  };
}

function extractUsageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.usage && typeof payload.usage === 'object') return payload.usage;
  if (payload.message && typeof payload.message.usage === 'object') return payload.message.usage;
  if (payload.delta && typeof payload.delta.usage === 'object') return payload.delta.usage;
  if (payload.response && typeof payload.response.usage === 'object') return payload.response.usage;
  if (payload.completion && typeof payload.completion.usage === 'object') return payload.completion.usage;
  if (payload.result && typeof payload.result.usage === 'object') return payload.result.usage;
  if (Array.isArray(payload.output)) {
    for (let index = payload.output.length - 1; index >= 0; index -= 1) {
      const usage = extractUsageFromPayload(payload.output[index]);
      if (usage) return usage;
    }
  }
  return null;
}

function extractUsageFromSseBuffer(bufferText) {
  if (!bufferText) return null;

  const events = bufferText.split(/\r?\n\r?\n/);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const rawEvent = events[index];
    if (!rawEvent || !rawEvent.includes('data:')) continue;

    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (!dataLines.length) continue;

    const dataText = dataLines.join('\n');
    if (dataText === '[DONE]') continue;

    try {
      const payload = JSON.parse(dataText);
      const usage = extractUsageFromPayload(payload);
      if (usage) return usage;
    } catch (e) {}
  }

  return null;
}

function extractUsageFromJsonLines(bufferText) {
  if (!bufferText) return null;

  const lines = bufferText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === '[DONE]') continue;
    const jsonText = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!jsonText || jsonText === '[DONE]') continue;

    try {
      const payload = JSON.parse(jsonText);
      const usage = extractUsageFromPayload(payload);
      if (usage) return usage;
    } catch (e) {}
  }

  return null;
}

function extractUsageFromResponse(responseText, contentType) {
  if (!responseText) return null;

  if (contentType.includes('application/json')) {
    try {
      return extractUsageFromPayload(JSON.parse(responseText));
    } catch (e) {}
  }

  if (contentType.includes('text/event-stream') || responseText.includes('\ndata:') || responseText.startsWith('data:')) {
    const usage = extractUsageFromSseBuffer(responseText);
    if (usage) return usage;
  }

  return extractUsageFromJsonLines(responseText);
}

function readTokenStatsStore() {
  try {
    if (!fs.existsSync(TOKEN_STATS_FILE)) {
      return createEmptyTokenStatsStore();
    }
    const parsed = JSON.parse(fs.readFileSync(TOKEN_STATS_FILE, 'utf8'));
    const store = createEmptyTokenStatsStore();
    store.updatedAt = parsed.updatedAt || null;
    store.global = mergeTokenBreakdowns(createEmptyTokenBreakdown(), parsed.global || {});
    store.accounts = mergeBreakdownEntries(parsed.accounts || {});
    store.temporaryAccounts = mergeBreakdownEntries(parsed.temporaryAccounts || {});
    store.accountMeta = normalizeAccountMetaMap(parsed.accountMeta || {});
    store.daily = normalizeDailyMap(parsed.daily || {});
    store.providerSnapshots = parsed.providerSnapshots && typeof parsed.providerSnapshots === 'object' ? parsed.providerSnapshots : {};

    if (parsed.version === 1) {
      for (const statsKey of Object.keys(store.accounts)) {
        if (!store.accountMeta[statsKey]) {
          const parts = statsKey.split('::');
          store.accountMeta[statsKey] = {
            ...createEmptyAccountMeta(),
            statsKey,
            provider: parts[0] || null,
            email: parts.slice(1).join('::') || statsKey,
            firstSeenAt: store.updatedAt,
            lastSeenAt: store.updatedAt
          };
        }
      }
    }

    return store;
  } catch (e) {
    return createEmptyTokenStatsStore();
  }
}

function writeTokenStatsStore(store) {
  ensureParentDir(TOKEN_STATS_FILE);
  fs.writeFileSync(TOKEN_STATS_FILE, JSON.stringify(store, null, 2), 'utf8');
  try { fs.chmodSync(TOKEN_STATS_FILE, 0o600); } catch (e) {}
}

function recordTokenUsage(statsKey, usage, options = {}) {
  if (!statsKey) return;
  const normalizedUsage = normalizeUsageBlock(usage);
  if (!normalizedUsage.totalTokens && !normalizedUsage.inputTokens && !normalizedUsage.outputTokens && !normalizedUsage.cachedTokens && !normalizedUsage.reasoningTokens) {
    return;
  }

  const store = readTokenStatsStore();
  const now = new Date();
  const dayKey = getLocalDayKey(now);
  const updatedAt = now.toISOString();
  store.accounts[statsKey] = mergeTokenBreakdowns(store.accounts[statsKey] || createEmptyTokenBreakdown(), normalizedUsage);
  store.global = mergeTokenBreakdowns(store.global || createEmptyTokenBreakdown(), normalizedUsage);
  if (options.temporaryKey) {
    ensureTemporaryAccountStats(store, options.temporaryKey);
    store.temporaryAccounts[options.temporaryKey] = mergeTokenBreakdowns(store.temporaryAccounts[options.temporaryKey] || createEmptyTokenBreakdown(), normalizedUsage);
  }
  addUsageToDailyStore(store, dayKey, statsKey, normalizedUsage);
  if (options.entry) {
    ensureAccountMeta(store, options.entry, {
      statsKey,
      temporaryKey: options.temporaryKey
    });
  }
  store.updatedAt = updatedAt;
  writeTokenStatsStore(store);
}

function extractClaudeUsageSnapshot(payload) {
  const total = sanitizeTokenCount(findFirstNumericValue(payload, ['total_tokens', 'totalTokens', 'used_tokens', 'usedTokens', 'tokens_used']));
  const input = sanitizeTokenCount(findFirstNumericValue(payload, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']));
  const output = sanitizeTokenCount(findFirstNumericValue(payload, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']));
  const cached = sanitizeTokenCount(findFirstNumericValue(payload, ['cache_creation_input_tokens', 'cache_read_input_tokens', 'cached_tokens', 'cachedTokens']));
  const reasoning = sanitizeTokenCount(findFirstNumericValue(payload, ['reasoning_tokens', 'reasoningTokens', 'thinking_tokens', 'thinkingTokens']));
  const normalizedTotal = total || input + output + cached + reasoning;
  if (!normalizedTotal && !input && !output && !cached && !reasoning) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: normalizedTotal,
    requestCount: 0
  };
}

function extractCodexUsageSnapshot(payload) {
  const total = sanitizeTokenCount(findFirstNumericValue(payload, ['total_tokens', 'totalTokens', 'used_tokens', 'usedTokens']));
  if (!total) return null;
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: total,
    requestCount: 0
  };
}

function extractKimiUsageSnapshot(payload) {
  const usage = payload && typeof payload.usage === 'object' ? payload.usage : payload;
  const used = sanitizeTokenCount(findFirstNumericValue(usage, ['used', 'used_tokens', 'usedTokens', 'total_tokens', 'totalTokens']));
  const input = sanitizeTokenCount(findFirstNumericValue(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']));
  const output = sanitizeTokenCount(findFirstNumericValue(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']));
  const cached = sanitizeTokenCount(findFirstNumericValue(usage, ['cached_tokens', 'cachedTokens']));
  const reasoning = sanitizeTokenCount(findFirstNumericValue(usage, ['reasoning_tokens', 'reasoningTokens']));
  const total = used || input + output + cached + reasoning;
  if (!total && !input && !output && !cached && !reasoning) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: total,
    requestCount: 0
  };
}

function updateSnapshotTotals(store, previousSnapshot, nextSnapshot, statsKey, options = {}) {
  const previous = mergeTokenBreakdowns(createEmptyTokenBreakdown(), previousSnapshot || {});
  const next = mergeTokenBreakdowns(createEmptyTokenBreakdown(), nextSnapshot || {});
  const delta = {
    inputTokens: Math.max(0, next.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
    cachedTokens: Math.max(0, next.cachedTokens - previous.cachedTokens),
    reasoningTokens: Math.max(0, next.reasoningTokens - previous.reasoningTokens),
    totalTokens: Math.max(0, next.totalTokens - previous.totalTokens),
    requestCount: 0
  };
  if (!delta.totalTokens && !delta.inputTokens && !delta.outputTokens && !delta.cachedTokens && !delta.reasoningTokens) {
    return false;
  }
  store.accounts[statsKey] = mergeTokenBreakdowns(store.accounts[statsKey] || createEmptyTokenBreakdown(), delta);
  store.global = mergeTokenBreakdowns(store.global || createEmptyTokenBreakdown(), delta);
  addUsageToDailyStore(store, getLocalDayKey(), statsKey, delta);
  if (options.entry) {
    ensureAccountMeta(store, options.entry, {
      statsKey,
      temporaryKey: options.temporaryKey
    });
  }
  return true;
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

async function refreshTokenStatistics() {
  try {
    const store = readTokenStatsStore();
    const entries = listAuthAccountEntries();

    for (const entry of entries) {
      const statsKey = buildAccountStatsKey(entry);
      const temporaryKey = buildTemporaryStatsKey(entry);
      if (!statsKey) continue;
      ensureAccountMeta(store, entry, { statsKey, temporaryKey });
      const provider = entry.type;
      const accessToken = entry.data.access_token || entry.data.token;
      if (!accessToken) continue;

      let result = null;
      let snapshot = null;
      let snapshotKey = null;

      if (provider === 'claude') {
        result = await fetchJsonWithElectronNet({
          url: 'https://api.anthropic.com/api/oauth/usage',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'anthropic-beta': 'oauth-2025-04-20'
          }
        });
        snapshot = result.success ? extractClaudeUsageSnapshot(result.payload) : null;
        snapshotKey = `claude:${statsKey}`;
      } else if (provider === 'codex') {
        result = await fetchJsonWithElectronNet({
          url: 'https://chatgpt.com/backend-api/wham/usage',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'User-Agent': 'ToapiProxy',
            ...(entry.data.account_id ? { 'ChatGPT-Account-Id': entry.data.account_id } : {})
          }
        });
        snapshot = result.success ? extractCodexUsageSnapshot(result.payload) : null;
        snapshotKey = `codex:${statsKey}`;
      } else if (provider === 'kiro') {
        result = await fetchJsonWithElectronNet({
          url: 'https://api.kimi.com/coding/v1/usages',
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        snapshot = result.success ? extractKimiUsageSnapshot(result.payload) : null;
        snapshotKey = `kiro:${statsKey}`;
      }

      if (!snapshotKey) continue;
      if (snapshot) {
        store.providerSnapshots[snapshotKey] = snapshot;
        store.updatedAt = new Date().toISOString();
      }
    }

    writeTokenStatsStore(store);
    return {
      success: true,
      stats: buildTokenStatisticsPayload(store)
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getTokenStatistics() {
  try {
    const store = readTokenStatsStore();
    for (const entry of listAuthAccountEntries()) {
      ensureAccountMeta(store, entry, {
        statsKey: buildAccountStatsKey(entry),
        temporaryKey: buildTemporaryStatsKey(entry)
      });
    }
    writeTokenStatsStore(store);
    return {
      success: true,
      stats: buildTokenStatisticsPayload(store)
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function resetAllTokenStatistics() {
  try {
    const store = createEmptyTokenStatsStore();
    writeTokenStatsStore(store);
    return {
      success: true,
      stats: buildTokenStatisticsPayload(store)
    };
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

        const resolvedAccountEntry = req.method === 'POST' ? resolveAccountEntryForRequest(modifiedBody) : null;
        const resolvedStatsKey = resolvedAccountEntry ? buildAccountStatsKey(resolvedAccountEntry) : null;
        const resolvedTemporaryKey = resolvedAccountEntry ? buildTemporaryStatsKey(resolvedAccountEntry) : null;
        const responseChunks = [];

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
            responseChunks.push(Buffer.from(chunk));
            res.write(chunk);
          });

          proxyRes.on('end', () => {
            res.end();
            if (!resolvedStatsKey) return;
            const contentType = String(proxyRes.headers['content-type'] || '').toLowerCase();
            const responseText = Buffer.concat(responseChunks).toString('utf8');
            recordTokenUsage(resolvedStatsKey, extractUsageFromResponse(responseText, contentType), {
              entry: resolvedAccountEntry,
              temporaryKey: resolvedTemporaryKey
            });
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

app.on('before-quit', async () => {
  cleanupAllAuthSessions();
  stopObservedInputMonitoring();
  stopKiroAutoSync();
  await stopServer();
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

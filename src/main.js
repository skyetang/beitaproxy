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
    delete config.selectedAccounts;
    config.localProxyUrl = localProxyUrl;
    writeAppConfig(config);
  } catch (e) {}
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
  } catch (e) {
    launchAtLogin = false;
    localProxyUrl = '';
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

    accounts.push({
      id: entry.id,
      type: entry.type,
      email: data.email || data.login || entry.id,
      login: data.login,
      expired,
      expiredDate: data.expired,
      disabled: data.disabled === true,
      path: entry.filePath
    });
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

function deleteAccount(filePath) {
  try {
    fs.unlinkSync(filePath);
    getConfigPath();
    requestRestartAfterConfigChange();
    return true;
  } catch (e) {
    return false;
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
          proxyRes.pipe(res);
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
  deleteAccount,
  checkCodexLocalAuth,
  getCodexLocalAuthStatus,
  getCodexLocalAuthPath,
  importCodexLocalAuth,
  stopCodexAuth: () => stopAuthSession('codex'),
  getCodexUsage,
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

  // Utility
  openAuthFolder: () => {
    ensureAuthDir();
    shell.openPath(AUTH_DIR);
  },
  getVersion: () => APP_VERSION
};

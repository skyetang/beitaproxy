const { shell } = require('electron');
const { createUsageRenderer } = require('./settings-usage');
const { createServicesController } = require('./settings-services');
let vp;
try {
  vp = require('@electron/remote').getGlobal('beitaProxy');
} catch (e) {
  vp = require('electron').remote.getGlobal('beitaProxy');
}

const SERVICES = [
  { type: 'antigravity', name: 'Antigravity', icon: 'icon-antigravity.png', cmd: '-antigravity-login' },
  { type: 'claude', name: 'Claude Code', icon: 'icon-claude.png', cmd: '-claude-login' },
  { type: 'codex', name: 'Codex', icon: 'icon-codex.png', cmd: '-codex-login' },
  { type: 'gemini', name: 'Gemini', icon: 'icon-gemini.png', cmd: '-login' },
  { type: 'github-copilot', name: 'GitHub Copilot', icon: 'icon-copilot.png', cmd: '-github-copilot-login' },
  { type: 'kiro', name: 'Kiro (AWS)', icon: 'icon-kiro.png', webAuth: true },
  { type: 'qwen', name: 'Qwen', icon: 'icon-qwen.png', cmd: '-qwen-login', needsEmail: true },
  { type: 'zai', name: 'Z.AI GLM', icon: 'icon-zai.png', needsApiKey: true }
];

let authenticating = null;
let serverStatusLoading = false;
const expanded = new Set();
const expandedUsage = new Set();
const expandedTokenAccounts = new Set();
let activeSection = 'services';
let currentLanguage = (vp.getLanguagePreference ? vp.getLanguagePreference() : loadLanguagePreference()) || 'zh';
const usageStates = {};
const temporaryTokenStates = {};
const accountDetailTabs = {};
let tokenStatsState = { loading: false, error: null, stats: null };
let tokenStatsPeriod = 'week';
const codexLocalAuthPath = vp.getCodexLocalAuthPath ? vp.getCodexLocalAuthPath() : '~/.codex/auth.json';

const { renderUsageState, renderTokenStatsPage, renderTemporaryTokenState } = createUsageRenderer({
  t,
  getLocale,
  getLanguage: () => currentLanguage,
  escapeHtml,
  sanitizeForAttribute,
  usageStates,
  temporaryTokenStates
});

function getAccountDetailTab(accountId) {
  return accountDetailTabs[accountId] || 'usage';
}

function queryDefaultUsageForVisibleAccounts() {
  if (!vp.getAuthAccounts) return;
  const accounts = vp.getAuthAccounts();
  for (const account of accounts) {
    if (!expandedUsage.has(account.id)) continue;
    if (getAccountDetailTab(account.id) === 'usage' && account.type === 'codex') {
      const state = usageStates[account.id];
      if (!state || (!state.loading && !state.usage && !state.error)) {
        queryCodexUsage(account.id);
      }
    }
  }
}

async function refreshTemporaryTokenState(accountId) {
  if (!accountId || !vp.getAuthAccounts || !vp.getTokenStatistics) return;
  const account = vp.getAuthAccounts().find((item) => item.id === accountId);
  if (!account || !account.temporaryKey) return;
  const previousState = temporaryTokenStates[accountId] || {};
  temporaryTokenStates[accountId] = {
    loading: true,
    error: null,
    stats: previousState.stats || null
  };
  renderServices();
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const result = await vp.getTokenStatistics();
    if (result && result.success && result.stats) {
      tokenStatsState = { loading: false, error: null, stats: result.stats };
    }
    const stats = result && result.success && result.stats && result.stats.temporaryAccounts
      ? (result.stats.temporaryAccounts[account.temporaryKey] || createEmptyTokenStats())
      : createEmptyTokenStats();
    temporaryTokenStates[accountId] = { loading: false, error: null, stats };
  } catch (e) {
    temporaryTokenStates[accountId] = {
      loading: false,
      error: e.message || t('common.error'),
      stats: previousState.stats || null
    };
  }
  renderServices();
}

function createEmptyTokenStats() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    requestCount: 0
  };
}

function setAccountDetailTab(accountId, tab) {
  if (tab !== 'usage' && tab !== 'tokens') return;
  accountDetailTabs[accountId] = tab;
  renderServices();
  if (tab === 'usage') {
    const account = vp.getAuthAccounts ? vp.getAuthAccounts().find((item) => item.id === accountId) : null;
    if (account && account.type === 'codex') {
      queryCodexUsage(accountId);
    }
    return;
  }
  refreshTemporaryTokenState(accountId);
}


function setServerRunning(nextRunning) {
  if (nextRunning) {
    return vp.startServer();
  }
  return vp.stopServer();
}

function toggleTokenAccountExpand(statsKey) {
  if (!statsKey) return;
  if (expandedTokenAccounts.has(statsKey)) {
    expandedTokenAccounts.delete(statsKey);
  } else {
    expandedTokenAccounts.add(statsKey);
  }
  renderTokenStatsPanel();
}

function toggleAccountDetails(accountId) {
  if (!accountId) return;
  if (expandedUsage.has(accountId)) {
    expandedUsage.delete(accountId);
  } else {
    expandedUsage.add(accountId);
  }
  renderServices();
  queryDefaultUsageForVisibleAccounts();
}

function expandAndQueryAllCodexAccounts() {
  if (!vp.getAuthAccounts) return;
  const accounts = vp.getAuthAccounts().filter((account) => account.type === 'codex');
  if (accounts.length === 0) return;
  expanded.add('codex');
  for (const account of accounts) {
    expandedUsage.add(account.id);
    accountDetailTabs[account.id] = 'usage';
  }
  renderServices();
  for (const account of accounts) {
    queryCodexUsage(account.id);
  }
}

function renderTokenStatsPanel() {
  const container = document.getElementById('tokenStats');
  if (!container) return;
  container.innerHTML = renderTokenStatsPage({
    state: tokenStatsState,
    historicalByProvider: (tokenStatsState.stats && tokenStatsState.stats.historicalByProvider) || {},
    services: SERVICES,
    expandedTokenAccounts,
    activePeriod: tokenStatsPeriod
  });
}

function setTokenStatsPeriod(period) {
  if (period !== 'day' && period !== 'week' && period !== 'month') return;
  tokenStatsPeriod = period;
  renderTokenStatsPanel();
}

function rerenderPanels() {
  renderServices();
  renderTokenStatsPanel();
  queryDefaultUsageForVisibleAccounts();
}

async function refreshTokenStatsPage() {
  tokenStatsState = { ...tokenStatsState, loading: true, error: null };
  rerenderPanels();
  try {
    const result = await (vp.refreshTokenStatistics ? vp.refreshTokenStatistics() : vp.getTokenStatistics());
    tokenStatsState = result && result.success
      ? { loading: false, error: null, stats: result.stats }
      : { loading: false, error: (result && result.error) || t('tokenStats.loadFailed'), stats: tokenStatsState.stats };
  } catch (e) {
    tokenStatsState = { loading: false, error: e.message || t('tokenStats.loadFailed'), stats: tokenStatsState.stats };
  }
  rerenderPanels();
}

function ensureTokenStatsLoaded() {
  const hasStats = tokenStatsState && tokenStatsState.stats;
  if (!tokenStatsState.loading && !hasStats) {
    refreshTokenStatsPage();
  }
}

const {
  updateServicesHeader,
  renderServices,
  toggleProvider,
  toggleExpand,
  toggleUsageExpand,
  toggleAccountDisabled,
  designateAccountForUse,
  queryCodexUsage,
  switchCodexAccount,
  startAddAccountFlow,
  connect,
  removeAccountById,
  resetTemporaryStatsForAccount
} = createServicesController({
  vp,
  shell,
  services: SERVICES,
  t,
  escapeHtml,
  sanitizeForAttribute,
  renderUsageState,
  renderTemporaryTokenState,
  usageStates,
  temporaryTokenStates,
  expanded,
  expandedUsage,
  getAuthenticating: () => authenticating,
  setAuthenticating: (value) => {
    authenticating = value;
  },
  getCodexLocalAuthPath: () => codexLocalAuthPath,
  showAlert,
  showConfirm,
  showModal,
  showChoiceModal,
  getAccountDetailTab,
  resetTemporaryTokenStats: (accountId) => vp.resetTemporaryTokenStatsForAccount
    ? vp.resetTemporaryTokenStatsForAccount(accountId)
    : (vp.resetTemporaryTokenStats ? vp.resetTemporaryTokenStats(accountId) : { success: false, error: t('common.error') }),
  rerender: rerenderPanels
});

const fs = require('fs');
const path = require('path');
const os = require('os');
const authDir = path.join(os.homedir(), '.cli-proxy-api');

applyLanguage();
updateUI();
updateLaunchAtLogin();
document.getElementById('openDashboardBtn').addEventListener('click', () => {
  vp.openDashboard();
});
if (vp.getTokenStatistics) {
  vp.getTokenStatistics().then((result) => {
    if (result && result.success) {
      tokenStatsState = { loading: false, error: null, stats: result.stats };
      rerenderPanels();
    }
  }).catch(() => {});
}
setInterval(updateUI, 3000);

try {
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  fs.watch(authDir, { persistent: false }, () => setTimeout(rerenderPanels, 500));
} catch (e) {}

function setLanguage(language) {
  if (language !== 'zh' && language !== 'en') return;
  currentLanguage = language;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch (e) {}
  try {
    if (vp.setLanguagePreference) {
      currentLanguage = vp.setLanguagePreference(language) || language;
    }
  } catch (e) {}
  applyLanguage();
  updateUI();
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage === 'zh' ? 'zh-CN' : 'en';
  document.title = t('static.title');
  document.getElementById('sidebarBrand').textContent = t('static.title');
  document.getElementById('navServerBtn').textContent = t('static.navServer');
  document.getElementById('navSettingsBtn').textContent = t('static.navSettings');
  document.getElementById('navServicesBtn').textContent = t('static.navServices');
  document.getElementById('navTokensBtn').textContent = t('static.navTokens');
  document.getElementById('navAboutBtn').textContent = t('static.navAbout');
  document.getElementById('serverPanelTitle').textContent = t('static.serverStatus');
  document.getElementById('settingsPanelTitle').textContent = t('static.settingsPanel');
  document.getElementById('tokensHeader').textContent = t('tokenStats.title');
  document.getElementById('aboutPanelTitle').textContent = t('static.aboutPanel');
  document.getElementById('serverStatusLabel').textContent = t('static.serverStatus');
  document.getElementById('serverStatusText').textContent = vp.isServerRunning() ? t('common.running') : t('common.stopped');
  document.getElementById('dashboardLabel').textContent = t('static.dashboard');
  document.getElementById('openDashboardBtn').textContent = t('static.openDashboard');
  document.getElementById('languageLabel').textContent = t('static.language');
  document.getElementById('launchAtLoginLabel').textContent = t('static.launchAtLogin');
  document.getElementById('authFilesLabel').textContent = t('static.authFiles');
  document.getElementById('openAuthFolderBtn').textContent = t('static.openFolder');
  document.getElementById('localProxyLabel').textContent = t('static.localProxy');
  document.getElementById('clearTokenStatsLabel').textContent = t('tokenStats.clearAllLabel');
  document.getElementById('clearTokenStatsBtn').textContent = t('tokenStats.clearAll');
  updateServicesHeader();
  document.getElementById('modalCancelBtn').textContent = t('static.cancel');
  document.getElementById('modalSubmitBtn').textContent = t('static.continue');
  document.getElementById('alertOkBtn').textContent = t('static.ok');
  document.getElementById('confirmCancelBtn').textContent = t('static.cancel');
  document.getElementById('confirmBtn').textContent = t('static.delete');
  document.getElementById('choiceCancelBtn').textContent = t('static.cancel');
  document.getElementById('footerLine1').innerHTML = t('static.footerLine1');
  document.getElementById('footerLine2').innerHTML = t('static.footerLine2');
  document.getElementById('footerLine3').innerHTML = t('static.footerLine3');
  document.getElementById('languageZhBtn').classList.toggle('active', currentLanguage === 'zh');
  document.getElementById('languageEnBtn').classList.toggle('active', currentLanguage === 'en');
  syncSectionUI();
}

function syncSectionUI() {
  const sections = ['server', 'settings', 'services', 'tokens', 'about'];
  for (const section of sections) {
    const button = document.getElementById(`nav${section.charAt(0).toUpperCase() + section.slice(1)}Btn`);
    const panel = document.getElementById(`panel${section.charAt(0).toUpperCase() + section.slice(1)}`);
    const isActive = activeSection === section;
    if (button) button.classList.toggle('active', isActive);
    if (panel) panel.classList.toggle('active', isActive);
  }
}

function setActiveSection(section) {
  activeSection = section;
  syncSectionUI();
  if (section === 'tokens') {
    ensureTokenStatsLoaded();
  }
}

function updateUI() {
  updateServerStatus();
  updateProxyUI();
  rerenderPanels();
}

function updateLaunchAtLogin() {
  const enabled = vp.getLaunchAtLogin();
  const toggle = document.getElementById('launchToggle');
  toggle.classList.toggle('on', enabled);
}

function updateProxyUI() {
  const proxy = vp.getLocalProxyUrl ? vp.getLocalProxyUrl() : '';
  document.getElementById('proxyValue').textContent = proxy || t('proxy.notSet');
  document.getElementById('proxyBtn').textContent = proxy ? t('common.edit') : t('common.set');
  document.getElementById('clearProxyBtn').textContent = t('common.clear');
  document.getElementById('clearProxyBtn').classList.toggle('hidden', !proxy);
}

function toggleLaunchAtLogin() {
  const current = vp.getLaunchAtLogin();
  vp.setLaunchAtLogin(!current);
  updateLaunchAtLogin();
}

function configureProxy() {
  const current = vp.getLocalProxyUrl ? vp.getLocalProxyUrl() : '';
  showModal(
    t('proxy.title'),
    t('proxy.description'),
    current || 'http://127.0.0.1:7890',
    'text',
    t('common.save'),
    async (value) => {
      const result = await vp.setLocalProxyUrl(value || '');
      if (!result.success) {
        showAlert(t('proxy.saveFailedTitle'), result.error || t('proxy.saveFailedMessage'));
        return;
      }

      await vp.restartServerIfRunning();

      updateProxyUI();
      showAlert(
        t('proxy.savedTitle'),
        result.proxyUrl ? t('proxy.savedWithProxy', { proxyUrl: result.proxyUrl }) : t('proxy.savedWithoutProxy')
      );
    }
  );
}

async function clearProxy() {
  const result = await vp.setLocalProxyUrl('');
  if (!result.success) {
    showAlert(t('proxy.saveFailedTitle'), result.error || t('proxy.saveFailedMessage'));
    return;
  }

  await vp.restartServerIfRunning();

  updateProxyUI();
  showAlert(t('proxy.clearedTitle'), t('proxy.clearedMessage'));
}

function clearAllTokenStatistics() {
  showConfirm(
    t('tokenStats.clearAllConfirmTitle'),
    t('tokenStats.clearAllConfirmMessage'),
    () => {
      const result = vp.resetAllTokenStatistics ? vp.resetAllTokenStatistics() : { success: false, error: t('tokenStats.clearAllFailed') };
      if (!result || !result.success) {
        showAlert(t('common.error'), (result && result.error) || t('tokenStats.clearAllFailed'));
        return;
      }

      resetAccountTokenStates();
      tokenStatsState = { loading: false, error: null, stats: result.stats };
      rerenderPanels();
      showAlert(t('common.success'), t('tokenStats.clearAllSuccess'));
    },
    null,
    t('tokenStats.clearAll'),
    t('static.cancel')
  );
}

function resetAccountTokenStates() {
  for (const key of Object.keys(temporaryTokenStates)) {
    delete temporaryTokenStates[key];
  }
  for (const key of Object.keys(usageStates)) {
    delete usageStates[key];
  }
  expandedTokenAccounts.clear();
}

function updateServerStatus() {
  const running = vp.isServerRunning();
  const statusText = document.getElementById('serverStatusText');
  const toggle = document.getElementById('serverToggle');
  const spinner = document.getElementById('serverStatusSpinner');
  if (statusText) statusText.textContent = running ? t('common.running') : t('common.stopped');
  if (toggle) {
    toggle.classList.toggle('on', running);
    toggle.classList.toggle('loading', serverStatusLoading);
  }
  if (spinner) spinner.classList.toggle('hidden', !serverStatusLoading);
}

async function toggleServerStatus() {
  if (serverStatusLoading) return;
  serverStatusLoading = true;
  updateServerStatus();
  try {
    await setServerRunning(!vp.isServerRunning());
  } finally {
    setTimeout(() => {
      serverStatusLoading = false;
      updateServerStatus();
    }, 500);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeForAttribute(value) {
  return String(value ?? '').replace(/['"]/g, '');
}

Object.assign(window, {
  setLanguage,
  setActiveSection,
  toggleLaunchAtLogin,
  configureProxy,
  clearProxy,
  clearAllTokenStatistics,
  toggleServerStatus,
  toggleProvider,
  toggleExpand,
  toggleAccountDisabled,
  designateAccountForUse,
  switchCodexAccount,
  expandAndQueryAllCodexAccounts,
  queryCodexUsage,
  startAddAccountFlow,
  connect,
  removeAccountById,
  refreshTokenStatsPage,
  setTokenStatsPeriod,
  setAccountDetailTab,
  toggleTokenAccountExpand,
  toggleAccountDetails,
  resetAccountTokenStats: resetTemporaryStatsForAccount,
  resetTemporaryTokenStats: resetTemporaryStatsForAccount,
  refreshTemporaryTokenState
});

document.addEventListener('click', (event) => {
  if (event.target.tagName === 'A' && event.target.href.startsWith('http')) {
    event.preventDefault();
    shell.openExternal(event.target.href);
  }
});

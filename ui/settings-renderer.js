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
const expanded = new Set();
const expandedUsage = new Set();
let activeSection = 'services';
let currentLanguage = loadLanguagePreference();
const usageStates = {};
const codexLocalAuthPath = vp.getCodexLocalAuthPath ? vp.getCodexLocalAuthPath() : '~/.codex/auth.json';

const { renderUsageState } = createUsageRenderer({
  t,
  getLocale,
  getLanguage: () => currentLanguage,
  escapeHtml,
  sanitizeForAttribute,
  usageStates,
  expandedUsage
});

const {
  updateServicesHeader,
  renderServices,
  toggleProvider,
  toggleExpand,
  toggleUsageExpand,
  toggleAccountDisabled,
  queryCodexUsage,
  startAddAccountFlow,
  connect,
  removeAccountById
} = createServicesController({
  vp,
  shell,
  services: SERVICES,
  t,
  escapeHtml,
  sanitizeForAttribute,
  renderUsageState,
  usageStates,
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
  showChoiceModal
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
setInterval(updateUI, 3000);

try {
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  fs.watch(authDir, { persistent: false }, () => setTimeout(renderServices, 500));
} catch (e) {}

function setLanguage(language) {
  if (language !== 'zh' && language !== 'en') return;
  currentLanguage = language;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
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
  document.getElementById('navAboutBtn').textContent = t('static.navAbout');
  document.getElementById('serverPanelTitle').textContent = t('static.serverStatus');
  document.getElementById('settingsPanelTitle').textContent = t('static.settingsPanel');
  document.getElementById('aboutPanelTitle').textContent = t('static.aboutPanel');
  document.getElementById('serverStatusLabel').textContent = t('static.serverStatus');
  document.getElementById('dashboardLabel').textContent = t('static.dashboard');
  document.getElementById('openDashboardBtn').textContent = t('static.openDashboard');
  document.getElementById('languageLabel').textContent = t('static.language');
  document.getElementById('launchAtLoginLabel').textContent = t('static.launchAtLogin');
  document.getElementById('authFilesLabel').textContent = t('static.authFiles');
  document.getElementById('openAuthFolderBtn').textContent = t('static.openFolder');
  document.getElementById('localProxyLabel').textContent = t('static.localProxy');
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
  const sections = ['server', 'settings', 'services', 'about'];
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
}

function updateUI() {
  updateServerStatus();
  updateProxyUI();
  renderServices();
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

function updateServerStatus() {
  const running = vp.isServerRunning();
  document.getElementById('serverDot').className = `dot ${running ? 'green' : 'red'}`;
  document.getElementById('serverStatus').textContent = running ? t('common.running') : t('common.stopped');
}

async function toggleServer() {
  if (vp.isServerRunning()) {
    await vp.stopServer();
  } else {
    await vp.startServer();
  }
  setTimeout(updateServerStatus, 500);
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
  toggleServer,
  toggleProvider,
  toggleExpand,
  toggleUsageExpand,
  toggleAccountDisabled,
  queryCodexUsage,
  startAddAccountFlow,
  connect,
  removeAccountById
});

document.addEventListener('click', (event) => {
  if (event.target.tagName === 'A' && event.target.href.startsWith('http')) {
    event.preventDefault();
    shell.openExternal(event.target.href);
  }
});

const path = require('path');
const crypto = require('crypto');

function createObservedInputsMonitor({
  fs,
  authDir,
  mergedConfigPath,
  userConfigPath,
  debounceMs,
  ensureAuthDir,
  getCodexLocalAuthCandidates,
  rebuildConfig,
  restartServerIfRunning,
  log = console
}) {
  let authDirWatcher = null;
  let observedInputFingerprint = '';
  let observedInputsTimer = null;

  function safeReadFingerprintPart(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        return `${filePath}:missing`;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return `${filePath}:not-file`;
      }
      const content = fs.readFileSync(filePath);
      return `${filePath}:${crypto.createHash('sha256').update(content).digest('hex')}`;
    } catch (e) {
      return `${filePath}:error:${e.message}`;
    }
  }

  function computeObservedInputFingerprint() {
    ensureAuthDir();
    const relevantParts = [];
    try {
      const files = fs.readdirSync(authDir).sort();
      for (const file of files) {
        if (file === path.basename(mergedConfigPath)) continue;
        if (file.startsWith('.')) continue;
        const fullPath = path.join(authDir, file);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        if (!(file.endsWith('.json') || file === 'config.yaml')) continue;
        relevantParts.push(safeReadFingerprintPart(fullPath));
      }
    } catch (e) {
      relevantParts.push(`auth-dir-error:${e.message}`);
    }

    for (const codexPath of getCodexLocalAuthCandidates()) {
      relevantParts.push(safeReadFingerprintPart(codexPath));
    }

    return crypto.createHash('sha256').update(relevantParts.join('\n')).digest('hex');
  }

  function markObservedInputsCurrent() {
    observedInputFingerprint = computeObservedInputFingerprint();
  }

  function maybeHandleObservedInputsChanged(reason = 'Observed config inputs changed') {
    const nextFingerprint = computeObservedInputFingerprint();
    if (nextFingerprint === observedInputFingerprint) {
      return;
    }
    observedInputFingerprint = nextFingerprint;
    log.log(`[Config] ${reason}`);
    try {
      rebuildConfig();
    } catch (error) {
      log.error('[Config] Failed to rebuild config after observed change:', error);
      return;
    }
    restartServerIfRunning();
  }

  function scheduleObservedInputsRefresh(reason) {
    if (observedInputsTimer) {
      clearTimeout(observedInputsTimer);
    }
    observedInputsTimer = setTimeout(() => {
      observedInputsTimer = null;
      maybeHandleObservedInputsChanged(reason);
    }, debounceMs);
  }

  function start() {
    ensureAuthDir();
    markObservedInputsCurrent();

    if (!authDirWatcher) {
      try {
        authDirWatcher = fs.watch(authDir, { persistent: false }, () => {
          scheduleObservedInputsRefresh('Auth directory changed');
        });
      } catch (error) {
        log.error('[Config] Failed to watch auth directory:', error);
      }
    }

    fs.watchFile(userConfigPath, { interval: 1000 }, () => {
      scheduleObservedInputsRefresh('User config changed');
    });

    for (const codexPath of getCodexLocalAuthCandidates()) {
      fs.watchFile(codexPath, { interval: 1000 }, () => {
        scheduleObservedInputsRefresh('Codex local auth changed');
      });
    }
  }

  function stop() {
    if (authDirWatcher) {
      authDirWatcher.close();
      authDirWatcher = null;
    }
    fs.unwatchFile(userConfigPath);
    for (const codexPath of getCodexLocalAuthCandidates()) {
      fs.unwatchFile(codexPath);
    }
    if (observedInputsTimer) {
      clearTimeout(observedInputsTimer);
      observedInputsTimer = null;
    }
  }

  return {
    start,
    stop,
    trigger: scheduleObservedInputsRefresh,
    rebuildNow: markObservedInputsCurrent
  };
}

module.exports = { createObservedInputsMonitor };

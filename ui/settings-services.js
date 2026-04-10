function createServicesController({
  vp,
  shell,
  services,
  t,
  escapeHtml,
  sanitizeForAttribute,
  renderUsageState,
  usageStates,
  expanded,
  expandedUsage,
  getAuthenticating,
  setAuthenticating,
  getCodexLocalAuthPath,
  showAlert,
  showConfirm,
  showModal,
  showChoiceModal
}) {
  function getServiceByType(type) {
    return services.find((service) => service.type === type);
  }

  function getAccounts() {
    return vp.getAuthAccounts();
  }

  function getVisibleServices(accounts) {
    const connectedTypes = new Set(accounts.map((account) => account.type));
    return services.filter((service) => connectedTypes.has(service.type));
  }

  function getProviderPickerOptions() {
    return services.map((service) => ({
      value: service.type,
      label: service.name,
      icon: `../assets/${service.icon}`
    }));
  }

  function getProviderAuthOptions(type) {
    const service = getServiceByType(type);
    if (!service) return [];

    if (type === 'codex') {
      const localStatus = vp.getCodexLocalAuthStatus
        ? vp.getCodexLocalAuthStatus()
        : { importable: vp.checkCodexLocalAuth(), filePath: getCodexLocalAuthPath() };

      const options = [
        {
          value: 'web',
          label: t('services.webAuth')
        }
      ];

      if (localStatus.importable) {
        options.push({
          value: 'local-import',
          label: t('services.localImport')
        });
      }

      return options;
    }

    if (type === 'kiro') {
      const accounts = getAccounts();
      const hasImportedToken = accounts.some((account) => account.type === 'kiro');
      const hasKiroToken = vp.checkKiroToken();
      const options = [
        {
          value: 'web',
          label: t('services.webAuth')
        }
      ];

      if (hasKiroToken) {
        options.push({
          value: hasImportedToken ? 'ide-sync' : 'ide-import',
          label: hasImportedToken ? t('services.syncFromIde') : t('services.importFromIde')
        });
      }

      return options;
    }

    if (service.needsEmail) {
      return [{
        value: 'email-auth',
        label: t('services.webAuth')
      }];
    }

    if (service.needsApiKey) {
      return [{
        value: 'api-key',
        label: service.name
      }];
    }

    return [{
      value: 'web',
      label: t('services.webAuth')
    }];
  }

  function updateServicesHeader() {
    const header = document.getElementById('servicesHeader');
    header.innerHTML = '';

    const main = document.createElement('div');
    main.className = 'section-header-main';
    main.append(document.createTextNode(t('static.services')));

    const actions = document.createElement('div');
    actions.className = 'section-header-actions';

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.textContent = t('services.addAccount');
    addButton.addEventListener('click', () => {
      startAddAccountFlow();
    });
    actions.appendChild(addButton);

    header.appendChild(main);
    header.appendChild(actions);
  }

  function renderServices() {
    const accounts = getAccounts();
    const visibleServices = getVisibleServices(accounts);
    const container = document.getElementById('services');
    container.innerHTML = '';

    if (visibleServices.length === 0) {
      container.innerHTML = `<div class="no-accounts">${escapeHtml(t('services.noAccountsAdded'))}</div>`;
      return;
    }

    for (const svc of visibleServices) {
      const svcAccounts = accounts.filter((account) => account.type === svc.type);
      const enabled = vp.isProviderEnabled(svc.type);
      const isExpanded = expanded.has(svc.type);

      if (svcAccounts.some((account) => account.expired) && !expanded.has(svc.type)) {
        expanded.add(svc.type);
      }

      let html = `<div class="service-row">
        <div class="service-header">
          <div class="toggle ${enabled ? 'on' : ''}" onclick="toggleProvider('${svc.type}')"></div>
          <img class="service-icon ${enabled ? '' : 'disabled'}" src="../assets/${svc.icon}" onerror="this.style.display='none'">
          <span class="service-name ${enabled ? '' : 'disabled'}">${svc.name}</span>
          ${!enabled ? `<span class="badge">(${t('common.disabled')})</span>` : ''}
          ${getAuthenticating() === svc.type ? '<div class="spinner"></div>' : ''}
        </div>`;

      if (svcAccounts.length > 0) {
        const enabledAccountCount = svcAccounts.filter((account) => !account.disabled).length;
        const showRoundRobin = enabledAccountCount > 1;
        const meta = showRoundRobin
          ? `<span class="meta">• ${escapeHtml(t('services.roundRobin'))}</span>`
          : '';

        html += `
          <div class="accounts-summary" onclick="toggleExpand('${svc.type}')">
            <span>${escapeHtml(t('services.connectedAccounts', { count: svcAccounts.length }))}</span>
            ${meta}
            <span class="chevron ${isExpanded ? 'expanded' : ''}">▶</span>
          </div>
          <div class="accounts-list ${isExpanded ? 'show' : ''}">`;

        for (const account of svcAccounts) {
          const safeId = sanitizeForAttribute(account.id);
          const isCodex = svc.type === 'codex';
          const usageState = usageStates[account.id];
          const canToggleDisabled = svcAccounts.length > 1;
          const disableBlocked = !account.disabled && enabledAccountCount <= 1;
          const dotClass = account.disabled ? 'gray' : (account.expired ? 'orange' : 'green');
          const labelParts = [];
          if (account.expired && !account.disabled) {
            labelParts.push(t('services.expired'));
          }
          if (account.disabled) {
            labelParts.push(t('services.disabledAccount'));
          }
          const suffix = labelParts.length ? ` (${labelParts.join(', ')})` : '';
          html += `
            <div class="account-item">
              <div class="account-line">
                <span class="dot ${dotClass}"></span>
                <span class="account-email ${account.expired ? 'expired' : ''} ${account.disabled ? 'disabled' : ''}">${escapeHtml(account.email)}${escapeHtml(suffix)}</span>
              </div>
              <div class="account-actions">
                ${canToggleDisabled ? (account.disabled
                  ? `<button class="secondary" onclick="toggleAccountDisabled('${safeId}')">${t('services.enable')}</button>`
                  : `<button class="secondary" ${disableBlocked ? 'disabled' : ''} onclick="toggleAccountDisabled('${safeId}')">${t('services.disable')}</button>`)
                  : ''}
                ${isCodex ? `<button class="secondary" ${(usageState && usageState.loading) ? 'disabled' : ''} onclick="queryCodexUsage('${safeId}')">${usageState && usageState.usage ? t('usage.refresh') : t('usage.query')}</button>` : ''}
                <button class="danger" onclick="removeAccountById('${safeId}')">${t('services.remove')}</button>
              </div>
              ${isCodex ? renderUsageState(account.id) : ''}
            </div>`;
        }

        html += '</div>';
      } else {
        html += `<div class="no-accounts">${t('services.noAccounts')}</div>`;
      }

      html += '</div>';
      container.innerHTML += html;
    }
  }

  function toggleProvider(type) {
    const current = vp.isProviderEnabled(type);
    vp.setProviderEnabled(type, !current);
    renderServices();
  }

  function toggleExpand(type) {
    if (expanded.has(type)) {
      expanded.delete(type);
    } else {
      expanded.add(type);
    }
    renderServices();
  }

  function toggleUsageExpand(id) {
    if (expandedUsage.has(id)) {
      expandedUsage.delete(id);
    } else {
      expandedUsage.add(id);
    }
    renderServices();
  }

  async function toggleAccountDisabled(id) {
    try {
      const result = vp.toggleAccountDisabled(id);
      if (!result || !result.success) {
        if (result && result.code === 'LAST_ENABLED_ACCOUNT') {
          showAlert(t('common.error'), t('services.lastEnabledAccount'));
        } else {
          showAlert(t('common.error'), (result && result.error) || t('services.toggleFailed'));
        }
        return;
      }

      showAlert(
        t('common.success'),
        result.disabled ? t('services.accountDisabled') : t('services.accountEnabled')
      );
      renderServices();
    } catch (e) {
      showAlert(t('common.error'), e.message || t('services.toggleFailed'));
    }
  }

  async function queryCodexUsage(id) {
    expandedUsage.delete(id);
    usageStates[id] = { loading: true };
    renderServices();

    try {
      const result = await vp.getCodexUsage(id);
      usageStates[id] = result.success
        ? { loading: false, usage: result.usage }
        : { loading: false, error: result.error || t('usage.failed'), details: result.details };
    } catch (e) {
      usageStates[id] = { loading: false, error: e.message || t('usage.failed') };
    }

    renderServices();
  }

  function startAddAccountFlow() {
    showChoiceModal(
      t('services.chooseProviderTitle'),
      t('services.chooseProviderDescription'),
      getProviderPickerOptions(),
      (type) => {
        if (type) connect(type);
      }
    );
  }

  async function connect(type) {
    const service = getServiceByType(type);
    if (!service) return;

    const options = getProviderAuthOptions(type);
    if (options.length <= 1) {
      await runProviderAuthOption(type, options[0] ? options[0].value : 'web');
      return;
    }

    showChoiceModal(
      t('services.chooseMethodTitle', { serviceName: service.name }),
      t('services.chooseMethodDescription'),
      options,
      (method) => {
        if (method) runProviderAuthOption(type, method);
      }
    );
  }

  async function runProviderAuthOption(type, method) {
    const svc = getServiceByType(type);
    if (!svc) return;

    if (type === 'codex') {
      const localCodexAuthStatus = vp.getCodexLocalAuthStatus
        ? vp.getCodexLocalAuthStatus()
        : { found: vp.checkCodexLocalAuth(), importable: vp.checkCodexLocalAuth(), filePath: getCodexLocalAuthPath() };
      const detectedPath = localCodexAuthStatus.filePath || getCodexLocalAuthPath();

      if (method === 'local-import') {
        if (!localCodexAuthStatus.importable) {
          showAlert(t('codex.importFailed'), localCodexAuthStatus.error || t('codex.localAuthMissing', { path: detectedPath }));
          return;
        }

        const result = vp.importCodexLocalAuth();
        if (result.success) {
          const account = result.account || {};
          renderServices();

          showAlert(
            t('codex.importSuccess'),
            t('codex.importMessage', {
              action: account.updated ? t('codex.importActionUpdated') : t('codex.importActionImported'),
              email: account.email || t('common.unknown')
            })
          );
        } else {
          showAlert(t('codex.importFailed'), result.error || t('codex.importFailed'));
        }
        return;
      }

      await doAuth(type, svc.cmd);
      return;
    }

    if (type === 'kiro') {
      if (!vp.isServerRunning()) {
        showAlert(t('kiro.serverNotRunningTitle'), t('kiro.serverNotRunningMessage'));
        return;
      }

      if (method === 'ide-sync') {
        const result = vp.syncKiroTokenFromIDE();
        if (result.success) {
          showAlert(t('common.success'), t('kiro.syncSuccess', { count: result.updated }));
          renderServices();
        } else {
          showAlert(t('kiro.syncFailed'), result.error || t('kiro.syncFailed'));
        }
        return;
      }

      if (method === 'ide-import') {
        const result = vp.importKiroToken();
        if (result.success) {
          showAlert(t('common.success'), t('kiro.importSuccess'));
          renderServices();
        } else {
          showAlert(t('kiro.importFailed'), result.error || t('kiro.importFailed'));
        }
        return;
      }

      shell.openExternal(vp.getKiroAuthUrl());
      showAlert(t('kiro.authTitle'), t('kiro.authOpened'));
      return;
    }

    if (svc.needsEmail || method === 'email-auth') {
      showModal(t('qwen.title'), t('qwen.description'), t('qwen.placeholder'), 'email', t('static.continue'), async (email) => {
        if (email) await doAuth(type, svc.cmd, email);
      });
      return;
    }

    if (svc.needsApiKey || method === 'api-key') {
      showModal(t('zai.title'), t('zai.description'), '', 'password', t('zai.addKey'), (key) => {
        if (key) {
          vp.saveZaiApiKey(key);
          showAlert(t('common.success'), t('zai.success'));
          renderServices();
        }
      });
      return;
    }

    await doAuth(type, svc.cmd);
  }

  async function doAuth(type, cmd, email = null) {
    setAuthenticating(type);
    renderServices();
    showAlert(t('auth.started'), getPendingMsg(type));

    try {
      const result = await vp.runAuthCommand(cmd, email);
      setAuthenticating(null);
      renderServices();

      if (result.success) {
        showAlert(t('auth.completed'), getSuccessMsg(type, result.output || ''));
      } else if (type === 'codex' && result.code === 'AUTH_ALREADY_RUNNING') {
        showAlert(t('codex.authTitle'), t('codex.authInProgress'));
      } else if (result.code === 'AUTH_CANCELLED') {
        showAlert(t('auth.failed'), result.output || t('common.unknown'));
      } else {
        showAlert(t('auth.failed'), t('auth.failedMessage', { details: result.output || t('common.unknown') }));
      }
    } catch (e) {
      setAuthenticating(null);
      renderServices();
      showAlert(t('common.error'), e.message);
    }
  }

  function getPendingMsg(type) {
    const messages = {
      antigravity: t('auth.pendingAntigravity'),
      claude: t('auth.pendingClaude'),
      codex: t('auth.pendingCodex'),
      gemini: t('auth.pendingGemini'),
      'github-copilot': t('auth.pendingGithubCopilot'),
      qwen: t('auth.pendingQwen')
    };
    return messages[type] || t('auth.genericPending');
  }

  function getSuccessMsg(type, output) {
    if (type === 'github-copilot' && output.includes('Code copied')) {
      return output;
    }

    const messages = {
      antigravity: t('auth.antigravity'),
      claude: t('auth.claude'),
      codex: t('auth.codex'),
      gemini: t('auth.gemini'),
      'github-copilot': t('auth.githubCopilot'),
      qwen: t('auth.qwen')
    };
    return messages[type] || t('auth.genericCompleted');
  }

  function removeAccountById(id) {
    const accounts = getAccounts();
    const account = accounts.find((item) => item.id === id);
    if (!account) return;

    const service = services.find((item) => item.type === account.type);
    const serviceName = service ? service.name : account.type;

    showConfirm(
      t('remove.title'),
      t('remove.confirm', { email: account.email, serviceName }),
      () => {
        if (vp.deleteAccount(account.path)) {
          showAlert(t('remove.removedTitle'), t('remove.removedMessage', { email: account.email }));
          delete usageStates[account.id];
          expandedUsage.delete(account.id);
          vp.restartServerIfRunning();
        } else {
          showAlert(t('common.error'), t('remove.failed'));
        }
        renderServices();
      },
      null,
      t('services.remove'),
      t('static.cancel')
    );
  }

  return {
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
  };
}

module.exports = { createServicesController };

function createUsageRenderer({
  t,
  getLocale,
  getLanguage,
  escapeHtml,
  sanitizeForAttribute,
  usageStates,
  temporaryTokenStates
}) {
  function formatUsageNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return t('common.unknown');
    }
    return value.toLocaleString(getLocale(), {
      minimumFractionDigits: 0,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2
    });
  }

  function formatDateText(value) {
    if (!value) return t('common.unknown');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(getLocale());
  }

  function formatUsageDate(value) {
    return escapeHtml(formatDateText(value));
  }

  function formatDurationSeconds(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return t('common.unknown');
    }

    const totalMinutes = Math.max(0, Math.floor(value / 60));
    const weeks = Math.floor(totalMinutes / (60 * 24 * 7));
    const days = Math.floor((totalMinutes % (60 * 24 * 7)) / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;

    if (getLanguage() === 'zh') {
      if (weeks > 0) return `${weeks}周${days > 0 ? ` ${days}天` : ''}`;
      if (days > 0) return `${days}天${hours > 0 ? ` ${hours}小时` : ''}`;
      if (hours > 0) return `${hours}小时${minutes > 0 ? ` ${minutes}分钟` : ''}`;
      return `${minutes}分钟`;
    }

    if (weeks > 0) return `${weeks}w${days > 0 ? ` ${days}d` : ''}`;
    if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
    if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
    return `${minutes}m`;
  }

  function getWindowKind(window, fallback) {
    const seconds = window && window.limitWindowSeconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      if (Math.abs(seconds - 18000) <= 1800) return '5h';
      if (Math.abs(seconds - 604800) <= 43200) return 'week';
    }
    return fallback;
  }

  function getWindowTitle(window, fallback) {
    const kind = getWindowKind(window, fallback);
    if (kind === '5h') return t('usage.window5h');
    if (kind === 'week') return t('usage.windowWeek');
    return kind === 'secondary' ? t('usage.secondaryWindow') : t('usage.primaryWindow');
  }

  function getWindowRemainingLabel(window, fallback) {
    const kind = getWindowKind(window, fallback);
    if (kind === '5h') return t('usage.window5hRemaining');
    if (kind === 'week') return t('usage.windowWeekRemaining');
    return `${getWindowTitle(window, fallback)} ${t('usage.remaining')}`;
  }

  function getUsageVariant(remainingPercent) {
    if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent)) {
      return '';
    }
    if (remainingPercent <= 15) return 'bad';
    if (remainingPercent <= 40) return 'warn';
    return 'good';
  }

  function renderUsagePill(label, value, variant = '') {
    return `<div class="usage-pill ${variant}"><span class="usage-pill-label">${escapeHtml(label)}</span><span class="usage-pill-value">${escapeHtml(value)}</span></div>`;
  }

  function renderUsageRow(label, value) {
    return `<div class="usage-row"><span class="usage-label">${escapeHtml(label)}</span><span class="usage-value">${value}</span></div>`;
  }

  function renderWindowPill(window, fallback) {
    if (!window || window.remainingPercent == null) return '';
    const title = getWindowRemainingLabel(window, fallback);
    const value = `${formatUsageNumber(window.remainingPercent)}%`;
    return `<div class="usage-pill ${getUsageVariant(window.remainingPercent)}"><span class="usage-pill-label">${escapeHtml(title)}</span><span class="usage-pill-value">${escapeHtml(value)}</span></div>`;
  }

  function renderResetInfoPill(window, fallback) {
    if (!window) return '';
    const kind = getWindowKind(window, fallback);
    const title = kind === '5h' ? t('usage.window5hResetAt') : kind === 'week' ? t('usage.windowWeekResetAt') : t('usage.resetAt');
    const countdown = window.resetAfterSeconds != null ? formatDurationSeconds(window.resetAfterSeconds) : t('common.unknown');
    const resetAt = window.resetAt ? formatDateText(window.resetAt) : t('common.unknown');
    return `<div class="usage-pill usage-pill-reset"><span class="usage-pill-label">${escapeHtml(title)}</span><span class="usage-pill-value usage-pill-value-secondary">${escapeHtml(countdown)}</span><span class="usage-pill-meta">${escapeHtml(resetAt)}</span></div>`;
  }

  function renderUsageState(accountId, activeTab = 'usage') {
    const state = usageStates[accountId] || {};
    const safeId = sanitizeForAttribute(accountId);
    const tabHeader = `<div class="account-detail-tabs"><button type="button" class="language-btn ${activeTab === 'usage' ? 'active' : ''}" onclick="setAccountDetailTab('${safeId}', 'usage')">${escapeHtml(t('usage.usageTab'))}</button><button type="button" class="language-btn ${activeTab === 'tokens' ? 'active' : ''}" onclick="setAccountDetailTab('${safeId}', 'tokens')">${escapeHtml(t('usage.tokenTab'))}</button></div>`;
    const usage = state.usage || {};

    if (!state.loading && !state.error && !state.usage) {
      return `<div class="usage-card compact-usage-card">${tabHeader}<div class="usage-note">${t('usage.querying')}</div></div>`;
    }

    if (state.error && !state.usage) {
      const detail = state.details ? `\n${escapeHtml(state.details)}` : '';
      return `<div class="usage-card compact-usage-card">${tabHeader}<div class="usage-note usage-error">${escapeHtml(state.error)}${detail}</div></div>`;
    }

    const loadingOverlay = state.loading
      ? `<div class="usage-loading-overlay"><div class="spinner"></div><div class="usage-note">${escapeHtml(t('usage.querying'))}</div></div>`
      : '';
    const errorBanner = state.error
      ? `<div class="usage-note usage-error">${escapeHtml(state.error)}${state.details ? `\n${escapeHtml(state.details)}` : ''}</div>`
      : '';
    const rateLimit = usage.rateLimit;
    const reviewLimit = usage.codeReviewRateLimit;
    const primaryWindow = rateLimit && rateLimit.primaryWindow;
    const secondaryWindow = rateLimit && rateLimit.secondaryWindow;
    const reviewWindow = reviewLimit && reviewLimit.primaryWindow;
    const summaryPills = [];
    const overallRows = [];

    if (usage.planType) {
      summaryPills.push(renderUsagePill(t('usage.plan'), usage.planType));
      overallRows.push(renderUsageRow(t('usage.plan'), escapeHtml(usage.planType)));
    }

    let statusPill = '';
    if (rateLimit) {
      const statusLabel = rateLimit.allowed && !rateLimit.limitReached ? t('common.available') : t('common.blocked');
      statusPill = renderUsagePill(t('usage.status'), statusLabel, rateLimit.allowed && !rateLimit.limitReached ? 'good' : 'bad');
      overallRows.push(renderUsageRow(t('usage.status'), escapeHtml(statusLabel)));
      overallRows.push(renderUsageRow(t('usage.limitReached'), escapeHtml(rateLimit.limitReached ? t('common.yes') : t('common.no'))));
    }

    if (statusPill) {
      summaryPills.push(statusPill);
    }

    if (primaryWindow && primaryWindow.remainingPercent != null) {
      summaryPills.push(renderWindowPill(primaryWindow, 'primary'));
      summaryPills.push(renderResetInfoPill(primaryWindow, 'primary'));
    }

    if (secondaryWindow && secondaryWindow.remainingPercent != null) {
      summaryPills.push(renderWindowPill(secondaryWindow, 'secondary'));
      summaryPills.push(renderResetInfoPill(secondaryWindow, 'secondary'));
    }

    if (!rateLimit && usage.remaining != null) {
      summaryPills.push(renderUsagePill(t('usage.remaining'), formatUsageNumber(usage.remaining)));
    }

    if (usage.retrievedAt) {
      overallRows.push(renderUsageRow(t('usage.updatedAt'), formatUsageDate(usage.retrievedAt)));
    }

    if (!rateLimit) {
      if (usage.used != null || usage.limit != null) {
        const value = usage.limit != null
          ? `${formatUsageNumber(usage.used)} / ${formatUsageNumber(usage.limit)}`
          : formatUsageNumber(usage.used);
        overallRows.push(renderUsageRow(t('usage.used'), escapeHtml(value)));
      }
      if (usage.remaining != null) {
        overallRows.push(renderUsageRow(t('usage.remaining'), escapeHtml(formatUsageNumber(usage.remaining))));
      }
      if (usage.cycle) {
        overallRows.push(renderUsageRow(t('usage.cycle'), escapeHtml(String(usage.cycle))));
      }
      if (usage.periodEnd) {
        overallRows.push(renderUsageRow(t('usage.resetAt'), formatUsageDate(usage.periodEnd)));
      }
      if (usage.periodStart) {
        overallRows.push(renderUsageRow(t('usage.periodStart'), formatUsageDate(usage.periodStart)));
      }
    }

    if (reviewLimit || reviewWindow) {
      const statusLabel = reviewLimit && reviewLimit.allowed ? t('common.available') : t('common.blocked');
      if (reviewLimit) {
        summaryPills.push(renderUsagePill(t('usage.codeReviewStatus'), statusLabel, reviewLimit.allowed ? 'good' : 'bad'));
      }
      if (reviewWindow && reviewWindow.usedPercent != null) {
        summaryPills.push(renderUsagePill(t('usage.reviewUsed'), `${formatUsageNumber(reviewWindow.usedPercent)}%`));
      }
      if (reviewWindow && reviewWindow.resetAfterSeconds != null) {
        summaryPills.push(renderUsagePill(t('usage.timeLeft'), formatDurationSeconds(reviewWindow.resetAfterSeconds)));
      }
      if (reviewWindow && reviewWindow.resetAt) {
        summaryPills.push(renderUsagePill(t('usage.reviewResetAt'), formatDateText(reviewWindow.resetAt)));
      }
    }

    if (overallRows.length === 0 && usage.raw) {
      overallRows.push(renderUsageRow(t('common.unknown'), escapeHtml(JSON.stringify(usage.raw, null, 2).slice(0, 240) || t('usage.noData'))));
    }
    if (overallRows.length === 0 && !usage.raw) {
      overallRows.push(renderUsageRow(t('common.unknown'), escapeHtml(t('usage.noData'))));
    }

    const subtitle = usage.retrievedAt
      ? t('usage.subtitleUpdated', { value: formatDateText(usage.retrievedAt) })
      : t('usage.subtitleFallback');

    return `<div class="usage-card compact-usage-card usage-card-shell">
      ${tabHeader}
      <div class="usage-heading">
        <div class="usage-title-row">
          <span class="usage-title">${t('usage.overview')}</span>
          <button type="button" class="secondary inline-title-action" onclick="queryCodexUsage('${safeId}')">${escapeHtml(t('common.refresh'))}</button>
        </div>
        <span class="usage-subtitle">${escapeHtml(subtitle)}</span>
      </div>
      ${summaryPills.length > 0 ? `<div class="usage-summary compact-summary-grid">${summaryPills.join('')}</div>` : ''}
      ${errorBanner}
      ${loadingOverlay}
    </div>`;
  }

  function getTokenPeriodStats(stats, period) {
    const periodStats = stats && stats.periods && stats.periods[period];
    return periodStats && periodStats.global ? periodStats.global : (stats && stats.global) || {};
  }

  function renderTokenPeriodTabs(activePeriod) {
    const periods = [
      ['day', t('tokenStats.periodDay')],
      ['week', t('tokenStats.periodWeek')],
      ['month', t('tokenStats.periodMonth')]
    ];
    return `<div class="token-period-tabs">${periods.map(([value, label]) => `<button type="button" class="language-btn ${activePeriod === value ? 'active' : ''}" onclick="setTokenStatsPeriod('${value}')">${escapeHtml(label)}</button>`).join('')}</div>`;
  }

  function renderTokenStatsViewTabs(activeView) {
    const tabs = [
      ['overview', t('tokenStats.overviewTab')],
      ['dailySummary', t('tokenStats.dailySummaryTab')],
      ['daily', t('tokenStats.dailyTab')]
    ];
    return `<div class="token-view-tabs">${tabs.map(([value, label]) => `<button type="button" class="language-btn ${activeView === value ? 'active' : ''}" onclick="setTokenStatsView('${value}')">${escapeHtml(label)}</button>`).join('')}</div>`;
  }

  function renderTokenStatsSummary(state, activePeriod = 'week') {
    if (!state) return '';
    const stats = state.stats || {};
    if (state.error && !stats.global) {
      return `<div class="usage-card token-account-card"><div class="usage-note usage-error">${escapeHtml(state.error)}</div></div>`;
    }
    const global = getTokenPeriodStats(stats, activePeriod);
    const summaryPills = [
      renderUsagePill(t('tokenStats.totalLabel'), formatUsageNumber(global.totalTokens || 0), 'good'),
      renderUsagePill(t('tokenStats.input'), formatUsageNumber(global.inputTokens || 0), 'warn'),
      renderUsagePill(t('tokenStats.output'), formatUsageNumber(global.outputTokens || 0), 'bad'),
      renderUsagePill(t('tokenStats.cached'), formatUsageNumber(global.cachedTokens || 0), 'muted'),
      renderUsagePill(t('tokenStats.reasoning'), formatUsageNumber(global.reasoningTokens || 0), 'info'),
      renderUsagePill(t('tokenStats.requests'), formatUsageNumber(global.requestCount || 0), 'request')
    ];
    const rows = [
      renderUsageRow(t('tokenStats.totalLabel'), escapeHtml(formatUsageNumber(global.totalTokens || 0))),
      renderUsageRow(t('tokenStats.input'), escapeHtml(formatUsageNumber(global.inputTokens || 0))),
      renderUsageRow(t('tokenStats.output'), escapeHtml(formatUsageNumber(global.outputTokens || 0))),
      renderUsageRow(t('tokenStats.cached'), escapeHtml(formatUsageNumber(global.cachedTokens || 0))),
      renderUsageRow(t('tokenStats.reasoning'), escapeHtml(formatUsageNumber(global.reasoningTokens || 0))),
      renderUsageRow(t('tokenStats.requests'), escapeHtml(formatUsageNumber(global.requestCount || 0)))
    ];
    if (stats.updatedAt) {
      rows.push(renderUsageRow(t('usage.updatedAt'), formatUsageDate(stats.updatedAt)));
    }
    return `<div class="usage-card token-account-card token-summary-shell"><div class="usage-heading"><span class="usage-title">${t('tokenStats.title')}</span><span class="usage-subtitle">${escapeHtml(stats.updatedAt ? t('usage.subtitleUpdated', { value: formatDateText(stats.updatedAt) }) : t('common.unknown'))}</span></div>${renderTokenPeriodTabs(activePeriod)}<div class="usage-summary token-summary-accent">${summaryPills.join('')}</div><div class="usage-sections"><div class="usage-section"><div class="usage-grid">${rows.join('')}</div></div></div>${state.loading ? `<div class="token-loading-overlay"><div class="spinner"></div><div class="usage-note">${escapeHtml(t('tokenStats.loading'))}</div></div>` : ''}${state.error ? `<div class="usage-note usage-error">${escapeHtml(state.error)}</div>` : ''}</div>`;
  }

  function renderLineChart(series, title = t('tokenStats.chartTitle')) {
    if (!Array.isArray(series) || series.length === 0) {
      return `<div class="usage-note">${t('tokenStats.chartEmpty')}</div>`;
    }

    const values = series.map((point) => Number(point.totalTokens) || 0);
    const max = Math.max(...values, 1);
    const width = 320;
    const height = 120;
    const points = series.map((point, index) => {
      const x = series.length === 1 ? width / 2 : (index / (series.length - 1)) * width;
      const y = height - ((Number(point.totalTokens) || 0) / max) * (height - 20) - 10;
      return `${x},${y}`;
    }).join(' ');
    const labels = series.map((point) => `<span>${escapeHtml(String(point.day || '').slice(5))}</span>`).join('');

    return `<div class="token-chart-card"><div class="token-chart-title">${escapeHtml(title)}</div><svg class="token-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline fill="none" stroke="var(--accent)" stroke-width="3" points="${points}"></polyline></svg><div class="token-chart-labels" style="grid-template-columns: repeat(${series.length}, minmax(0, 1fr));">${labels}</div></div>`;
  }

  function renderTemporaryTokenState(account, temporaryStats, activeTab) {
    const state = temporaryStats || {};
    const stats = state.stats || {};
    const safeAccountId = sanitizeForAttribute(account.id || '');
    const tabHeader = `<div class="account-detail-tabs"><button type="button" class="language-btn ${activeTab === 'usage' ? 'active' : ''}" onclick="setAccountDetailTab('${sanitizeForAttribute(account.id)}', 'usage')">${escapeHtml(t('usage.usageTab'))}</button><button type="button" class="language-btn ${activeTab === 'tokens' ? 'active' : ''}" onclick="setAccountDetailTab('${sanitizeForAttribute(account.id)}', 'tokens')">${escapeHtml(t('usage.tokenTab'))}</button></div>`;
    if (!state.loading && !state.error && !state.stats) {
      return `<div class="usage-card compact-usage-card temporary-token-card">${tabHeader}<div class="usage-note">${escapeHtml(t('usage.querying'))}</div></div>`;
    }
    const loadingOverlay = state.loading
      ? `<div class="usage-loading-overlay"><div class="spinner"></div><div class="usage-note">${escapeHtml(t('usage.querying'))}</div></div>`
      : '';
    const errorBanner = state.error
      ? `<div class="usage-note usage-error">${escapeHtml(state.error)}</div>`
      : '';
    return `<div class="usage-card compact-usage-card temporary-token-card usage-card-shell">
      ${tabHeader}
      <div class="usage-heading">
        <div class="usage-title-row">
          <span class="usage-title">${escapeHtml(t('usage.tempTokenOverview'))}</span>
          <div class="usage-title-actions">
            <button type="button" class="secondary inline-title-action account-token-reset-btn" data-account-id="${safeAccountId}">${escapeHtml(t('usage.resetToken'))}</button>
            <button type="button" class="secondary inline-title-action" onclick="refreshTemporaryTokenState('${safeAccountId}')">${escapeHtml(t('common.refresh'))}</button>
          </div>
        </div>
      </div>
      <div class="usage-summary compact-summary-grid token-summary-accent">${[
        renderUsagePill(t('tokenStats.totalLabel'), formatUsageNumber(stats.totalTokens || 0), 'good'),
        renderUsagePill(t('tokenStats.input'), formatUsageNumber(stats.inputTokens || 0), 'warn'),
        renderUsagePill(t('tokenStats.output'), formatUsageNumber(stats.outputTokens || 0), 'bad'),
        renderUsagePill(t('tokenStats.cached'), formatUsageNumber(stats.cachedTokens || 0), 'muted'),
        renderUsagePill(t('tokenStats.reasoning'), formatUsageNumber(stats.reasoningTokens || 0), 'info'),
        renderUsagePill(t('tokenStats.requests'), formatUsageNumber(stats.requestCount || 0), 'request')
      ].join('')}</div>
      ${errorBanner}
      ${loadingOverlay}
    </div>`;
  }

  function getServiceName(provider, services) {
    const service = (services || []).find((item) => item.type === provider);
    return service ? service.name : String(provider || t('common.unknown'));
  }

  function renderMetricHeaderCells() {
    return [
      ['token-metric-total', t('tokenStats.totalLabel')],
      ['token-metric-input', t('tokenStats.input')],
      ['token-metric-output', t('tokenStats.output')],
      ['token-metric-cached', t('tokenStats.cached')],
      ['token-metric-reasoning', t('tokenStats.reasoning')],
      ['token-metric-requests', t('tokenStats.requests')]
    ].map(([className, label]) => `<th class="${className}">${escapeHtml(label)}</th>`).join('');
  }

  function renderMetricCells(row) {
    return [
      ['token-metric-total', row.totalTokens],
      ['token-metric-input', row.inputTokens],
      ['token-metric-output', row.outputTokens],
      ['token-metric-cached', row.cachedTokens],
      ['token-metric-reasoning', row.reasoningTokens],
      ['token-metric-requests', row.requestCount]
    ].map(([className, value]) => `<td class="token-number-cell ${className}">${escapeHtml(formatUsageNumber(value || 0))}</td>`).join('');
  }

  function filterAndPaginateDailyRows(rows, dailyDate, dailyPage, dailyPageSize) {
    const filteredRows = dailyDate
      ? rows.filter((row) => row.day === dailyDate)
      : rows;
    const pageSize = Math.max(1, Number(dailyPageSize) || 10);
    const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    const currentPage = Math.min(Math.max(1, Number(dailyPage) || 1), pageCount);
    const startIndex = (currentPage - 1) * pageSize;
    return {
      filteredRows,
      pageRows: filteredRows.slice(startIndex, startIndex + pageSize),
      currentPage,
      pageCount
    };
  }

  function renderDailyTableControls(dailyDate, accountFilter = '') {
    const safeDate = escapeHtml(dailyDate || '');
    const clearButton = dailyDate
      ? `<button type="button" class="secondary" onclick="setTokenStatsDailyDate('')">${escapeHtml(t('tokenStats.clearDate'))}</button>`
      : '';
    return `<div class="token-daily-controls">
      <label class="token-date-filter">
        <span>${escapeHtml(t('tokenStats.dateFilter'))}</span>
        <input type="date" value="${safeDate}" onchange="setTokenStatsDailyDate(this.value)">
      </label>
      ${accountFilter}
      ${clearButton}
    </div>`;
  }

  function renderDailyPagination(currentPage, pageCount, totalRows) {
    const previousDisabled = currentPage <= 1 ? 'disabled' : '';
    const nextDisabled = currentPage >= pageCount ? 'disabled' : '';
    return `<div class="token-pagination">
      <button type="button" class="secondary" ${previousDisabled} onclick="setTokenStatsDailyPage(${currentPage - 1})">${escapeHtml(t('tokenStats.previousPage'))}</button>
      <span>${escapeHtml(t('tokenStats.dailyPageInfo', { page: currentPage, pages: pageCount, total: totalRows }))}</span>
      <button type="button" class="secondary" ${nextDisabled} onclick="setTokenStatsDailyPage(${currentPage + 1})">${escapeHtml(t('tokenStats.nextPage'))}</button>
    </div>`;
  }

  function renderDailyLoadingAndError(state) {
    return `${state && state.loading ? `<div class="token-loading-overlay"><div class="spinner"></div><div class="usage-note">${escapeHtml(t('tokenStats.loading'))}</div></div>` : ''}
      ${state && state.error ? `<div class="usage-note usage-error">${escapeHtml(state.error)}</div>` : ''}`;
  }

  function renderDailySummaryTable({ state, stats, dailyPage = 1, dailyDate = '', dailyPageSize = 10 }) {
    const allRows = Array.isArray(stats && stats.dailySummary) ? stats.dailySummary : [];
    const { filteredRows, pageRows, currentPage, pageCount } = filterAndPaginateDailyRows(allRows, dailyDate, dailyPage, dailyPageSize);
    const rowsHtml = pageRows.map((row) => `<tr>
      <td class="token-date-cell">${escapeHtml(row.day || '')}</td>
      ${renderMetricCells(row)}
    </tr>`).join('');
    const tableBody = rowsHtml || `<tr><td colspan="7" class="token-empty-cell">${escapeHtml(t('tokenStats.dailySummaryTableEmpty'))}</td></tr>`;

    return `<div class="usage-card token-account-card token-summary-shell">
      <div class="usage-heading">
        <span class="usage-title">${escapeHtml(t('tokenStats.dailySummaryTitle'))}</span>
        <span class="usage-subtitle">${escapeHtml(t('tokenStats.dailyPageInfo', { page: currentPage, pages: pageCount, total: filteredRows.length }))}</span>
      </div>
      ${renderDailyTableControls(dailyDate)}
      <div class="token-table-wrap">
        <table class="token-detail-table token-summary-table">
          <thead>
            <tr>
              <th class="token-date-cell">${escapeHtml(t('tokenStats.dailyDate'))}</th>
              ${renderMetricHeaderCells()}
            </tr>
          </thead>
          <tbody>${tableBody}</tbody>
        </table>
      </div>
      ${renderDailyPagination(currentPage, pageCount, filteredRows.length)}
      ${renderDailyLoadingAndError(state)}
    </div>`;
  }

  function buildDailyAccountOptions(stats, rows, services, selectedAccount) {
    const options = new Map();
    for (const record of (stats && stats.historicalAccounts) || []) {
      if (!record || !record.statsKey) continue;
      const serviceName = getServiceName(record.provider, services);
      options.set(record.statsKey, `${serviceName} · ${record.email || record.statsKey}`);
    }
    for (const row of rows || []) {
      if (!row || !row.statsKey || options.has(row.statsKey)) continue;
      const serviceName = getServiceName(row.provider, services);
      options.set(row.statsKey, `${serviceName} · ${row.email || row.statsKey}`);
    }
    if (selectedAccount && !options.has(selectedAccount)) {
      options.set(selectedAccount, selectedAccount);
    }
    return Array.from(options.entries())
      .sort((a, b) => String(a[1] || '').localeCompare(String(b[1] || '')));
  }

  function renderDailyAccountFilter(stats, rows, services, selectedAccount) {
    const options = buildDailyAccountOptions(stats, rows, services, selectedAccount);
    if (!options.length) return '';
    const optionHtml = [
      `<option value="">${escapeHtml(t('tokenStats.allAccounts'))}</option>`,
      ...options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selectedAccount ? 'selected' : ''}>${escapeHtml(label)}</option>`)
    ].join('');
    return `<label class="token-account-filter">
      <span>${escapeHtml(t('tokenStats.accountFilter'))}</span>
      <select onchange="setTokenStatsDailyAccount(this.value)">${optionHtml}</select>
    </label>`;
  }

  function renderDailyDetailsTable({ state, stats, services, dailyPage = 1, dailyDate = '', dailyAccount = '', dailyPageSize = 10 }) {
    const allRows = Array.isArray(stats && stats.dailyDetails) ? stats.dailyDetails : [];
    const accountRows = dailyAccount
      ? allRows.filter((row) => row.statsKey === dailyAccount)
      : allRows;
    const { filteredRows, pageRows, currentPage, pageCount } = filterAndPaginateDailyRows(accountRows, dailyDate, dailyPage, dailyPageSize);
    const accountFilter = renderDailyAccountFilter(stats, allRows, services, dailyAccount);
    const rowsHtml = pageRows.map((row) => `<tr>
      <td class="token-date-cell">${escapeHtml(row.day || '')}</td>
      <td class="token-provider-cell">${escapeHtml(getServiceName(row.provider, services))}</td>
      <td class="token-account-cell">${escapeHtml(row.email || row.statsKey || '')}</td>
      ${renderMetricCells(row)}
    </tr>`).join('');
    const tableBody = rowsHtml || `<tr><td colspan="9" class="token-empty-cell">${escapeHtml(t('tokenStats.dailyTableEmpty'))}</td></tr>`;

    return `<div class="usage-card token-account-card token-summary-shell">
      <div class="usage-heading">
        <span class="usage-title">${escapeHtml(t('tokenStats.dailyTitle'))}</span>
        <span class="usage-subtitle">${escapeHtml(t('tokenStats.dailyPageInfo', { page: currentPage, pages: pageCount, total: filteredRows.length }))}</span>
      </div>
      ${renderDailyTableControls(dailyDate, accountFilter)}
      <div class="token-table-wrap">
        <table class="token-detail-table">
          <thead>
            <tr>
              <th class="token-date-cell">${escapeHtml(t('tokenStats.dailyDate'))}</th>
              <th class="token-provider-cell">${escapeHtml(t('tokenStats.dailyProvider'))}</th>
              <th class="token-account-cell">${escapeHtml(t('tokenStats.dailyAccount'))}</th>
              ${renderMetricHeaderCells()}
            </tr>
          </thead>
          <tbody>${tableBody}</tbody>
        </table>
      </div>
      ${renderDailyPagination(currentPage, pageCount, filteredRows.length)}
      ${renderDailyLoadingAndError(state)}
    </div>`;
  }

  function renderTokenStatsOverview({ state, historicalByProvider, services, expandedTokenAccounts, activePeriod }) {
    const stats = state && state.stats ? state.stats : {};
    const periodStats = stats.periods && stats.periods[activePeriod] ? stats.periods[activePeriod] : null;
    const summary = renderTokenStatsSummary(state, activePeriod);
    const chart = renderLineChart((periodStats && periodStats.history) || (stats.history7d && stats.history7d.global) || [], t('tokenStats.chartTitleForPeriod', { period: t(`tokenStats.period${activePeriod.charAt(0).toUpperCase()}${activePeriod.slice(1)}`) }));

    const sections = (services || []).map((service) => {
      const records = (historicalByProvider && historicalByProvider[service.type]) || [];
      if (records.length === 0) return '';

      const cards = records.map((record) => {
        const totals = record.totals || {};
        const hasStats = (totals.totalTokens || totals.inputTokens || totals.outputTokens || totals.cachedTokens || totals.reasoningTokens || totals.requestCount);
        const titleClass = record.deleted ? 'token-account-name historical' : 'token-account-name';
        const subtitle = record.deleted ? `${service.name} · ${t('tokenStats.historyAccount')}` : service.name;
        const safeStatsKey = sanitizeForAttribute(record.statsKey || '');
        const isExpanded = expandedTokenAccounts && expandedTokenAccounts.has(record.statsKey);

        return `<div class="usage-card token-account-card compact-usage-card ${record.deleted ? 'historical-account-card' : ''}">
          <button class="usage-header" type="button" onclick="toggleTokenAccountExpand('${safeStatsKey}')">
            <div class="usage-heading">
              <span class="usage-title ${titleClass}">${escapeHtml(record.email || record.statsKey)}</span>
              <span class="usage-subtitle">${escapeHtml(subtitle)}</span>
            </div>
            <span class="usage-toggle"><span>${isExpanded ? t('usage.collapse') : t('usage.expand')}</span><span class="chevron ${isExpanded ? 'expanded' : ''}">▶</span></span>
          </button>
          ${hasStats && isExpanded ? `<div class="usage-summary compact-summary-grid token-summary-accent">${[
            renderUsagePill(t('tokenStats.totalLabel'), formatUsageNumber(totals.totalTokens || 0), 'good'),
            renderUsagePill(t('tokenStats.input'), formatUsageNumber(totals.inputTokens || 0), 'warn'),
            renderUsagePill(t('tokenStats.output'), formatUsageNumber(totals.outputTokens || 0), 'bad'),
            renderUsagePill(t('tokenStats.cached'), formatUsageNumber(totals.cachedTokens || 0), 'muted'),
            renderUsagePill(t('tokenStats.reasoning'), formatUsageNumber(totals.reasoningTokens || 0), 'info'),
            renderUsagePill(t('tokenStats.requests'), formatUsageNumber(totals.requestCount || 0), 'request')
          ].join('')}</div>` : ''}
          ${!hasStats ? `<div class="usage-note">${t('tokenStats.noData')}</div>` : ''}
        </div>`;
      });

      return `<div class="token-provider-section">
        <div class="token-provider-title">${escapeHtml(service.name)}</div>
        <div class="token-provider-grid">${cards.join('')}</div>
      </div>`;
    }).filter(Boolean);

    const body = sections.length > 0
      ? sections.join('')
      : `<div class="usage-card token-summary-card"><div class="usage-note">${t('tokenStats.noAccounts')}</div></div>`;

    return `${summary}<div class="token-chart-gap">${chart}</div>${body}`;
  }

  function renderTokenStatsPage({ state, historicalByProvider, services, expandedTokenAccounts, activePeriod = 'week', activeView = 'overview', dailyPage = 1, dailyDate = '', dailyAccount = '', dailyPageSize = 10 }) {
    const stats = state && state.stats ? state.stats : {};
    const content = activeView === 'dailySummary'
      ? renderDailySummaryTable({ state, stats, dailyPage, dailyDate, dailyPageSize })
      : activeView === 'daily'
        ? renderDailyDetailsTable({ state, stats, services, dailyPage, dailyDate, dailyAccount, dailyPageSize })
        : renderTokenStatsOverview({ state, historicalByProvider, services, expandedTokenAccounts, activePeriod });

    return `<div class="token-toolbar top"><div class="token-toolbar-left">${renderTokenStatsViewTabs(activeView)}</div><button type="button" class="secondary" onclick="refreshTokenStatsPage()">${escapeHtml(t('tokenStats.refresh'))}</button></div>${content}`;
  }

  return {
    renderUsageState,
    renderTokenStatsSummary,
    renderTokenStatsPage,
    renderTemporaryTokenState,
    formatUsageNumber
  };
}

module.exports = { createUsageRenderer };

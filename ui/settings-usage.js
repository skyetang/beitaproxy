function createUsageRenderer({
  t,
  getLocale,
  getLanguage,
  escapeHtml,
  sanitizeForAttribute,
  usageStates,
  expandedUsage
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

  function renderUsageWindowSection(window, fallback) {
    if (!window) return '';

    const rows = [];
    if (window.remainingPercent != null) {
      rows.push(renderUsageRow(t('usage.remaining'), `${formatUsageNumber(window.remainingPercent)}%`));
    }
    if (window.usedPercent != null) {
      rows.push(renderUsageRow(t('usage.used'), `${formatUsageNumber(window.usedPercent)}%`));
    }
    if (window.resetAt) {
      rows.push(renderUsageRow(t('usage.resetAt'), formatUsageDate(window.resetAt)));
    }
    if (window.resetAfterSeconds != null) {
      rows.push(renderUsageRow(t('usage.timeLeft'), escapeHtml(formatDurationSeconds(window.resetAfterSeconds))));
    }
    if (window.limitWindowSeconds != null) {
      rows.push(renderUsageRow(t('usage.windowLength'), escapeHtml(formatDurationSeconds(window.limitWindowSeconds))));
    }

    if (rows.length === 0) return '';
    return `<div class="usage-section"><div class="usage-section-title">${escapeHtml(getWindowTitle(window, fallback))}</div><div class="usage-grid">${rows.join('')}</div></div>`;
  }

  function renderUsageState(accountId) {
    const state = usageStates[accountId];
    if (!state) return '';

    if (state.loading) {
      return `<div class="usage-card"><div class="usage-note">${t('usage.querying')}</div></div>`;
    }

    if (state.error) {
      const detail = state.details ? `\n${escapeHtml(state.details)}` : '';
      return `<div class="usage-card"><div class="usage-note usage-error">${escapeHtml(state.error)}${detail}</div></div>`;
    }

    const usage = state.usage || {};
    const rateLimit = usage.rateLimit;
    const reviewLimit = usage.codeReviewRateLimit;
    const primaryWindow = rateLimit && rateLimit.primaryWindow;
    const secondaryWindow = rateLimit && rateLimit.secondaryWindow;
    const reviewWindow = reviewLimit && reviewLimit.primaryWindow;
    const summaryPills = [];
    const detailSections = [];
    const overallRows = [];
    const safeId = sanitizeForAttribute(accountId);
    const isExpanded = expandedUsage.has(accountId);

    if (usage.planType) {
      summaryPills.push(renderUsagePill(t('usage.plan'), usage.planType));
      overallRows.push(renderUsageRow(t('usage.plan'), escapeHtml(usage.planType)));
    }

    if (rateLimit) {
      const statusLabel = rateLimit.allowed && !rateLimit.limitReached ? t('common.available') : t('common.blocked');
      summaryPills.push(renderUsagePill(t('usage.status'), statusLabel, rateLimit.allowed && !rateLimit.limitReached ? 'good' : 'bad'));
      overallRows.push(renderUsageRow(t('usage.status'), escapeHtml(statusLabel)));
      overallRows.push(renderUsageRow(t('usage.limitReached'), escapeHtml(rateLimit.limitReached ? t('common.yes') : t('common.no'))));
    }

    if (primaryWindow && primaryWindow.remainingPercent != null) {
      summaryPills.push(renderUsagePill(
        getWindowRemainingLabel(primaryWindow, 'primary'),
        `${formatUsageNumber(primaryWindow.remainingPercent)}%`,
        getUsageVariant(primaryWindow.remainingPercent)
      ));
    }

    if (secondaryWindow && secondaryWindow.remainingPercent != null) {
      summaryPills.push(renderUsagePill(
        getWindowRemainingLabel(secondaryWindow, 'secondary'),
        `${formatUsageNumber(secondaryWindow.remainingPercent)}%`,
        getUsageVariant(secondaryWindow.remainingPercent)
      ));
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

    if (overallRows.length > 0) {
      detailSections.push(`<div class="usage-section"><div class="usage-grid">${overallRows.join('')}</div></div>`);
    }

    const primarySection = renderUsageWindowSection(primaryWindow, 'primary');
    const secondarySection = renderUsageWindowSection(secondaryWindow, 'secondary');
    if (primarySection) detailSections.push(primarySection);
    if (secondarySection) detailSections.push(secondarySection);

    if (reviewLimit || reviewWindow) {
      const reviewRows = [];
      if (reviewLimit) {
        const statusLabel = reviewLimit.allowed ? t('common.available') : t('common.blocked');
        reviewRows.push(renderUsageRow(t('usage.codeReviewStatus'), escapeHtml(statusLabel)));
      }
      if (reviewWindow && reviewWindow.usedPercent != null) {
        reviewRows.push(renderUsageRow(t('usage.reviewUsed'), `${formatUsageNumber(reviewWindow.usedPercent)}%`));
      }
      if (reviewWindow && reviewWindow.resetAt) {
        reviewRows.push(renderUsageRow(t('usage.reviewResetAt'), formatUsageDate(reviewWindow.resetAt)));
      }
      if (reviewRows.length > 0) {
        detailSections.push(`<div class="usage-section"><div class="usage-section-title">${escapeHtml(t('usage.codeReview'))}</div><div class="usage-grid">${reviewRows.join('')}</div></div>`);
      }
    }

    if (detailSections.length === 0 && usage.raw) {
      detailSections.push(`<div class="usage-note">${escapeHtml(JSON.stringify(usage.raw, null, 2).slice(0, 800) || t('usage.noData'))}</div>`);
    }
    if (detailSections.length === 0 && !usage.raw) {
      detailSections.push(`<div class="usage-note">${t('usage.noData')}</div>`);
    }

    const subtitle = usage.retrievedAt
      ? t('usage.subtitleUpdated', { value: formatDateText(usage.retrievedAt) })
      : t('usage.subtitleFallback');
    const promo = usage.promo && usage.promo.message
      ? `<div class="usage-note">${escapeHtml(usage.promo.message)}</div>`
      : '';

    return `<div class="usage-card">
      <button class="usage-header" type="button" onclick="toggleUsageExpand('${safeId}')">
        <div class="usage-heading">
          <span class="usage-title">${t('usage.overview')}</span>
          <span class="usage-subtitle">${escapeHtml(subtitle)}</span>
        </div>
        <span class="usage-toggle"><span>${isExpanded ? t('usage.collapse') : t('usage.expand')}</span><span class="chevron ${isExpanded ? 'expanded' : ''}">▶</span></span>
      </button>
      ${summaryPills.length > 0 ? `<div class="usage-summary">${summaryPills.join('')}</div>` : ''}
      ${isExpanded ? `<div class="usage-sections">${detailSections.join('')}${promo}</div>` : ''}
    </div>`;
  }

  return {
    renderUsageState
  };
}

module.exports = { createUsageRenderer };

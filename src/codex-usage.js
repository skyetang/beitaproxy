function parseDateValue(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseEpochSeconds(value) {
  const numeric = toNumber(value);
  if (numeric == null) return null;
  const date = new Date(numeric * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim();
    if (/^-?\d+(\.\d+)?$/.test(normalized)) {
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }

  return null;
}

function normalizeLookupKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function findFirstMatchingValue(root, keyNames) {
  const targets = new Set(keyNames.map(normalizeLookupKey));
  const visited = new Set();

  function walk(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    if (visited.has(value)) {
      return null;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found !== null) return found;
      }
      return null;
    }

    for (const [key, nested] of Object.entries(value)) {
      if (targets.has(normalizeLookupKey(key))) {
        return nested;
      }
    }

    for (const nested of Object.values(value)) {
      const found = walk(nested);
      if (found !== null) return found;
    }

    return null;
  }

  return walk(root);
}

function inferUsageCycle(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  const days = Math.round((end - start) / (24 * 60 * 60 * 1000));
  if (days >= 6 && days <= 8) return 'Weekly';
  if (days >= 27 && days <= 32) return 'Monthly';
  return `${days} days`;
}

function normalizeCodexUsageResponse(payload) {
  function normalizeWindow(window) {
    if (!window || typeof window !== 'object') return null;
    const usedPercent = toNumber(window.used_percent);
    return {
      usedPercent,
      remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
      limitWindowSeconds: toNumber(window.limit_window_seconds),
      resetAfterSeconds: toNumber(window.reset_after_seconds),
      resetAt: parseEpochSeconds(window.reset_at)
    };
  }

  function normalizeLimit(limit) {
    if (!limit || typeof limit !== 'object') return null;
    return {
      allowed: limit.allowed !== false,
      limitReached: limit.limit_reached === true,
      primaryWindow: normalizeWindow(limit.primary_window),
      secondaryWindow: normalizeWindow(limit.secondary_window)
    };
  }

  const rateLimit = normalizeLimit(payload.rate_limit);
  const codeReviewRateLimit = normalizeLimit(payload.code_review_rate_limit);
  if (rateLimit || codeReviewRateLimit) {
    const primaryWindow = rateLimit && rateLimit.primaryWindow;
    return {
      email: payload.email || null,
      accountId: payload.account_id || null,
      planType: payload.plan_type || null,
      rateLimit,
      codeReviewRateLimit,
      cycle: primaryWindow && primaryWindow.limitWindowSeconds
        ? `${Math.round(primaryWindow.limitWindowSeconds / 86400)} days`
        : null,
      usedPercent: primaryWindow ? primaryWindow.usedPercent : null,
      periodEnd: primaryWindow ? primaryWindow.resetAt : null,
      promo: payload.promo || null,
      credits: payload.credits || null,
      raw: payload
    };
  }

  const used = toNumber(findFirstMatchingValue(payload, [
    'currentUsageAmount',
    'usageAmount',
    'usedAmount',
    'usageUsed',
    'currentUsage',
    'totalUsage',
    'used'
  ]));
  const limit = toNumber(findFirstMatchingValue(payload, [
    'usageLimitWithPrecision',
    'usageLimit',
    'totalLimit',
    'limit',
    'quota',
    'max'
  ]));
  const remaining = toNumber(findFirstMatchingValue(payload, [
    'remainingAmount',
    'remainingUsage',
    'remaining',
    'availableAmount',
    'available',
    'left'
  ]));
  const start = parseDateValue(findFirstMatchingValue(payload, [
    'billingPeriodStart',
    'currentPeriodStart',
    'periodStart',
    'cycleStart',
    'startDate',
    'startsAt'
  ]));
  const end = parseDateValue(findFirstMatchingValue(payload, [
    'billingPeriodEnd',
    'currentPeriodEnd',
    'periodEnd',
    'cycleEnd',
    'resetDate',
    'resetAt',
    'resetsAt',
    'endDate'
  ]));
  const cycle = findFirstMatchingValue(payload, [
    'billingPeriod',
    'usagePeriod',
    'period',
    'cycle',
    'interval'
  ]);

  let normalizedUsed = used;
  let normalizedRemaining = remaining;
  if (normalizedUsed == null && limit != null && remaining != null) {
    normalizedUsed = Math.max(limit - remaining, 0);
  }
  if (normalizedRemaining == null && limit != null && used != null) {
    normalizedRemaining = Math.max(limit - used, 0);
  }

  return {
    used: normalizedUsed,
    remaining: normalizedRemaining,
    limit,
    periodStart: start,
    periodEnd: end,
    cycle: typeof cycle === 'string' && cycle.trim() ? cycle.trim() : inferUsageCycle(start, end),
    raw: payload
  };
}

module.exports = { normalizeCodexUsageResponse };

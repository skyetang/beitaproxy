const path = require('path');
const yaml = require('js-yaml');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map(deepClone);
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = deepClone(nested);
    }
    return result;
  }
  return value;
}

function mergeArraysByName(baseArray, overlayArray) {
  const result = baseArray.map(entry => deepClone(entry));
  const indexByName = new Map();

  for (let index = 0; index < result.length; index++) {
    const entry = result[index];
    if (isPlainObject(entry) && typeof entry.name === 'string' && entry.name.trim()) {
      indexByName.set(entry.name.trim(), index);
    }
  }

  for (const overlayEntry of overlayArray) {
    const clonedOverlay = deepClone(overlayEntry);
    if (isPlainObject(clonedOverlay) && typeof clonedOverlay.name === 'string' && clonedOverlay.name.trim()) {
      const name = clonedOverlay.name.trim();
      if (indexByName.has(name)) {
        const targetIndex = indexByName.get(name);
        const baseEntry = result[targetIndex];
        result[targetIndex] = isPlainObject(baseEntry)
          ? mergeValues(baseEntry, clonedOverlay, { key: 'openai-compatibility-item' })
          : clonedOverlay;
      } else {
        indexByName.set(name, result.length);
        result.push(clonedOverlay);
      }
    } else {
      result.push(clonedOverlay);
    }
  }

  return result;
}

function mergeValues(baseValue, overlayValue, context = {}) {
  if (overlayValue === undefined) {
    return deepClone(baseValue);
  }

  if (Array.isArray(baseValue) && Array.isArray(overlayValue)) {
    if (context.key === 'openai-compatibility') {
      return mergeArraysByName(baseValue, overlayValue);
    }
    return deepClone(overlayValue);
  }

  if (isPlainObject(baseValue) && isPlainObject(overlayValue)) {
    const merged = deepClone(baseValue);
    for (const [key, value] of Object.entries(overlayValue)) {
      merged[key] = mergeValues(merged[key], value, { key });
    }
    return merged;
  }

  return deepClone(overlayValue);
}

function loadYamlFile(filePath, fs) {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(content);
  if (parsed == null) return {};
  if (!isPlainObject(parsed)) {
    throw new Error(`Config at ${filePath} must be a YAML mapping at the root.`);
  }
  return parsed;
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function loadBaseConfigRoot({ fs, bundledConfigPath, userConfigPath }) {
  const bundledRoot = loadYamlFile(bundledConfigPath, fs);
  if (!fs.existsSync(userConfigPath)) {
    return { root: bundledRoot, isUserConfig: false };
  }
  const userRoot = loadYamlFile(userConfigPath, fs);
  return {
    root: mergeValues(bundledRoot, userRoot),
    isUserConfig: true
  };
}

function loadZaiApiKeys({ fs, authDir, ensureAuthDir }) {
  ensureAuthDir();
  const keys = [];
  const files = fs.readdirSync(authDir);
  for (const file of files) {
    if (!file.startsWith('zai-') || !file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(authDir, file), 'utf8'));
      if (data.disabled === true) continue;
      if (typeof data.api_key === 'string' && data.api_key.trim()) {
        keys.push(data.api_key.trim());
      }
    } catch (e) {}
  }
  return dedupeStrings(keys);
}

function buildDisabledOAuthProviders({ oauthProviderKeys, isProviderEnabled }) {
  const disabledProviders = [];
  for (const [serviceKey, oauthKey] of Object.entries(oauthProviderKeys)) {
    if (!isProviderEnabled(serviceKey)) {
      disabledProviders.push(oauthKey);
    }
  }
  return disabledProviders.sort();
}

function composeRuntimeConfig({ baseRoot, disabledProviders, zaiKeys, zaiEnabled }) {
  const mergedRoot = deepClone(baseRoot);

  const oauthExcludedModels = isPlainObject(mergedRoot['oauth-excluded-models'])
    ? deepClone(mergedRoot['oauth-excluded-models'])
    : {};
  for (const provider of disabledProviders) {
    oauthExcludedModels[provider] = ['*'];
  }
  if (Object.keys(oauthExcludedModels).length > 0) {
    mergedRoot['oauth-excluded-models'] = oauthExcludedModels;
  } else {
    delete mergedRoot['oauth-excluded-models'];
  }

  let openAICompatibility = Array.isArray(mergedRoot['openai-compatibility'])
    ? deepClone(mergedRoot['openai-compatibility']).filter(isPlainObject)
    : [];

  openAICompatibility = openAICompatibility.filter(entry => String(entry.name || '').trim() !== 'zai');
  if (zaiEnabled && zaiKeys.length > 0) {
    openAICompatibility.push({
      name: 'zai',
      'base-url': 'https://api.z.ai/api/coding/paas/v4',
      'api-key-entries': zaiKeys.map(apiKey => ({ 'api-key': apiKey })),
      models: [{ name: 'glm-4.7', alias: 'glm-4.7' }]
    });
  }

  if (openAICompatibility.length > 0) {
    mergedRoot['openai-compatibility'] = openAICompatibility;
  } else {
    delete mergedRoot['openai-compatibility'];
  }

  return mergedRoot;
}

function writeMergedConfig({ fs, mergedConfigPath, runtimeRoot }) {
  const mergedYaml = yaml.dump(runtimeRoot, { noRefs: true, lineWidth: 120 });
  fs.writeFileSync(mergedConfigPath, mergedYaml, 'utf8');
  try { fs.chmodSync(mergedConfigPath, 0o600); } catch (e) {}
  return mergedConfigPath;
}

module.exports = {
  buildDisabledOAuthProviders,
  composeRuntimeConfig,
  loadBaseConfigRoot,
  loadZaiApiKeys,
  writeMergedConfig
};

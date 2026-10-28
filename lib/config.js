/**
 * Configuration for the Agnes image plugin.
 *
 * Cordis hands the bundle row's `config` object to `apply()`. This module
 * normalizes it once, so every tool runs with validated values and a bad row
 * fails activation with one readable message instead of failing a generation
 * after the model already spent a tool call on it.
 */

/** Resolution tiers accepted by the API. */
export const SIZE_TIERS = ['1K', '2K', '3K', '4K'];

/** Aspect ratios accepted by the API. */
export const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

/** Defaults matching the reference documentation. */
export const DEFAULT_CONFIG = Object.freeze({
  apiKey: '',
  apiKeyEnv: 'AGNES_API_KEY',
  endpoint: 'https://apihub.agnes-ai.com/v1/images/generations',
  model: 'agnes-image-2.5-flash',
  defaultSize: '2K',
  defaultRatio: '1:1',
  outputDir: 'agnes-output',
  maxReferenceImages: 6,
  timeoutMs: 240_000,
  downloadTimeoutMs: 120_000,
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
});

const MIB = 1024 * 1024;

/**
 * Validate a raw config object and fill in defaults.
 * @param {unknown} raw - the Loader row's config value.
 * @returns {typeof DEFAULT_CONFIG} the normalized config.
 */
export function resolveConfig(raw) {
  const input = raw === undefined || raw === null
    ? {}
    : isRecord(raw)
      ? raw
      : fail('config must be a mapping of plugin settings');

  const config = { ...DEFAULT_CONFIG, ...input };

  config.apiKey = optionalString(config.apiKey, 'apiKey');
  config.apiKeyEnv = optionalString(config.apiKeyEnv, 'apiKeyEnv');
  config.model = requiredString(config.model, 'model');
  config.defaultSize = enumValue(config.defaultSize, SIZE_TIERS, 'defaultSize');
  config.defaultRatio = enumValue(config.defaultRatio, RATIOS, 'defaultRatio');
  config.outputDir = requiredString(config.outputDir, 'outputDir');

  const endpoint = requiredString(config.endpoint, 'endpoint');
  if (!/^https?:\/\/\S+$/i.test(endpoint)) {
    fail('endpoint must be an http(s) URL, for example https://apihub.agnes-ai.com/v1/images/generations');
  }
  config.endpoint = endpoint;

  config.maxReferenceImages = integerInRange(config.maxReferenceImages, 'maxReferenceImages', 1, 16);
  config.timeoutMs = integerInRange(config.timeoutMs, 'timeoutMs', 5_000, 3_600_000);
  config.downloadTimeoutMs = integerInRange(config.downloadTimeoutMs, 'downloadTimeoutMs', 5_000, 3_600_000);
  config.maxInputBytes = integerInRange(config.maxInputBytes, 'maxInputBytes', 1, 256 * MIB);
  config.maxOutputBytes = integerInRange(config.maxOutputBytes, 'maxOutputBytes', 1024, 512 * MIB);

  return Object.freeze(config);
}

/**
 * Resolve the API key from the explicit config first, then the named env var.
 * The value is never logged or echoed.
 * @param {{ apiKey: string, apiKeyEnv: string }} config - normalized config.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} the key, or an empty string when unconfigured.
 */
export function resolveApiKey(config, env = process.env) {
  const explicit = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (explicit !== '') return explicit;
  const name = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv.trim() : '';
  if (name === '') return '';
  const fromEnv = env[name];
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`agnes-image: ${message}`);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(`${field} must be a string`);
  return value.trim();
}

function enumValue(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`${field} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }
  return value;
}

function integerInRange(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

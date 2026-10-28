/**
 * Configuration for the Agnes plugin (images and videos).
 *
 * Cordis hands the bundle row's `config` object to `apply()`. This module
 * normalizes it once, so every tool runs with validated values and a bad row
 * fails activation with one readable message instead of failing a generation
 * after the model already spent a tool call on it.
 */

/** Resolution tiers accepted by the image API. */
export const SIZE_TIERS = ['1K', '2K', '3K', '4K'];

/** Aspect ratios accepted by the image API. */
export const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

/** Video durations accepted by the video API, as strings. */
export const VIDEO_SECONDS = ['4', '5', '6', '7', '8', '9', '10', '11', '12'];

/** Aspect ratios accepted by the video API. */
export const VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];

/** Generation modes of the video API. */
export const VIDEO_MODES = ['text', 'keyframe', 'reference'];

/** The only resolution tier Agnes Video 2.5 Flash accepts. */
export const VIDEO_SIZE = '720P';

/** Credential reference the Settings page writes and the tools resolve. */
export const DEFAULT_CREDENTIAL_REF = 'AGNES_API_KEY';

/** Defaults matching the reference documentation. */
export const DEFAULT_CONFIG = Object.freeze({
  apiKey: '',
  credentialRef: DEFAULT_CREDENTIAL_REF,
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
  videoEndpoint: 'https://apihub.agnes-ai.com/v1/videos',
  videoQueryEndpoint: 'https://apihub.agnes-ai.com/agnesapi',
  videoModel: 'agnes-video-2.5-flash',
  videoDefaultSeconds: '5',
  videoDefaultAspectRatio: '16:9',
  videoPollIntervalMs: 2_000,
  videoWaitMs: 180_000,
  videoDownloadTimeoutMs: 120_000,
  maxVideoBytes: 256 * 1024 * 1024,
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
  config.credentialRef = credentialRef(config.credentialRef, 'credentialRef');
  config.model = requiredString(config.model, 'model');
  config.defaultSize = enumValue(config.defaultSize, SIZE_TIERS, 'defaultSize');
  config.defaultRatio = enumValue(config.defaultRatio, RATIOS, 'defaultRatio');
  config.outputDir = requiredString(config.outputDir, 'outputDir');

  const endpoint = requiredString(config.endpoint, 'endpoint');
  if (!/^https?:\/\/\S+$/i.test(endpoint)) {
    fail('endpoint must be an http(s) URL, for example https://apihub.agnes-ai.com/v1/images/generations');
  }
  config.endpoint = endpoint;

  for (const field of ['videoEndpoint', 'videoQueryEndpoint']) {
    const value = requiredString(config[field], field);
    if (!/^https?:\/\/\S+$/i.test(value)) fail(`${field} must be an http(s) URL`);
    config[field] = value;
  }
  config.videoModel = requiredString(config.videoModel, 'videoModel');
  config.videoDefaultSeconds = enumValue(config.videoDefaultSeconds, VIDEO_SECONDS, 'videoDefaultSeconds');
  config.videoDefaultAspectRatio = enumValue(config.videoDefaultAspectRatio, VIDEO_RATIOS, 'videoDefaultAspectRatio');

  config.maxReferenceImages = integerInRange(config.maxReferenceImages, 'maxReferenceImages', 1, 16);
  config.timeoutMs = integerInRange(config.timeoutMs, 'timeoutMs', 5_000, 3_600_000);
  config.downloadTimeoutMs = integerInRange(config.downloadTimeoutMs, 'downloadTimeoutMs', 5_000, 3_600_000);
  config.maxInputBytes = integerInRange(config.maxInputBytes, 'maxInputBytes', 1, 256 * MIB);
  config.maxOutputBytes = integerInRange(config.maxOutputBytes, 'maxOutputBytes', 1024, 512 * MIB);
  config.videoPollIntervalMs = integerInRange(config.videoPollIntervalMs, 'videoPollIntervalMs', 100, 60_000);
  config.videoWaitMs = integerInRange(config.videoWaitMs, 'videoWaitMs', 200, 1_800_000);
  config.videoDownloadTimeoutMs = integerInRange(config.videoDownloadTimeoutMs, 'videoDownloadTimeoutMs', 5_000, 1_800_000);
  config.maxVideoBytes = integerInRange(config.maxVideoBytes, 'maxVideoBytes', 1024, 1024 * MIB);

  return Object.freeze(config);
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

function credentialRef(value, field) {
  const ref = requiredString(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(ref)) {
    fail(`${field} must be a credential reference such as AGNES_API_KEY (letters, digits, "_", ".", "-")`);
  }
  return ref;
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

/**
 * The two model-facing tools.
 *
 * `agnes_text2img` is a plain generation; `agnes_img2img` adds reference
 * images (local paths, public HTTPS URLs, or data URIs). Both share one
 * executor so the request shape, error surface, and saved result cannot drift
 * apart between them.
 */

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { buildRequestBody, readGeneratedImage, requestGeneration } from './agnes-api.js';
import {
  formatBytes,
  imageDimensions,
  resolveOutputTarget,
  sniffMediaType,
  toDataUri,
  writeOutputFile,
} from './agnes-files.js';
import { missingKeyMessage } from './agnes-key.js';
import { RATIOS, SIZE_TIERS } from './config.js';

/** Result fields shared by both tools; optional fields appear only when known. */
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', const: true },
    model: { type: 'string' },
    prompt: { type: 'string' },
    size: { type: 'string' },
    ratio: { type: 'string' },
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    elapsedMs: { type: 'integer' },
    taskId: { type: 'string' },
    revisedPrompt: { type: 'string' },
    sourceImages: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'model', 'prompt', 'size', 'ratio', 'path', 'width', 'height', 'bytes', 'elapsedMs'],
});

/** Parameters shared by both tools. */
function sharedParameters(config) {
  return {
    prompt: {
      type: 'string',
      description: 'What to draw. Be concrete about subject, style, composition, lighting, colors, and background; roughly 900 characters works well. Describe what you want, not what to avoid: the endpoint has no negative prompt.',
    },
    size: {
      type: 'string',
      enum: SIZE_TIERS,
      description: `Resolution tier. Defaults to ${config.defaultSize}. Exact pixels come from the tier plus the ratio, so do not request 1920x1080: use size 2K with ratio 16:9 (2624x1472).`,
    },
    ratio: {
      type: 'string',
      enum: RATIOS,
      description: `Aspect ratio. Defaults to ${config.defaultRatio}. Native sizes include 1:1 1024x1024 at 1K, 16:9 2624x1472 at 2K, and 21:9 3136x1344 at 2K.`,
    },
    path: {
      type: 'string',
      description: `Optional output file path. Relative paths resolve against the session working directory; a trailing separator means "inside this directory with the default name". Defaults to the plugin outputDir (${config.outputDir}) with a timestamped name. PNG bytes are always written, and a taken name gains a numeric suffix instead of overwriting.`,
    },
  };
}

/**
 * Build both tool definitions for one plugin activation.
 * @param {{
 *   config: import('./config.js').DEFAULT_CONFIG,
 *   resolveCwd: (exec: { agent?: unknown, signal?: AbortSignal }) => Promise<string>,
 *   resolveApiKey: () => Promise<string>,
 * }} options - plugin wiring; `resolveApiKey` re-reads the credential seam on
 *   every call, so a key saved in Settings reaches the next generation.
 * @returns {Array<Record<string, unknown>>} registry-ready definitions.
 */
export function createToolDefinitions({ config, resolveCwd, resolveApiKey }) {
  const timeoutMs = config.timeoutMs + config.downloadTimeoutMs + 30_000;

  const text2img = {
    name: 'agnes_text2img',
    description: [
      'Generate one image from a text prompt with Agnes Image 2.5 Flash, save it as a PNG, and return its path, pixel size, and byte size.',
      'Use it for illustrations, textures, backgrounds, sprites, and concept art.',
      'Only the size tier and aspect ratio can be adjusted: there is no seed, negative prompt, or step control, so the same prompt does not reproduce the same image.',
      'Images are RGB PNG without alpha; create transparency later by keying out the background.',
      'To show the result in chat, call read_image with the returned path; to offer it as a deliverable, call present.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: sharedParameters(config),
      required: ['prompt'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderResult,
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    execute: (args, exec) => generate({ config, resolveCwd, resolveApiKey, exec, args, mode: 'text' }),
  };

  const img2img = {
    name: 'agnes_img2img',
    description: [
      'Generate one image guided by 1-6 reference images with Agnes Image 2.5 Flash, save it as a PNG, and return its path, pixel size, and byte size.',
      'Use it to restyle, redraw, edit, or composite: describe in the prompt what should survive and what should change.',
      'Each reference may be a local image path, a public HTTPS URL, or a data URI. Multi-image composition works for subject plus product; pose control from a reference is weak, so describe the pose in the prompt.',
      'The output is a new image, not an in-place edit; the original files are never modified. To show the result in chat, call read_image with the returned path.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...sharedParameters(config),
        images: {
          type: 'array',
          items: { type: 'string' },
          description: `1 to ${config.maxReferenceImages} reference images: local paths (relative to the session working directory, or absolute, including Windows drive paths), public HTTPS URLs, or data:image/...;base64,... URIs. PNG, JPEG, GIF, and WebP are accepted. Reference 1 dominates the result.`,
        },
      },
      required: ['prompt', 'images'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderResult,
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    execute: (args, exec) => generate({ config, resolveCwd, resolveApiKey, exec, args, mode: 'img2img' }),
  };

  return [text2img, img2img];
}

/**
 * Render one saved generation as model-facing text.
 * @param {unknown} _args - the call arguments, unused.
 * @param {Record<string, unknown>} value - the validated tool value.
 * @returns {Array<{ type: 'text', text: string }>} content blocks.
 */
function renderResult(_args, value) {
  const dimensions = value.width > 0 && value.height > 0 ? `${value.width}x${value.height}` : 'size unknown';
  const seconds = (value.elapsedMs / 1000).toFixed(1);
  const lines = [
    `Generated 1 image (${dimensions}, ${formatBytes(value.bytes)}) with ${value.model} in ${seconds}s.`,
    `Path: ${value.path}`,
    `Show it in chat with read_image (file_path: ${JSON.stringify(value.path)}), or deliver it with present.`,
  ];
  if (Array.isArray(value.sourceImages) && value.sourceImages.length > 0) {
    lines.splice(1, 0, `Reference images: ${value.sourceImages.length}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Validate one call's shared arguments and run it.
 * @param {{
 *   config: import('./config.js').DEFAULT_CONFIG,
 *   resolveCwd: (exec: { agent?: unknown, signal?: AbortSignal }) => Promise<string>,
 *   resolveApiKey: () => Promise<string>,
 *   exec: { agent?: unknown, signal?: AbortSignal },
 *   args: Record<string, unknown>,
 *   mode: 'text' | 'img2img',
 * }} input - call inputs.
 * @returns {Promise<Record<string, unknown>>} the tool value.
 */
async function generate({ config, resolveCwd, resolveApiKey, exec, args, mode }) {
  const apiKey = await resolveApiKey();
  if (apiKey === '') throw new Error(missingKeyMessage(config.credentialRef));

  const prompt = requireText(args.prompt, 'prompt');
  const size = args.size === undefined ? config.defaultSize : requireChoice(args.size, SIZE_TIERS, 'size');
  const ratio = args.ratio === undefined ? config.defaultRatio : requireChoice(args.ratio, RATIOS, 'ratio');
  const cwd = await resolveCwd(exec);
  const startedAt = Date.now();

  const references = mode === 'img2img'
    ? await prepareReferenceImages({ references: args.images, cwd, config })
    : { payload: [], labels: [] };

  const source = await requestGeneration({
    endpoint: config.endpoint,
    apiKey,
    body: buildRequestBody({
      model: config.model,
      prompt,
      size,
      ratio,
      images: references.payload,
    }),
    timeoutMs: config.timeoutMs,
    signal: exec.signal,
  });

  const image = await readGeneratedImage({
    source,
    timeoutMs: config.downloadTimeoutMs,
    maxBytes: config.maxOutputBytes,
    signal: exec.signal,
  });

  const mediaType = sniffMediaType(image.bytes) ?? image.mediaType ?? 'image/png';
  const dimensions = imageDimensions(image.bytes, mediaType);
  const target = resolveOutputTarget({ cwd, requested: args.path, outputDir: config.outputDir });
  const savedPath = await writeOutputFile(target, image.bytes);

  return {
    ok: true,
    model: config.model,
    prompt,
    size,
    ratio,
    path: savedPath,
    width: dimensions?.width ?? 0,
    height: dimensions?.height ?? 0,
    bytes: image.bytes.byteLength,
    elapsedMs: Date.now() - startedAt,
    ...(source.taskId === undefined ? {} : { taskId: source.taskId }),
    ...(source.revisedPrompt === undefined ? {} : { revisedPrompt: source.revisedPrompt }),
    ...(references.labels.length === 0 ? {} : { sourceImages: references.labels }),
  };
}

/**
 * Turn reference arguments into request payload entries.
 * @param {{ references: unknown, cwd: string, config: import('./config.js').DEFAULT_CONFIG }} input
 *   - reference arguments and limits.
 * @returns {Promise<{ payload: string[], labels: string[] }>} endpoint entries and safe labels.
 */
async function prepareReferenceImages({ references, cwd, config }) {
  if (!Array.isArray(references) || references.length === 0) {
    throw new Error('agnes_img2img requires 1 or more reference images in `images`');
  }
  if (references.length > config.maxReferenceImages) {
    throw new Error(`agnes_img2img accepts at most ${config.maxReferenceImages} reference images; ${references.length} were provided`);
  }

  const payload = [];
  const labels = [];

  for (const [index, raw] of references.entries()) {
    if (typeof raw !== 'string') throw new Error(`images[${index}] must be a string`);
    const reference = raw.trim();
    if (reference === '') throw new Error(`images[${index}] is empty`);

    if (/^data:/i.test(reference)) {
      if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(reference)) {
        throw new Error(`images[${index}] is not a base64 image data URI`);
      }
      payload.push(reference);
      labels.push('inline data URI');
      continue;
    }

    if (/^https?:\/\//i.test(reference)) {
      payload.push(reference);
      labels.push(reference);
      continue;
    }

    const scheme = unsupportedScheme(reference);
    if (scheme !== undefined) {
      throw new Error(`images[${index}] uses the unsupported "${scheme}:" scheme; pass a local path, an http(s) URL, or a data:image URI`);
    }

    const absolute = isAbsolute(reference) ? reference : resolve(cwd, reference);
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      throw new Error(`Reference image not found: ${reference}`);
    }
    if (info.size > config.maxInputBytes) {
      throw new Error(`Reference image ${reference} is ${formatBytes(info.size)}, above the ${formatBytes(config.maxInputBytes)} limit`);
    }
    const bytes = await readFile(absolute);
    const mediaType = sniffMediaType(bytes);
    if (mediaType === undefined) {
      throw new Error(`Reference image ${reference} is not a PNG, JPEG, GIF, or WebP file`);
    }
    payload.push(toDataUri(bytes, mediaType));
    labels.push(reference);
  }

  return { payload, labels };
}

/**
 * Detect a URI scheme the endpoint cannot fetch, without mistaking a Windows
 * drive letter for one.
 *
 * `F:\art\cat.png` matches the RFC 3986 scheme grammar (`F:`), but it is an
 * ordinary absolute Windows path and must be read from disk like any other
 * local file. A one-letter scheme followed by a separator (`C:\`, `C:/`) is
 * therefore treated as local; every other scheme (`file:`, `ftp:`, `blob:`,
 * `data:`…) is reported so the caller gets an actionable message.
 * @param {string} reference - one trimmed `images[]` entry.
 * @returns {string | undefined} the lowercased scheme, or undefined for a path.
 */
export function unsupportedScheme(reference) {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(reference);
  if (match === null) return undefined;
  const scheme = match[1].toLowerCase();
  if (scheme.length === 1 && /^[a-z]:[\\/]/i.test(reference)) return undefined;
  return scheme;
}

/**
 * Require one non-empty string argument.
 * @param {unknown} value - candidate.
 * @param {string} field - argument name for the message.
 * @returns {string} the trimmed value.
 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`agnes: ${field} must be a non-empty string`);
  return value.trim();
}

/**
 * Require one value from a closed set.
 * @param {unknown} value - candidate.
 * @param {readonly string[]} allowed - accepted values.
 * @param {string} field - argument name for the message.
 * @returns {string} the value.
 */
function requireChoice(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`agnes: ${field} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }
  return value;
}

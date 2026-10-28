/**
 * Media formats and output files.
 *
 * Agnes answers PNG for images and MP4 for videos today, but every tool reads
 * the real signature before it claims a media type, reads the real header
 * before it claims pixel dimensions, and never overwrites an existing file.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Detect a supported image media type from its leading bytes.
 * @param {Uint8Array} bytes - encoded image.
 * @returns {'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined} the media type.
 */
export function sniffMediaType(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * Detect a video container from its leading bytes.
 * @param {Uint8Array} bytes - encoded video.
 * @returns {'video/mp4' | 'video/webm' | undefined} the container media type.
 */
export function sniffVideoContainer(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm';
  return undefined;
}

/**
 * Read pixel dimensions without decoding the image.
 * @param {Uint8Array} bytes - encoded image.
 * @param {string | undefined} mediaType - declared media type, used only as a hint.
 * @returns {{ width: number, height: number } | undefined} the dimensions.
 */
export function imageDimensions(bytes, mediaType) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = mediaType ?? sniffMediaType(buffer);
  if (type === 'image/png') return pngDimensions(buffer);
  if (type === 'image/jpeg') return jpegDimensions(buffer);
  if (type === 'image/gif') return gifDimensions(buffer);
  if (type === 'image/webp') return webpDimensions(buffer);
  return undefined;
}

/** Parse the IHDR chunk of a PNG. */
function pngDimensions(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Scan JPEG segments for a start-of-frame marker. */
function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

/** Read the logical screen size from a GIF header. */
function gifDimensions(buffer) {
  if (buffer.length < 10 || buffer.toString('ascii', 0, 4) !== 'GIF8') return undefined;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Read the first bitstream frame size from a WebP header. */
function webpDimensions(buffer) {
  if (buffer.length < 30) return undefined;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/**
 * Encode bytes as a data URI the endpoint accepts as a reference image.
 * @param {Uint8Array} bytes - encoded image.
 * @param {string} mediaType - its media type.
 * @returns {string} the data URI.
 */
export function toDataUri(bytes, mediaType) {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * Render a byte count for humans.
 * @param {number} bytes - byte count.
 * @returns {string} a compact string such as `1.8 MB`.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Build a collision-free, filesystem-safe filename for one generation.
 * @param {Date} [now] - timestamp to encode.
 * @param {string} [extension] - file extension including the dot.
 * @param {string} [prefix] - name stem.
 * @returns {string} a name like `agnes-20261028-163012-9f3a.png`.
 */
export function defaultFileName(now = new Date(), extension = '.png', prefix = 'agnes') {
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('') + '-' + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('');
  return `${prefix}-${stamp}-${randomBytes(2).toString('hex')}${extension}`;
}

/**
 * Strip characters Windows and POSIX both refuse, keeping a usable stem.
 * @param {string} name - requested file name or path fragment.
 * @returns {string} the sanitized name.
 */
export function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned === '' ? defaultFileName() : cleaned;
}

/**
 * Resolve where a generated file should be written.
 *
 * `requested` is a path (relative values resolve against the session working
 * directory); a trailing separator means "use my default filename inside this
 * directory". Anything else is treated as a file name, and a different
 * extension is appended because the bytes decide the format.
 * @param {{
 *   cwd: string,
 *   requested?: string | undefined,
 *   outputDir: string,
 *   extension?: string,
 *   prefix?: string,
 *   now?: Date,
 * }} input - path inputs.
 * @returns {string} an absolute target path that does not exist yet.
 */
export function resolveOutputTarget({ cwd, requested, outputDir, extension = '.png', prefix = 'agnes', now = new Date() }) {
  const fileName = defaultFileName(now, extension, prefix);
  const directoryHint = isAbsolute(outputDir) ? outputDir : resolve(cwd, outputDir);

  if (typeof requested !== 'string' || requested.trim() === '') {
    return join(directoryHint, fileName);
  }

  const trimmed = requested.trim();
  const looksLikeDirectory = /[\\/]$/.test(trimmed);
  const target = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);

  if (looksLikeDirectory) return join(target, fileName);

  const withExtension = extname(target).toLowerCase() === extension ? target : `${target}${extension}`;
  const safeName = sanitizeFileName(basename(withExtension));
  return join(dirname(withExtension), safeName);
}

/**
 * Write bytes to a new file, creating parent directories and never replacing
 * an existing file: a taken name gains `-2`, `-3`, ... instead.
 * @param {string} target - absolute path from {@link resolveOutputTarget}.
 * @param {Uint8Array} bytes - encoded media.
 * @returns {Promise<string>} the path actually written.
 */
export async function writeOutputFile(target, bytes) {
  await mkdir(dirname(target), { recursive: true });
  const extension = extname(target);
  const stem = extension === '' ? target : target.slice(0, -extension.length);

  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const candidate = attempt === 1 ? target : `${stem}-${attempt}${extension}`;
    try {
      await writeFile(candidate, bytes, { flag: 'wx' });
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not find a free file name next to ${target}`);
}

/** Two-digit zero padding. */
function pad(value) {
  return String(value).padStart(2, '0');
}

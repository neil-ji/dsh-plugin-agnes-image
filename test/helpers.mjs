/**
 * Test helpers: real PNG bytes and a tiny HTTP server standing in for the
 * Agnes endpoint and its temporary image CDN, so every test exercises the
 * production fetch/parse/save path without network access or an API key.
 */

import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * Build a valid RGB PNG of the requested size.
 * @param {number} width - pixel width.
 * @param {number} height - pixel height.
 * @returns {Buffer} encoded PNG bytes.
 */
export function makePng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = 0x66;
      raw[row + 2 + x * 3] = 0x99;
      raw[row + 3 + x * 3] = 0xcc;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Start one HTTP server.
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string) => void | Promise<void>} handler
 *   request handler receiving the fully read request body.
 * @returns {Promise<{ origin: string, close: () => Promise<void>, requests: Array<{ method: string, url: string, headers: Record<string, string | string[] | undefined>, body: string }> }>}
 *   the origin, a closer, and every observed request.
 */
export async function startMockServer(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part) => { body += part; });
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      Promise.resolve(handler(request, response, body)).catch((error) => {
        response.statusCode = 500;
        response.end(String(error));
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// The review page's server. It binds to localhost only: this page can run
// every action, spend your API credits and send mail, and it has no login.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req, limit = 1_000_000) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('That was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });

/**
 * Only our own page may post actions — not some other site open in the same
 * browser. Without this, any page you visit could quietly spend your quota.
 */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || !req.headers.host) return false;
  try {
    // Both carry the port, and a browser sends the Origin of the page that
    // made the call — so comparing them is the whole check.
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createServer({ actions, store, settings, page = path.join(ROOT, 'public', 'index.html') }) {
  const port = Number(settings.PORT) || 3000;

  return http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    try {
      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(page));
      }

      if (req.method === 'GET' && url === '/api/state') {
        return json(res, 200, {
          companies: await store.all(),
          emailTo: settings.EMAIL_TO ?? null,
          reviewMode: String(settings.REVIEW_MODE ?? 'true').toLowerCase() !== 'false',
        });
      }

      if (url === '/api/action') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
        if (!isSameOrigin(req)) return json(res, 403, { error: 'Not allowed from there.' });

        const { action, ...args } = await readBody(req);
        if (!Object.hasOwn(actions, action)) return json(res, 400, { error: `No such action: ${action}` });

        const result = await actions[action](args);
        return json(res, 200, { ok: true, ...(result && typeof result === 'object' && !result.domain ? result : {}) });
      }

      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
}

export function startServer(options) {
  const port = Number(options.settings.PORT) || 3000;
  const server = createServer(options);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`Review page: http://localhost:${port}`);
      resolve(server);
    });
  });
}

// The local server: the same API as the hosted one, plus serving the page.
// It binds to localhost, because without APP_PASSWORD there is no gate.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';
import { createApi } from './api.js';

export { isSameOrigin } from './api.js';

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

const ROUTES = { '/api/state': 'state', '/api/action': 'action', '/api/login': 'login', '/api/logout': 'logout', '/api/health': 'health', '/api/selfcheck': 'selfcheck' };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/**
 * Hosted, Vercel serves public/ as static files. Locally that is this: the
 * same files, by name, and nothing outside the folder.
 */
function staticFile(dir, url) {
  const name = url === '/' ? 'index.html' : url.slice(1);
  const type = TYPES[path.extname(name)];
  if (!type || name.includes('..')) return null;

  const file = path.join(dir, name);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return null;
  return { file, type };
}

export function createServer({ actions, store, settings, page = path.join(ROOT, 'public', 'index.html') }) {
  const api = createApi({ actions, store, settings });
  const publicDir = path.dirname(page);

  return http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const send = ({ status, body, headers = {} }) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === 'GET' && !url.startsWith('/api/')) {
        const found = staticFile(publicDir, url);
        if (!found) return send({ status: 404, body: { error: 'Not found.' } });
        res.writeHead(200, { 'Content-Type': `${found.type}; charset=utf-8`, 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(found.file));
      }

      const route = ROUTES[url];
      if (!route) return send({ status: 404, body: { error: 'Not found.' } });

      const body = req.method === 'POST' ? await readBody(req) : {};
      return send(await api[route]({ method: req.method, headers: req.headers, body }));
    } catch (error) {
      return send({ status: 500, body: { error: error.message } });
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

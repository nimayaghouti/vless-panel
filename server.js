import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import https from 'node:https';
import { extname, join } from 'node:path';

const ROOT = process.cwd();
const PORT = 5173;
const PROXY_PREFIX = '/cf-proxy';
const CF_API_HOST = 'api.cloudflare.com';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function proxyToCloudflare(req, res) {
  const targetPath = req.url.slice(PROXY_PREFIX.length);
  const chunks = [];

  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;

    const upstreamReq = https.request(
      { hostname: CF_API_HOST, path: targetPath, method: req.method, headers },
      upstreamRes => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('error', err => {
      console.error('Cloudflare API proxy error:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          errors: [
            {
              message: `Could not reach Cloudflare API: ${err.code || err.message}`,
            },
          ],
        }),
      );
    });

    upstreamReq.end(body.length ? body : undefined);
  });
}

async function serveStaticFile(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = join(ROOT, decodeURIComponent(urlPath.split('?')[0]));

  try {
    const content = await readFile(filePath);
    const contentType =
      MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = createServer((req, res) => {
  if (req.url.startsWith(PROXY_PREFIX)) {
    proxyToCloudflare(req, res);
    return;
  }
  serveStaticFile(req, res);
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});

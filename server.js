import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const ROOT = process.cwd();
const PORT = 5173;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
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
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});

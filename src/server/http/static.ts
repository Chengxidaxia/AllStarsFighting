/**
 * 静态文件服务：托管 web/ 目录（零构建客户端）。
 * 支持常见 MIME；带 CORS，方便本地调试。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createStaticHandler(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  const base = resolve(root);
  return (req, res) => {
    void serve(base, req, res);
  };
}

function serveIndex(res: ServerResponse, file: string): void {
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  createReadStream(file).pipe(res);
}

async function serve(base: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    // 防目录穿越
    const target = join(base, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(base)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let st = await stat(target).catch(() => null);
    if (st?.isDirectory() === true) {
      // 目录但 URL 无尾斜杠 → 301 重定向补斜杠，确保相对资源（如 admin.js）正确解析
      if (!pathname.endsWith('/')) {
        const q = url.search ?? '';
        res.writeHead(301, { Location: pathname + '/' + q });
        res.end();
        return;
      }
      // 目录 → index.html（如 /admin/ → web/admin/index.html）
      const idx = join(target, 'index.html');
      st = await stat(idx).catch(() => null);
      if (st?.isFile() === true) return serveIndex(res, idx);
    }
    if (st === null || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    serveIndex(res, target);
  } catch {
    res.writeHead(500).end('Internal Error');
  }
}

/**
 * 静态文件服务：托管 web/ 目录（零构建客户端）。
 * 支持常见 MIME；带 CORS，方便本地调试。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

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

const ZIP_EXTS = new Set(['.zip', '.pack', '.alsfpack']);

/**
 * datapacks/ 目录服务（本地运行时的数据包来源，取代已废除的 web/pack/catalog.json）：
 *   GET /datapacks/?list=1            → 根条目 JSON {items:[{name,type:'folder'|'zip'}]}
 *   GET /datapacks/<包>/?list=1       → 文件夹包内文件清单 {files:['manifest.json',…]}
 *   GET /datapacks/<路径>             → 文件本体（zip 或 json/js；zip 由浏览器内存解包）
 */
export function createDatapacksHandler(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  const base = resolve(root);
  return (req, res) => {
    void serveDatapacks(base, req, res);
  };
}

function jsonRes(res: ServerResponse, obj: unknown): void {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

async function listDir(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of await readdirSync(join(dir, rel))) {
      const child = rel === '' ? name : rel + '/' + name;
      const st = await stat(join(dir, child)).catch(() => null);
      if (st?.isDirectory() === true) await walk(child);
      else if (st?.isFile() === true) out.push(child);
    }
  };
  await walk('');
  return out.sort();
}

async function serveDatapacks(base: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    // 防目录穿越（normalize('') 会得到 '.'，归一回空串）
    let rel = normalize(pathname.replace(/^\/datapacks\/?/, '')).replace(/^(\.\.[/\\])+/, '');
    if (rel === '.') rel = '';
    const target = join(base, rel);
    if (!target.startsWith(base)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const st = await stat(target).catch(() => null);
    // 根目录 / 文件夹 + ?list=1 → 条目/文件清单 JSON
    if (url.searchParams.get('list') === '1' && (rel === '' || st?.isDirectory() === true)) {
      let names: string[] = [];
      try {
        names = rel === '' ? readdirSync(base) : await listDir(target);
      } catch { /* 目录不存在 → 空清单 */ }
      if (rel === '') {
        const items: { name: string; type: string }[] = [];
        for (const name of names.sort()) {
          const st2 = await stat(join(base, name)).catch(() => null);
          if (st2?.isDirectory() === true) items.push({ name, type: 'folder' });
          else if (st2?.isFile() === true && ZIP_EXTS.has(extname(name).toLowerCase())) items.push({ name, type: 'zip' });
        }
        return jsonRes(res, { items });
      }
      return jsonRes(res, { files: names });
    }
    if (st === null || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(500).end('Internal Error');
  }
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

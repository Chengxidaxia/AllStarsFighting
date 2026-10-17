/**
 * 把服务端对局引擎打包成浏览器可用的 ES Module：web/js/engine.js。
 *
 * 处理：
 *  - node:vm   → web/engine/shim-vm.js（new Function，数据包可信）
 *  - node:crypto → web/engine/shim-crypto.js（crypto.getRandomValues）
 *  - ../data/store.js → web/engine/store.browser.ts（从 catalog 注入，不读 fs）
 *  - node:fs/path/url 等 → 空垫片
 *
 * esbuild 由 vitest/vite 的依赖带入；若以后移除测试依赖，请单独安装 esbuild。
 */
import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = process.cwd();
const aliasPlugin = {
  name: 'alsf-alias',
  setup(b) {
    b.onResolve({ filter: /data\/store\.js$/ }, () => ({ path: resolve(root, 'web/engine/store.browser.ts') }));
    b.onResolve({ filter: /^node:vm$/ }, () => ({ path: resolve(root, 'web/engine/shim-vm.js') }));
    b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: resolve(root, 'web/engine/shim-crypto.js') }));
    b.onResolve({ filter: /^node:(fs|path|url|os|buffer|module)$/ }, () => ({ path: resolve(root, 'web/engine/shim-empty.js') }));
  },
};

await build({
  entryPoints: [resolve(root, 'web/engine/entry.ts')],
  bundle: true,
  outfile: resolve(root, 'web/js/engine.js'),
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  plugins: [aliasPlugin],
  legalComments: 'none',
  logLevel: 'info',
});

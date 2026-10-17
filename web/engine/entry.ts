/** 浏览器引擎入口：导出 Match 与内容目录注入。由 scripts/build-web.mjs 打包为 web/js/engine.js。 */
export { Match } from '../../src/server/game/match.js';
export type { MatchOpts } from '../../src/server/game/match.js';
export { setCatalog, getCatalog } from './store.browser.js';
export type { Catalog } from './store.browser.js';

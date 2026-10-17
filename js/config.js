/*
 * 部署配置（静态客户端 + 独立 WS 服务时使用）。
 *
 * 同源部署（客户端与 WS 在同一个服务）：保持空字符串即可。
 * 分离部署（客户端在 Static Site、WS 在 Render）：填 Render 的 WebSocket 地址，例如：
 *   window.__ALSF_WS_URL = 'wss://allstarsfighting.onrender.com/ws';
 */
window.__ALSF_WS_URL = '';

/*
 * 房主权威模式（方案 1）：
 *   __ALSF_MODE = ''       → 走原来的 WS 服务端（默认）
 *   __ALSF_MODE = 'host'   → 本机浏览器当房主（跑对局引擎）
 *   __ALSF_MODE = 'guest'  → 加入房主的房间
 * 数据包从 Supabase Storage 桶加载；没配 URL/KEY 时回退本地 web/pack/catalog.json。
 */
window.__ALSF_MODE = '';
window.__ALSF_TRANSPORT = ''; // 'local' 强制 BroadcastChannel（本地调试/无 Supabase 时）
/*
 * 登录门禁（显式开启，避免本地开发被挡）：
 *   __ALSF_AUTH = 'on' 或 ?auth=on → 启用（部署版在 config.local.js 里设 'on'）；
 *   ?auth=off → 强制关闭（本地开发 / E2E / 直连 WS 服务端时用）；
 *   默认关闭：本地经合集网关（已有 hub 账号）不该被双重门禁挡着。
 */
window.__ALSF_AUTH = '';
window.__SUPABASE_URL = '';
window.__SUPABASE_ANON_KEY = '';
window.__ALSF_PACK_BUCKET = 'datapack';
/*
 * 桶根目录扫描：catalog.json（合并目录）/ 文件夹包 / .pack（zip 改名，避免 IDM 拦截 .zip）
 * 注意：IDM 会拦截 .zip 下载，桶里请用文件夹或 .pack/.alsfpack，不要用 .zip。
 */

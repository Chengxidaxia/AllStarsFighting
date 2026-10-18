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
 * 数据包来源：配了 Supabase URL/KEY → 扫 Storage 桶 datapacks 根目录；
 * 否则（本地运行）→ 读同源 datapacks/ 目录（服务端 / _static.mjs 提供列表接口）。
 * 桶/目录下每个条目 = 一个数据包：文件夹（内部放详细）或 zip（.zip/.pack/.alsfpack）；
 * zip 下载后在内存里解包，不落硬盘。
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
window.__ALSF_PACK_BUCKET = 'datapacks';
/*
 * 桶根目录扫描：文件夹包 / .zip / .pack / .alsfpack（zip 在内存解包）。
 * 注意：IDM 会拦截 .zip 下载，桶里推荐用文件夹或 .pack/.alsfpack。
 */

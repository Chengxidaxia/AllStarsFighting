/*
 * 部署配置（静态客户端 + 独立 WS 服务时使用）。
 *
 * 同源部署（客户端与 WS 在同一个服务）：保持空字符串即可。
 * 分离部署（客户端在 Static Site、WS 在 Render）：填 Render 的 WebSocket 地址，例如：
 *   window.__ALSF_WS_URL = 'wss://allstarsfighting.onrender.com/ws';
 */
window.__ALSF_WS_URL = '';

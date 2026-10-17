/**
 * ALSF 服务端入口（全冥星大坐站）。
 *
 * 组成：静态文件服务（web/）+ 游戏大厅 + WS 网关 + 1Hz housekeeping。
 * 回合制游戏**不需要**高频 tick：阶段/回合到期、掉线宽限都在 housekeeping 里推进。
 */

import './env.js'; // 先加载 .env（若存在），必须在 config.js 之前
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, PROTOCOL_VERSION } from './config.js';
import { Lobby } from './game/lobby.js';
import type { MatchOpts } from './game/match.js';
import { Gateway } from './net/gateway.js';
import { createStaticHandler } from './http/static.js';
import { handleAdminApi } from './net/admin.js';
import { log } from './util/log.js';
import { MATCH_MODES, type MatchMode } from './protocol/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web');

const server = createServer((req, res) => {
  if (req.url === '/health') {
    const gw = gateway;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      ok: true,
      game: 'alsf',
      version: PROTOCOL_VERSION,
      rooms: lobby.listInfo().length,
      players: gw?.sessionCount() ?? 0,
      online: lobby.list().reduce((n, r) => n + r.playerIds.size, 0),
    }));
    return;
  }
  staticHandler(req, res);
});

// ── 独立管理端端口：只服务 /admin/*（页面 + API），与游戏端口隔离 ──

const ADMIN_PORT = Number(process.env.ALSF_ADMIN_PORT ?? config.port + 1);
const adminServer = createServer((req, res) => {
  const p = ((req.url ?? '').split('?')[0]) ?? '';
  if (p.startsWith('/admin/api/')) {
    void handleAdminApi(req, res);
    return;
  }
  if (p === '/' || p === '/admin') {
    res.writeHead(301, { Location: '/admin/' }).end();
    return;
  }
  if (p.startsWith('/admin/')) {
    staticHandler(req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
});

const staticHandler = createStaticHandler(webRoot);

const matchOpts = (roomId: string, name: string, mode: MatchMode, hostId: string, mapId?: string): MatchOpts => ({
  roomId, name, mode, hostId, mapId,
  cfg: {
    phaseTimeoutMs: config.phaseTimeoutMs,
    turnTimeoutMs: config.turnTimeoutMs,
    handSize: config.handSize,
    healCardAmount: config.healCardAmount,
    healTileAmount: config.healTileAmount,
    moveBudget: config.moveBudget,
  },
});

const lobby = new Lobby({
  maxRooms: config.maxRooms,
  maxPlayers: config.maxPlayers,
  roomIdleMs: config.roomIdleMs,
  reconnectGraceMs: config.reconnectGraceMs,
  defaultMode: '1v1v1v1' as MatchMode,
  matchOpts,
});

const gateway = new Gateway(server, lobby, {
  protocolVersion: PROTOCOL_VERSION,
  maxNameLength: config.maxNameLength,
  maxRoomNameLength: config.maxRoomNameLength,
  maxChatLength: config.maxChatLength,
  lobbyBroadcastMs: config.lobbyBroadcastMs,
  heartbeatMs: config.heartbeatMs,
  reconnectGraceMs: config.reconnectGraceMs,
});

// 1Hz housekeeping：大厅列表 / 阶段与回合超时 / 掉线宽限 / 房间回收
setInterval(() => {
  const now = Date.now();
  lobby.step(now);
  gateway.housekeeping(now);
}, 1000).unref();

server.listen(config.port, config.host, () => {
  log.info(`ALSF 服务端已启动 → http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`);
  log.info(`协议版本 ${PROTOCOL_VERSION}；游戏大厅模式：${MATCH_MODES.join(' / ')}`);
});

adminServer.listen(ADMIN_PORT, config.host, () => {
  log.info(`管理端（无鉴权）→ http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${ADMIN_PORT}/admin/`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('收到退出信号，正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

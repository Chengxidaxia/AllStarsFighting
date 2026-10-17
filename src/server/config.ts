/**
 * 全局配置：端口 / 房间上限 / 回合规则 / 掉线宽限等。
 * 环境变量可覆盖（ALSF_ 前缀）。
 */

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly tickRate: number;
  readonly maxPlayers: number;
  readonly maxRooms: number;
  readonly maxNameLength: number;
  readonly maxRoomNameLength: number;
  /** 常驻默认房间 id。 */
  readonly defaultRoomId: string;
  /** 玩家自建房空置多久回收（ms）。 */
  readonly roomIdleMs: number;
  /** 阶段兜底超时（ms）：选英雄 / 选出生点。 */
  readonly phaseTimeoutMs: number;
  /** 回合超时（ms）。 */
  readonly turnTimeoutMs: number;
  /** 掉线宽限（ms）：超时判出局。 */
  readonly reconnectGraceMs: number;
  /** 大厅列表广播间隔（ms）。 */
  readonly lobbyBroadcastMs: number;
  /** WS 心跳间隔（ms）。 */
  readonly heartbeatMs: number;
  /** 每局起手手牌数。 */
  readonly handSize: number;
  /** 桃（回血牌）回复量。 */
  readonly healCardAmount: number;
  /** 回血点每回合回复量。 */
  readonly healTileAmount: number;
  /** 每回合可移动格数。 */
  readonly moveBudget: number;
  /** 聊天文本上限。 */
  readonly maxChatLength: number;
}

function envInt(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envStr(key: string, def: string): string {
  return process.env[key] ?? def;
}

export const config: ServerConfig = {
  // Render 等平台会注入 PORT；优先用它，其次 ALSF_PORT，最后 24710
  port: envInt('PORT', envInt('ALSF_PORT', 24710)),
  host: envStr('ALSF_HOST', '0.0.0.0'),
  tickRate: envInt('ALSF_TICK', 30),
  maxPlayers: envInt('ALSF_MAX_PLAYERS', 64),
  maxRooms: envInt('ALSF_MAX_ROOMS', 32),
  maxNameLength: 12,
  maxRoomNameLength: 16,
  defaultRoomId: 'hall',
  roomIdleMs: envInt('ALSF_ROOM_IDLE_MS', 90_000),
  // 等待房内的选择阶段兜底：玩家不选就自动分配
  phaseTimeoutMs: envInt('ALSF_PHASE_TIMEOUT_MS', 60_000),
  // 用户定案：回合超时 90 秒
  turnTimeoutMs: envInt('ALSF_TURN_TIMEOUT_MS', 90_000),
  // 掉线宽限 45s，超时判出局
  reconnectGraceMs: envInt('ALSF_RECONNECT_GRACE_MS', 45_000),
  lobbyBroadcastMs: 1000,
  heartbeatMs: 15_000,
  handSize: 3,
  healCardAmount: 4,
  healTileAmount: 1,
  moveBudget: 1,
  maxChatLength: 200,
};

export { PROTOCOL_VERSION } from './protocol/types.js';

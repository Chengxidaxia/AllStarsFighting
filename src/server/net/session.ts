/**
 * 会话：一条 WebSocket 连接 + 身份 + 所在房间。
 *
 * playerId 由服务端分配、跨房间与断线重连稳定（客户端重连时带 resumeId）。
 */

import type { WebSocket } from 'ws';
import { MSG } from '../protocol/types.js';

export class Session {
  /** 服务端分配的玩家 id（握手后即有）。 */
  playerId: string | null = null;
  name = '';
  /** 当前所在房间 id（在大厅为 null）。 */
  roomId: string | null = null;
  /** 心跳标记：收到 pong 置 true，每轮扫描后重置。 */
  alive = true;
  closed = false;

  constructor(readonly socket: WebSocket) {}

  send(t: string, d: unknown): void {
    if (this.closed) return;
    if (this.socket.readyState !== 1 /* OPEN */) return;
    this.socket.send(JSON.stringify({ t, d }));
  }

  /** 仅在本会话发送（如手牌 HAND）。 */
  privateSend(t: string, d: unknown): void {
    this.send(t, d);
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* 忽略 */
    }
  }
}

export { MSG };

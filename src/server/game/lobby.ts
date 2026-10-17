/**
 * 大厅：房间集合管理（创建 / 查询 / 回收 / 定时推进）。
 *
 * 每 1Hz 由 index.ts 调用 {@link Lobby.step}：
 *  - 推进所有房间的阶段/回合超时
 *  - 扫描掉线宽限到期的玩家并判出局
 *  - 回收空置的玩家自建房
 */

import type { RoomInfo } from '../protocol/types.js';
import { Room } from './room.js';

export class Lobby {
  private readonly rooms = new Map<string, Room>();
  private roomSeq = 0;

  constructor(
    private readonly cfg: {
      maxRooms: number;
      maxPlayers: number;
      roomIdleMs: number;
      reconnectGraceMs: number;
      defaultMode: Room['match']['opts']['mode'];
      matchOpts: (roomId: string, name: string, mode: Room['match']['opts']['mode'], hostId: string, mapId?: string) => Room['matchOpts'];
    },
  ) {
    // 不设默认房：大厅初始为空，玩家从「创建房间」开始
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  create(name: string | undefined, mode: Room['match']['opts']['mode'], hostId: string, mapId?: string): Room {
    if (this.rooms.size >= this.cfg.maxRooms) {
      throw new Error('TOO_MANY_ROOMS');
    }
    const id = `r${++this.roomSeq}`;
    const roomName = name !== undefined && name.trim() !== '' ? name.trim() : `房间 ${this.roomSeq}`;
    const room = new Room(id, roomName, false, mode, hostId,
      this.cfg.matchOpts(id, roomName, mode, hostId, mapId));
    this.rooms.set(id, room);
    return room;
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  listInfo(): RoomInfo[] {
    return this.list()
      .map((r) => r.info())
      .sort((a, b) => (b.permanent ? 1 : 0) - (a.permanent ? 1 : 0) || a.id.localeCompare(b.id));
  }

  /** 定时推进 + 回收。 */
  step(now: number): void {
    for (const room of this.rooms.values()) {
      room.match.tick(now);
      room.match.sweepDisconnected(now, this.cfg.reconnectGraceMs);
      // 把 room.playerIds 与 match.players 对齐：宽限到期被清出的玩家移出房间集合（否则房间永不空、不回收）
      let changed = false;
      for (const pid of [...room.playerIds]) {
        if (!room.match.players.has(pid)) {
          room.playerIds.delete(pid);
          changed = true;
        }
      }
      if (changed && room.playerIds.size === 0) room.lastActive = now;
      if (room.recyclable(this.cfg.roomIdleMs, now)) {
        this.rooms.delete(room.id);
      }
    }
  }
}

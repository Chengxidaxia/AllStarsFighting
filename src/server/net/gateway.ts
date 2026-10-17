/**
 * WS 网关：连接管理 + 消息路由 + 房间广播。
 *
 * 流程：JOIN（登记身份）→ WELCOME + LOBBY
 *      → CREATE_ROOM / JOIN_ROOM（进房）→ ROOM + PHASE + ...
 *      → 对局内动作全部走 {@link Gateway.syncRoom} 同步
 *
 * 断线重连：客户端重连时带 resumeId（上次的 playerId），
 * 服务端据此恢复房间席位与手牌；超过宽限未重连则判出局。
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Lobby } from '../game/lobby.js';
import type { Room } from '../game/room.js';
import { MSG, ERROR_CODE, MATCH_MODES, type MatchMode } from '../protocol/types.js';
import { Session } from './session.js';
import { log } from '../util/log.js';
import { sanitizeName } from '../util/text.js';
import { getCatalog } from '../data/store.js';

export interface GatewayCfg {
  protocolVersion: string;
  maxNameLength: number;
  maxRoomNameLength: number;
  maxChatLength: number;
  lobbyBroadcastMs: number;
  heartbeatMs: number;
  /** 掉线宽限（ms）。 */
  reconnectGraceMs: number;
}

export class Gateway {
  private readonly sessions = new Map<string, Session>();
  private seq = 0;
  private lastLobbyBroadcast = 0;
  private lastHeartbeat = 0;

  constructor(
    server: HttpServer,
    private readonly lobby: Lobby,
    private readonly cfg: GatewayCfg,
  ) {
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
      this.handleConnection(socket, req);
    });
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  // ── 连接 ──

  private handleConnection(socket: WebSocket, _req: IncomingMessage): void {
    const session = new Session(socket);
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { t?: string; d?: Record<string, unknown> };
        if (typeof msg.t !== 'string') return;
        this.handle(session, msg.t, msg.d ?? {});
      } catch {
        session.send(MSG.ERROR, { code: ERROR_CODE.BAD_MESSAGE, msg: '报文格式错误' });
      }
    });
    socket.on('close', () => this.handleClose(session));
    socket.on('error', () => this.handleClose(session));
  }

  private handleClose(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (session.playerId === null) return;
    const room = session.roomId === null ? undefined : this.lobby.get(session.roomId);
    if (room !== undefined) {
      room.match.onDisconnect(session.playerId, Date.now(), this.cfg.reconnectGraceMs);
      this.syncRoom(room);
    } else {
      // 大厅内（未进房）玩家无状态可保留，直接清理 session
      this.sessions.delete(session.playerId);
    }
    // 在房间内的玩家保留 session（resumeId 需要），由 sweep 按宽限清理
  }

  // ── 消息分发 ──

  private handle(session: Session, t: string, d: Record<string, unknown>): void {
    try {
      switch (t) {
        case MSG.JOIN: return this.onJoin(session, d);
        case MSG.PING: return session.send(MSG.PONG, { ts: d.ts, serverTime: Date.now() });
        // 服务端心跳的回应：把 alive 复位（不复位则下次扫描判定超时）
        case MSG.PONG: session.alive = true; return;
        case MSG.CREATE_ROOM: return this.onCreateRoom(session, d);
        case MSG.JOIN_ROOM: return this.onJoinRoom(session, d);
        case MSG.LEAVE_ROOM: return this.onLeaveRoom(session);
        case MSG.START_MATCH: return this.roomAction(session, (m) => m.start(session.playerId!, Date.now()));
        case MSG.CHOOSE_TEAM: return this.roomAction(session, (m) => m.setTeam(session.playerId!, Number(d.team)));
        case MSG.PICK_HERO: return this.roomAction(session, (m) => m.pickHero(session.playerId!, String(d.heroId ?? '')));
        case MSG.PICK_SPAWN: return this.roomAction(session, (m) => m.pickSpawn(session.playerId!, Number(d.spawnIndex)));
        case MSG.MOVE: return this.roomAction(session, (m) => m.move(session.playerId!, Number(d.x), Number(d.y)));
        case MSG.PLAY_CARD: return this.roomAction(session, (m) =>
          m.playCard(session.playerId!, String(d.uid ?? ''),
            d.targetId === undefined ? undefined : String(d.targetId),
            d.x === undefined ? undefined : Number(d.x),
            d.y === undefined ? undefined : Number(d.y),
            d.pick === undefined ? undefined : String(d.pick)));
        case MSG.DISCARD_CARD: return this.roomAction(session, (m) => m.discardCard(session.playerId!, String(d.uid ?? '')));
        case MSG.END_TURN: return this.roomAction(session, (m) => m.endTurn(session.playerId!));
        case MSG.UNDO_MOVE: return this.roomAction(session, (m) => m.undoMove(session.playerId!));
        case MSG.RESTART_MATCH: return this.roomAction(session, (m) => m.restart(session.playerId!));
        case MSG.CHAT: return this.onChat(session, d);
        default: return session.send(MSG.ERROR, { code: ERROR_CODE.BAD_MESSAGE, msg: '未知消息' });
      }
    } catch (err) {
      log.warn(`处理消息 ${t} 出错：${String(err)}`);
      session.send(MSG.ERROR, { code: ERROR_CODE.BAD_MESSAGE, msg: '服务端处理失败' });
    }
  }

  private onJoin(session: Session, d: Record<string, unknown>): void {
    const version = String(d.protocol ?? '');
    if (version !== this.cfg.protocolVersion) {
      session.send(MSG.ERROR, { code: ERROR_CODE.VERSION_MISMATCH, msg: `协议版本不匹配（需要 ${this.cfg.protocolVersion}）` });
      session.close();
      return;
    }
    const name = sanitizeName(d.name, '玩家', this.cfg.maxNameLength);

    // 断线重连：resumeId 命中已存在的玩家
    const resumeId = d.resumeId === undefined ? null : String(d.resumeId);
    if (resumeId !== null && this.sessions.has(resumeId)) {
      const old = this.sessions.get(resumeId)!;
      const room = old.roomId === null ? undefined : this.lobby.get(old.roomId);
      if (room !== undefined && room.match.isInMatch(resumeId)) {
        session.playerId = resumeId;
        session.name = old.name;
        session.roomId = old.roomId;
        this.sessions.set(resumeId, session);
        old.closed = true;
        // 主动断开旧连接：否则网络波动下旧 socket 可能在 onclose 触发前继续以同一 playerId 发指令
        try { old.socket.terminate(); } catch { /* 旧连接可能已关闭 */ }
        room.match.onReconnect(resumeId);
        session.send(MSG.WELCOME, { id: resumeId, protocol: this.cfg.protocolVersion, serverTime: Date.now(), maps: this.mapList() });
        log.info(`玩家 ${session.name} (${resumeId}) 重连回房间 ${room.id}`);
        this.syncRoom(room);
        return;
      }
    }

    const id = `p${++this.seq}`;
    session.playerId = id;
    session.name = name;
    this.sessions.set(id, session);
    session.send(MSG.WELCOME, { id, protocol: this.cfg.protocolVersion, serverTime: Date.now(), maps: this.mapList() });
    log.info(`玩家 ${name} (${id}) 进入游戏大厅`);
    this.broadcastLobby();
  }

  private onCreateRoom(session: Session, d: Record<string, unknown>): void {
    if (session.playerId === null) return;
    const mode = (MATCH_MODES as readonly string[]).includes(String(d.mode))
      ? (String(d.mode) as MatchMode)
      : '1v1v1v1';
    const name = sanitizeName(d.name, '', this.cfg.maxRoomNameLength);
    const mapId = d.mapId === undefined || d.mapId === '' ? undefined : String(d.mapId);
    let room: Room;
    try {
      room = this.lobby.create(name === '' ? undefined : name, mode, session.playerId, mapId);
    } catch {
      return session.send(MSG.ERROR, { code: ERROR_CODE.TOO_MANY_ROOMS, msg: '房间数量已达上限' });
    }
    this.enterRoom(session, room);
  }

  private onJoinRoom(session: Session, d: Record<string, unknown>): void {
    if (session.playerId === null) return;
    const room = this.lobby.get(String(d.roomId ?? ''));
    if (room === undefined) {
      return session.send(MSG.ERROR, { code: ERROR_CODE.ROOM_NOT_FOUND, msg: '房间不存在或已解散' });
    }
    this.enterRoom(session, room);
  }

  private onLeaveRoom(session: Session): void {
    if (session.playerId === null || session.roomId === null) return;
    const room = this.lobby.get(session.roomId);
    if (room !== undefined) {
      // 房主在对局进行中退出 → 直接结束对局（而不是简单移交房主、让对局继续）
      const wasHost = room.match.hostId === session.playerId;
      if (wasHost && room.match.phase !== 'WAITING' && room.match.phase !== 'FINISHED') {
        room.match.abort('房主退出，对局结束');
      }
      room.match.removePlayer(session.playerId);
      room.playerIds.delete(session.playerId);
      room.spectatorIds.delete(session.playerId);
      room.reassignHostIfNeeded();
      if (room.playerIds.size === 0 && room.spectatorIds.size === 0) room.lastActive = Date.now();
      this.syncRoom(room);
    }
    session.roomId = null;
    session.send(MSG.LOBBY, { rooms: this.lobby.listInfo() });
    this.broadcastLobby();
  }

  /** 进入房间：登记身份、分配座位（对局已开始时改为观战）；房主顺位移交。 */
  private enterRoom(session: Session, room: Room): void {
    const pid = session.playerId!;
    // 换房：先从旧房移除（玩家 / 观战者）
    if (session.roomId !== null && session.roomId !== room.id) {
      const old = this.lobby.get(session.roomId);
      if (old !== undefined) {
        old.match.removePlayer(pid);
        old.playerIds.delete(pid);
        old.spectatorIds.delete(pid);
        old.reassignHostIfNeeded();
        this.syncRoom(old);
      }
    }

    const alreadyPlayer = room.playerIds.has(pid);
    const alreadySpectator = room.spectatorIds.has(pid);
    if (!alreadyPlayer && !alreadySpectator) {
      // 对局已开始（非 WAITING）→ 只能观战：不占座位、不进回合序、不收手牌
      if (room.match.phase !== 'WAITING') {
        room.spectatorIds.add(pid);
        room.lastActive = Date.now();
        session.roomId = room.id;
        log.info(`玩家 ${session.name} (${pid}) 进入房间 ${room.id} 观战（${room.match.phase}，观战 ${room.spectatorIds.size} 人）`);
        this.syncRoom(room);
        this.broadcastLobby();
        return;
      }
      if (room.playerIds.size >= room.capacity) {
        return session.send(MSG.ERROR, { code: ERROR_CODE.ROOM_FULL, msg: '房间已满' });
      }
      room.playerIds.add(pid);
      room.lastActive = Date.now();
      if (room.match.hostId === '' || !room.playerIds.has(room.match.hostId)) {
        room.match.hostId = pid;
      }
      room.match.addPlayer(pid, session.name);
    }
    session.roomId = room.id;
    log.info(`玩家 ${session.name} (${pid}/${room.match.sessionIdOf(pid)}) 进入房间 ${room.id}（${room.playerIds.size}/${room.capacity}）`);
    this.syncRoom(room);
    this.broadcastLobby();
  }

  private onChat(session: Session, d: Record<string, unknown>): void {
    if (session.playerId === null || session.roomId === null) {
      return session.send(MSG.ERROR, { code: ERROR_CODE.NOT_IN_ROOM, msg: '你不在房间内' });
    }
    const room = this.lobby.get(session.roomId);
    if (room === undefined) return;
    let text = String(d.text ?? '').slice(0, this.cfg.maxChatLength).trim();
    if (text === '') return;
    const channel = d.channel === 'team' ? 'team' : 'all';
    const payload = {
      from: session.playerId, name: session.name,
      team: room.match.teamOf(session.playerId), channel, text,
    };
    if (channel === 'all') {
      this.broadcastRoom(room, MSG.CHAT, payload);
    } else {
      for (const pid of room.playerIds) {
        if (room.match.teamOf(pid) === payload.team) {
          this.sessions.get(pid)?.send(MSG.CHAT, payload);
        }
      }
    }
    // 同时进事件日志，方便回放
    room.match.events.push({
      kind: 'chat', text: `[${channel === 'team' ? '队伍' : '全体'}] ${session.name}：${text}`,
      actorId: session.playerId, at: Date.now(),
    });
    this.broadcastRoom(room, MSG.EVENT, { events: room.match.drainEvents() });
  }

  /** 房间内动作的统一包装：执行 → 同步 → 广播。 */
  private roomAction(session: Session, fn: (m: Room['match']) => { ok: boolean; code?: string; msg?: string }): void {
    if (session.playerId === null) return;
    const room = session.roomId === null ? undefined : this.lobby.get(session.roomId);
    if (room === undefined) {
      return session.send(MSG.ERROR, { code: ERROR_CODE.NOT_IN_ROOM, msg: '你不在房间内' });
    }
    const r = fn(room.match);
    if (!r.ok) {
      session.send(MSG.ERROR, { code: r.code ?? ERROR_CODE.BAD_MESSAGE, msg: r.msg ?? '操作被拒绝' });
      return;
    }
    this.syncRoom(room);
  }

  // ── 同步 / 广播 ──

  /** 把房间当前完整状态推给房间内所有人（HAND 逐会话）。 */
  syncRoom(room: Room): void {
    const m = room.match;
    this.broadcastRoom(room, MSG.ROOM, m.roomState());
    this.broadcastRoom(room, MSG.PHASE, {
      phase: m.phase,
      endsAt: m.phase === 'PLAYING' ? m.turnEndsAt : m.phaseEndsAt,
    });
    if (m.phase !== 'WAITING') {
      this.broadcastRoom(room, MSG.STATE, m.snapshot());
      const tp = m.turnPayload();
      if (tp !== null) this.broadcastRoom(room, MSG.TURN, tp);
      if (m.phase === 'HERO_SELECT') {
        this.broadcastRoom(room, MSG.HERO_OPTIONS, { heroes: m.heroOptions(), taken: m.takenHeroes(), cardList: m.cardList() });
      }
      if (m.phase === 'SPAWN_SELECT') {
        this.broadcastRoom(room, MSG.SPAWN_OPTIONS, { spawns: m.mapWire().spawns, taken: m.takenSpawns() });
      }
      // 地图：选出生点阶段就要预览，开局后随英雄一起发
      if (m.phase === 'SPAWN_SELECT' || m.phase === 'PLAYING' || m.phase === 'FINISHED') {
        this.broadcastRoom(room, MSG.MAP, { map: m.mapWire(), heroes: m.snapshot().heroes });
      }
      // 手牌只在发牌后下发（deck 建好才有意义），且仅本人可见
      if (m.deck !== null) {
        for (const pid of room.playerIds) {
          this.sessions.get(pid)?.send(MSG.HAND, { cards: m.handOf(pid) });
        }
      }
      const events = m.drainEvents();
      if (events.length > 0) this.broadcastRoom(room, MSG.EVENT, { events });
      if (m.phase === 'FINISHED') {
        this.broadcastRoom(room, MSG.RESULT, m.resultPayload());
      }
    }
  }

  broadcastRoom(room: Room, t: string, d: unknown): void {
    for (const pid of room.playerIds) this.sessions.get(pid)?.send(t, d);
    for (const pid of room.spectatorIds) this.sessions.get(pid)?.send(t, d); // 观战者同样接收房间广播
  }

  /** 可选地图列表（大厅建房用）。 */
  private mapList(): { id: string; name: string; width: number; height: number }[] {
    return getCatalog().maps.map((m) => ({ id: m.id, name: m.name, width: m.width, height: m.height }));
  }

  broadcastLobby(): void {
    const payload = { rooms: this.lobby.listInfo() };
    for (const s of this.sessions.values()) s.send(MSG.LOBBY, payload);
  }

  /** 每秒：大厅列表 + 超时推进；每 heartbeatMs：心跳扫描。 */
  housekeeping(now: number): void {
    if (now - this.lastLobbyBroadcast >= this.cfg.lobbyBroadcastMs) {
      this.lastLobbyBroadcast = now;
      this.broadcastLobby();
      // 掉线宽限扫描（服务端权威）
      for (const room of this.lobby.list()) {
        const before = room.match.snapshot();
        room.match.sweepDisconnected(now, this.cfg.reconnectGraceMs);
        const after = room.match.snapshot();
        if (JSON.stringify(before.heroes) !== JSON.stringify(after.heroes)) this.syncRoom(room);
        // 把 room.playerIds / sessions 与 match.players 对齐：宽限到期被清出的玩家移出房间集合与会话表
        const removed = [...room.playerIds].filter((pid) => !room.match.players.has(pid));
        if (removed.length > 0) {
          for (const pid of removed) {
            room.playerIds.delete(pid);
            this.sessions.delete(pid);
          }
          if (room.playerIds.size === 0) room.lastActive = now;
        }
      }
    }
    if (now - this.lastHeartbeat >= this.cfg.heartbeatMs) {
      this.lastHeartbeat = now;
      for (const [pid, s] of this.sessions) {
        if (!s.alive) {
          // 心跳超时：视为掉线，但保留玩家（宽限内可重连），绝不删 session —— 否则
          // 重连带 resumeId 时找不到旧 session，会被当成新玩家（房间满/重复）。
          const room = s.roomId === null ? undefined : this.lobby.get(s.roomId);
          if (room !== undefined) {
            room.match.onDisconnect(pid, Date.now(), this.cfg.reconnectGraceMs);
            this.syncRoom(room);
          } else {
            // 大厅内（未进房）玩家无状态可保留，直接清理
            this.sessions.delete(pid);
          }
          s.close();
          continue;
        }
        s.alive = false;
        s.send(MSG.PING, { ts: now });
      }
    }
  }
}

/**
 * 房主权威（方案 1）：房主浏览器里跑 Match，其他人通过传输层发动作。
 * 反作弊：每个成功动作广播 ACTION { seq, actor, t, d, hash }；客户端本地重放并比对 hash。
 */
import { Match } from './engine.js';
import { MSG, PROTOCOL } from './net.js';

// 超时设很大：房主模式不跑 tick，避免多端时钟差导致重放分叉（玩家手动结束回合）
const CFG = {
  phaseTimeoutMs: 24 * 3600 * 1000,
  turnTimeoutMs: 24 * 3600 * 1000,
  handSize: 3,
  healCardAmount: 4,
  healTileAmount: 1,
  moveBudget: 1,
};

/** 公开状态 hash（不含手牌、不含 endsAt/expiresIn 等时间字段）。 */
export function publicHash(m) {
  const s = m.snapshot();
  const stable = {
    phase: s.phase,
    turnNo: s.turnNo,
    currentId: s.currentId,
    heroes: s.heroes,
    deckCount: s.deckCount,
    discardCount: s.discardCount,
    placed: (s.placed ?? []).map((o) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, ownerTeam: o.ownerTeam })),
    topDiscard: s.topDiscard ?? null,
  };
  const json = JSON.stringify(stable);
  let h = 2166136261;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** 与房主完全一致的动作分发（客户端重放用）。 */
export function applyAction(m, actor, t, d) {
  d = d ?? {};
  switch (t) {
    case MSG.PICK_HERO: return m.pickHero(actor, d.heroId);
    case MSG.PICK_SPAWN: return m.pickSpawn(actor, d.spawnIndex);
    case MSG.MOVE: return m.move(actor, d.x, d.y);
    case MSG.PLAY_CARD: return m.playCard(actor, d.uid, d.targetId, d.x, d.y, d.pickId);
    case MSG.DISCARD_CARD: return m.discardCard(actor, d.uid);
    case MSG.END_TURN: return m.endTurn(actor);
    case MSG.UNDO_MOVE: return m.undoMove(actor);
    default: return { ok: false, code: 'BAD_MESSAGE', msg: '未知动作' };
  }
}

export function createHost({ roomId, name, mode, mapId, hostName, catalog, emit }) {
  const hostId = 'h1';
  const opts = {
    roomId, name, mode, hostId, mapId,
    seed: (Math.random() * 0xffffffff) >>> 0,
    cfg: CFG,
  };
  let match = new Match(opts);
  match.addPlayer(hostId, hostName);
  const names = new Map([[hostId, hostName]]);
  const guests = new Map();
  let guestSeq = 0;
  let actionSeq = 0;

  const mapList = catalog.maps.map((m) => ({ id: m.id, name: m.name, width: m.width, height: m.height }));

  function roomInfo() {
    const rs = match.roomState();
    return {
      id: rs.roomId,
      name: rs.name,
      mode: rs.mode,
      players: rs.players.length,
      spectators: 0,
      capacity: rs.capacity,
      phase: rs.phase,
      permanent: false,
      hostName: names.get(hostId) ?? hostName,
      mapName: match.mapDef.name,
    };
  }

  function broadcastLobby() {
    emit(MSG.LOBBY, { rooms: [roomInfo()] });
  }

  function welcome(id) {
    emit(MSG.WELCOME, { id, protocol: PROTOCOL, serverTime: Date.now(), maps: mapList }, id);
  }

  function assignGuest(guestName) {
    const id = 'g' + (++guestSeq);
    guests.set(id, guestName);
    names.set(id, guestName);
    return id;
  }

  function joinRoom(id) {
    if (id === hostId) { sync(); return; }
    if (!guests.has(id)) return;
    if (match.players.has(id)) { sync(); return; }
    if (match.players.size >= match.roomState().capacity) {
      emit(MSG.ERROR, { code: 'ROOM_FULL', msg: '房间已满' }, id);
      return;
    }
    match.addPlayer(id, guests.get(id));
    sync();
  }

  function sync() {
    const m = match;
    emit(MSG.ROOM, m.roomState());
    emit(MSG.PHASE, { phase: m.phase, endsAt: m.phase === 'PLAYING' ? m.turnEndsAt : m.phaseEndsAt });
    if (m.phase !== 'WAITING') {
      emit(MSG.STATE, m.snapshot());
      const tp = m.turnPayload();
      if (tp !== null) emit(MSG.TURN, tp);
      if (m.phase === 'HERO_SELECT') {
        emit(MSG.HERO_OPTIONS, { heroes: m.heroOptions(), taken: m.takenHeroes(), cardList: m.cardList() });
      }
      if (m.phase === 'SPAWN_SELECT') {
        emit(MSG.SPAWN_OPTIONS, { spawns: m.mapWire().spawns, taken: m.takenSpawns() });
      }
      if (m.phase === 'SPAWN_SELECT' || m.phase === 'PLAYING' || m.phase === 'FINISHED') {
        emit(MSG.MAP, { map: m.mapWire(), heroes: m.snapshot().heroes });
      }
      if (m.deck !== null) {
        for (const id of match.players.keys()) emit(MSG.HAND, { cards: m.handOf(id) }, id);
      }
      const events = m.drainEvents();
      if (events.length > 0) emit(MSG.EVENT, { events });
      if (m.phase === 'FINISHED') emit(MSG.RESULT, m.resultPayload());
    }
    broadcastLobby();
  }

  function initMessage() {
    emit('MATCH_INIT', {
      opts: match.opts,
      players: [...match.players.values()].map((p) => ({ id: p.id, name: p.name })),
      hostId,
      now: Date.now(),
    });
  }

  function action(actor, t, d) {
    d = d ?? {};
    if (t === MSG.JOIN_ROOM) { joinRoom(actor); return; }
    if (t === MSG.CREATE_ROOM) {
      // 房主在大厅「创建房间」：换名/模式/地图重建（仅限房里只有房主本人时）
      if (actor !== hostId) return;
      if (match.players.size > 1) {
        emit(MSG.ERROR, { code: 'ROOM_BUSY', msg: '房间里还有其他人，不能重建' }, actor);
        return;
      }
      const nm = String(d.name ?? '').trim().slice(0, 16) || `本地房 ${roomId}`;
      const md = String(d.mode ?? mode);
      const mp = String(d.mapId ?? mapId);
      try {
        match = new Match({ roomId, name: nm, mode: md, hostId, mapId: mp, seed: (Math.random() * 0xffffffff) >>> 0, cfg: CFG });
      } catch (err) {
        emit(MSG.ERROR, { code: 'BAD_ROOM', msg: '房间参数无效：' + String(err) }, actor);
        return;
      }
      match.addPlayer(hostId, hostName);
      names.clear();
      names.set(hostId, hostName);
      guests.clear();
      actionSeq = 0;
      initMessage();
      sync();
      return;
    }
    if (t === MSG.LEAVE_ROOM) {
      if (actor !== hostId && match.players.has(actor)) {
        match.removePlayer(actor);
        guests.delete(actor);
        names.delete(actor);
        sync();
      }
      return;
    }
    if (t === MSG.CHAT) {
      const text = String(d.text ?? '').slice(0, 200).trim();
      if (text === '') return;
      const channel = d.channel === 'team' ? 'team' : 'all';
      const payload = { from: actor, name: names.get(actor) ?? actor, team: match.teamOf(actor), channel, text };
      if (channel === 'all') {
        emit(MSG.CHAT, payload);
      } else {
        for (const pid of match.players.keys()) {
          if (match.teamOf(pid) === payload.team) emit(MSG.CHAT, payload, pid);
        }
      }
      return;
    }
    if (t === MSG.PING) { emit(MSG.PONG, { ts: d.ts }, actor); return; }
    if (t === MSG.START_MATCH || t === MSG.RESTART_MATCH) {
      const r = t === MSG.START_MATCH ? match.start(hostId, Date.now()) : match.restart(hostId, Date.now());
      if (!r.ok) { emit(MSG.ERROR, { code: r.code, msg: r.msg }, actor); return; }
      initMessage();
      sync();
      return;
    }
    const r = applyAction(match, actor, t, d);
    if (!r.ok) { emit(MSG.ERROR, { code: r.code, msg: r.msg }, actor); return; }
    actionSeq++;
    emit('ACTION', { seq: actionSeq, actor, t, d, hash: publicHash(match) });
    sync();
  }

  // 房主模式不跑 tick：超时设很大，避免多端时钟差导致重放分叉
  return { get match() { return match; }, hostId, names, guests, welcome, assignGuest, joinRoom, action, sync, broadcastLobby, roomInfo, hostName };
}

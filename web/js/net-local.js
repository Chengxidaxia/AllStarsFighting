/**
 * 房主权威模式的网络层：与 Net 同接口（on/send/connect/hello/close/name/playerId）。
 *  - host：本机持 Match，其他人的动作经传输层进来；
 *  - guest：动作发给房主，收到房主的状态/手牌；同时本地重放动作做反作弊校验。
 */
import { MSG, PROTOCOL } from './net.js';
import { Match, setCatalog } from './engine.js';
import { loadCatalog } from '../engine/pack.js';
import { createHost, applyAction, publicHash } from './host.js';
import { createTransport } from './transport.js';

const ACTION_MSGS = new Set([
  MSG.PICK_HERO, MSG.PICK_SPAWN, MSG.MOVE, MSG.PLAY_CARD,
  MSG.DISCARD_CARD, MSG.END_TURN, MSG.UNDO_MOVE,
]);

export function createLocalNet(mode) {
  const params = new URLSearchParams(location.search);
  // host 没带 ?room 时生成随机房号：部署后多人同时开站不会撞同一个 Realtime 频道
  // 但**不再开局自动建房**：只有显式 ?room=<房号>（旧链接 / E2E）才进页即建；
  // 普通进入先落大厅，用户点「创建并进入」才建房（createRoomNow）。
  const presetRoom = params.get('room') || window.__ALSF_ROOM || '';
  const autoHost = mode === 'host' && presetRoom !== '';
  const roomId = (autoHost ? presetRoom : mode === 'host' ? '' : (presetRoom || 'default')).slice(0, 48);
  const gameMode = params.get('game') || '1v1v1v1';
  const mapId = params.get('map') || 'plaza';

  const net = {
    name: '',
    playerId: null,
    roomId: null,
    wantReconnect: false,
    handlers: new Map(),
    on(t, fn) {
      const list = this.handlers.get(t) ?? [];
      list.push(fn);
      this.handlers.set(t, list);
      return this;
    },
    emit(t, d) {
      for (const fn of this.handlers.get(t) ?? []) fn(d);
    },
    connect(name) {
      this.name = name;
      void init(name);
    },
    hello() {},
    send() {},
    close() {},
  };

  let host = null;
  let transport = null;
  let replica = null;
  let catalogCache = null;   // 建房用（loadCatalog 的结果）
  let creating = false;      // 防「创建房间」重复点击
  const sent = new Set();
  let cidSeq = 0;
  let flagged = false;

  function flag(msg) {
    if (flagged) return;
    flagged = true;
    net.emit('ANTICHEAT', { msg });
  }

  async function init(name) {
    try {
      const localOnly = window.__ALSF_TRANSPORT === 'local' || params.get('transport') === 'local';
      try {
        catalogCache = await loadCatalog(localOnly ? {} : {
          url: window.__SUPABASE_URL,
          anonKey: window.__SUPABASE_ANON_KEY,
          bucket: window.__ALSF_PACK_BUCKET,
        });
      } catch (err) {
        console.warn('[net-local] 存储桶数据包加载失败，回退本地：' + String(err));
        catalogCache = await loadCatalog({});
      }
      setCatalog(catalogCache);
      if (mode === 'host' && !autoHost) {
        // 房主待命：不自动建房。WELCOME（含地图列表）由 hello() 发，大厅建房表单用它
        net.emit('_open', {});
        return;
      }
      if (mode === 'host') {
        transport = await createTransport(roomId, onHostMessage);
        host = createHost({
          roomId,
          name: `本地房 ${roomId}`,
          mode: gameMode,
          mapId,
          hostName: name,
          catalog: catalogCache,
          emit: hostEmit,
        });
        net.playerId = host.hostId;
        net.roomId = roomId;
        net.emit('_open', {});
      } else {
        transport = await createTransport(roomId, onGuestMessage);
        net.roomId = roomId;
        net.emit('_open', {});
      }
    } catch (err) {
      net.emit(MSG.ERROR, { code: 'LOCAL_INIT', msg: '初始化失败：' + String(err) });
    }
  }

  /** 房主在大厅点「创建并进入」：建传输层 + 建 Match，然后 WELCOME + ROOM 进房。 */
  async function createRoomNow(d) {
    if (host !== null) { host.action(host.hostId, MSG.CREATE_ROOM, d ?? {}); return; }
    if (creating) return;
    creating = true;
    try {
      const rid = (presetRoom || 'r' + Math.random().toString(36).slice(2, 8)).slice(0, 48);
      transport = await createTransport(rid, onHostMessage);
      host = createHost({
        roomId: rid,
        name: String(d.name ?? '').trim().slice(0, 16) || '我的房间',
        mode: String(d.mode ?? gameMode),
        mapId: String(d.mapId ?? mapId),
        hostName: net.name,
        catalog: catalogCache,
        emit: hostEmit,
      });
      net.playerId = host.hostId;
      net.roomId = rid;
      host.welcome(host.hostId); // S.me（地图列表已在 hello 时发过）
      host.sync();               // ROOM + PHASE + LOBBY → 客户端进入房间屏
    } catch (err) {
      net.emit(MSG.ERROR, { code: 'LOCAL_INIT', msg: '创建房间失败：' + String(err) });
    } finally {
      creating = false;
    }
  }

  function hostEmit(t, d, to) {
    if (to === undefined || to === net.playerId) net.emit(t, d);
    if (transport === null || host === null) return;
    if (to === undefined) transport.send({ from: host.hostId, t, d });
    else if (to !== host.hostId) transport.send({ from: host.hostId, to, t, d });
  }

  function onHostMessage(msg) {
    if (host === null || msg === null || typeof msg !== 'object') return;
    if (msg.t === MSG.JOIN) {
      const id = host.assignGuest(String(msg.d?.name ?? '玩家'));
      host.welcome(id);
      host.broadcastLobby();
      return;
    }
    if (msg.from === undefined || msg.from === null) return;
    host.action(msg.from, msg.t, msg.d);
  }

  function onGuestMessage(msg) {
    if (msg === null || typeof msg !== 'object') return;
    if (msg.t === MSG.WELCOME) {
      net.playerId = msg.d.id;
      net.emit(msg.t, msg.d);
      return;
    }
    if (msg.to !== undefined && msg.to !== net.playerId) return;
    if (msg.t === 'MATCH_INIT') initReplica(msg.d);
    else if (msg.t === 'ACTION') verifyAction(msg.d);
    else if (msg.t === MSG.HAND) verifyHand(msg.d);
    net.emit(msg.t, msg.d);
  }

  function initReplica(d) {
    try {
      replica = new Match(d.opts);
      for (const p of d.players) replica.addPlayer(p.id, p.name);
      replica.start(d.hostId, d.now);
    } catch (err) {
      flag('重放初始化失败：' + String(err));
    }
  }

  function verifyAction(d) {
    if (replica === null) return;
    if (d.actor === net.playerId && !sent.has(d.d?.__cid)) flag('有人冒用你的身份操作');
    const r = applyAction(replica, d.actor, d.t, d.d);
    if (!r.ok) {
      flag('重放动作失败：' + (r.msg ?? r.code));
      return;
    }
    const h = publicHash(replica);
    if (h !== d.hash) flag(`房主状态与重放不一致（${h} ≠ ${d.hash}）`);
  }

  function verifyHand(d) {
    if (replica === null || net.playerId === null) return;
    const mine = replica.handOf(net.playerId).map((c) => c.uid).join(',');
    const got = (d.cards ?? []).map((c) => c.uid).join(',');
    if (mine !== got) flag('手牌与重放不一致');
  }

  net.hello = () => {
    if (mode === 'host') {
      if (host !== null) {
        host.welcome(host.hostId);
        host.broadcastLobby();
        return;
      }
      // 未建房：只发 WELCOME（带地图列表，供大厅「创建房间」表单用），不进任何房间
      net.playerId = 'h1';
      net.emit(MSG.WELCOME, {
        id: 'h1',
        protocol: PROTOCOL,
        serverTime: Date.now(),
        maps: (catalogCache?.maps ?? []).map((m) => ({ id: m.id, name: m.name, width: m.width, height: m.height })),
      });
    } else if (transport !== null) {
      transport.send({ from: null, t: MSG.JOIN, d: { name: net.name, protocol: PROTOCOL } });
    }
  };

  net.send = (t, d) => {
    if (mode === 'host') {
      if (host !== null) { host.action(host.hostId, t, d ?? {}); return; }
      // 未建房：只接受「创建房间」，其余动作忽略（还没房可操作）
      if (t === MSG.CREATE_ROOM) { void createRoomNow(d ?? {}); return; }
      return;
    }
    if (transport === null) return;
    let payload = d ?? {};
    if (ACTION_MSGS.has(t)) {
      const cid = 'c' + (++cidSeq);
      sent.add(cid);
      payload = { ...payload, __cid: cid };
    }
    transport.send({ from: net.playerId, t, d: payload });
  };

  net.close = () => {
    if (transport !== null) transport.close();
  };

  return net;
}

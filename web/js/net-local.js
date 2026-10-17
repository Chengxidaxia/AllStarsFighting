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
  const fallbackRoom = mode === 'host' ? 'r' + Math.random().toString(36).slice(2, 8) : 'default';
  const roomId = (params.get('room') || window.__ALSF_ROOM || fallbackRoom).slice(0, 48);
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
      let catalog;
      try {
        catalog = await loadCatalog(localOnly ? {} : {
          url: window.__SUPABASE_URL,
          anonKey: window.__SUPABASE_ANON_KEY,
          bucket: window.__ALSF_PACK_BUCKET,
        });
      } catch (err) {
        console.warn('[net-local] 存储桶数据包加载失败，回退本地：' + String(err));
        catalog = await loadCatalog({});
      }
      setCatalog(catalog);
      if (mode === 'host') {
        transport = await createTransport(roomId, onHostMessage);
        host = createHost({
          roomId,
          name: `本地房 ${roomId}`,
          mode: gameMode,
          mapId,
          hostName: name,
          catalog,
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
      if (host === null) return;
      host.welcome(host.hostId);
      host.broadcastLobby();
    } else if (transport !== null) {
      transport.send({ from: null, t: MSG.JOIN, d: { name: net.name, protocol: PROTOCOL } });
    }
  };

  net.send = (t, d) => {
    if (mode === 'host') {
      if (host !== null) host.action(host.hostId, t, d ?? {});
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

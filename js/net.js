/*
 * ALSF 网络层：WebSocket 客户端 + 协议常量（与 src/server/protocol/types.ts 同步）。
 *
 * 信封格式：{ t, d }；断线自动重连（带 resumeId 恢复席位）。
 */

export const PROTOCOL = '0.2.0';

export const MSG = {
  JOIN: 'JOIN', PING: 'PING',
  CREATE_ROOM: 'CREATE_ROOM', JOIN_ROOM: 'JOIN_ROOM', LEAVE_ROOM: 'LEAVE_ROOM',
  START_MATCH: 'START_MATCH', CHOOSE_TEAM: 'CHOOSE_TEAM',
  PICK_HERO: 'PICK_HERO', PICK_SPAWN: 'PICK_SPAWN',
  MOVE: 'MOVE', PLAY_CARD: 'PLAY_CARD', DISCARD_CARD: 'DISCARD_CARD', END_TURN: 'END_TURN', UNDO_MOVE: 'UNDO_MOVE',
  CHAT: 'CHAT', RESTART_MATCH: 'RESTART_MATCH',
  WELCOME: 'WELCOME', LOBBY: 'LOBBY', ROOM: 'ROOM', PHASE: 'PHASE',
  HERO_OPTIONS: 'HERO_OPTIONS', SPAWN_OPTIONS: 'SPAWN_OPTIONS',
  MAP: 'MAP', TURN: 'TURN', HAND: 'HAND', STATE: 'STATE', EVENT: 'EVENT',
  RESULT: 'RESULT', PONG: 'PONG', ERROR: 'ERROR',
};

export const MODES = ['1v1', '1v1v1v1', '2v2', '3v3', '4v4', '2v2v2v2'];

export const TEAM_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b'];

/** 地形字符 → 显示名。 */
export const TERRAIN_NAME = { '.': '平原', '~': '水', '#': '墙', S: '出生点', H: '回血点' };

export class Net {
  constructor(url) {
    this.url = url;
    this.sock = null;
    this.connected = false;
    this.handlers = new Map();
    this.name = '';
    this.playerId = null;
    this.roomId = null;
    this.wantReconnect = false;
    this.reconnectTimer = 0;
  }

  on(t, fn) {
    const list = this.handlers.get(t) ?? [];
    list.push(fn);
    this.handlers.set(t, list);
    return this;
  }

  emit(t, d) {
    for (const fn of this.handlers.get(t) ?? []) fn(d);
  }

  connect(name) {
    this.name = name;
    this.wantReconnect = true;
    this.open();
  }

  open() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    // 支持挂在子路径下（根服务端 /alsf/ 时，WS 走 /alsf/ws）。
    // 先去掉 index.html 之类文件名，再去掉末尾斜杠——这样 /alsf、/alsf/、/alsf/index.html 都得到 /alsf。
    const base = location.pathname
      .replace(/\/[^/]*\.[^/]*$/, '')
      .replace(/\/+$/, '');
    // 静态客户端 + 独立 WS 服务：js/config.js 里设置 window.__ALSF_WS_URL（如 wss://xxx.onrender.com/ws）
    const explicit = typeof window !== 'undefined' && typeof window.__ALSF_WS_URL === 'string'
      ? window.__ALSF_WS_URL.trim()
      : '';
    const url = explicit !== '' ? explicit : `${proto}${location.host}${base}${this.url}`;
    const sock = new WebSocket(url);
    this.sock = sock;
    sock.onopen = () => {
      this.connected = true;
      this.emit('_open', {});
    };
    sock.onclose = () => {
      this.connected = false;
      this.emit('_close', {});
      if (this.wantReconnect) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.open(), 2000);
      }
    };
    sock.onerror = () => { /* onclose 会跟进 */ };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.emit(msg.t, msg.d ?? {});
      this.emit('*', msg);
    };
  }

  send(t, d) {
    if (this.sock !== null && this.sock.readyState === 1) {
      this.sock.send(JSON.stringify({ t, d }));
    }
  }

  /** 握手（首次或重连）。 */
  hello() {
    this.send(MSG.JOIN, {
      name: this.name,
      protocol: PROTOCOL,
      ...(this.playerId !== null ? { resumeId: this.playerId } : {}),
    });
  }

  close() {
    this.wantReconnect = false;
    clearTimeout(this.reconnectTimer);
    if (this.sock !== null) this.sock.close();
  }
}

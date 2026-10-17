/**
 * 房间 = 一局对局（Match）+ 成员集合 + 生命周期。
 *
 * - 全部为玩家自建房：人走空后 `roomIdleMs` 回收。
 */

import type { MatchMode, RoomInfo } from '../protocol/types.js';
import { modeShape } from '../protocol/types.js';
import { Match, type MatchOpts } from './match.js';

export class Room {
  readonly match: Match;
  readonly playerIds = new Set<string>();
  /** 观战者（对局开始后加入，不占座位、不进回合序、不收手牌）。 */
  readonly spectatorIds = new Set<string>();
  readonly permanent: boolean;
  /** 房间人数上限 = 模式要求的队伍数 × 每队人数。 */
  readonly capacity: number;
  lastActive = Date.now();

  constructor(
    readonly id: string,
    name: string,
    permanent: boolean,
    mode: MatchMode,
    hostId: string,
    readonly matchOpts: MatchOpts,
  ) {
    this.permanent = permanent;
    const shape = modeShape(mode);
    this.capacity = shape.teams * shape.perTeam;
    this.match = new Match(matchOpts);
  }

  info(): RoomInfo {
    return {
      id: this.id,
      name: this.match.opts.name,
      mode: this.match.opts.mode,
      players: this.playerIds.size,
      spectators: this.spectatorIds.size,
      capacity: this.capacity,
      phase: this.match.phase,
      permanent: this.permanent,
      hostName: this.match.players.get(this.match.hostId)?.name ?? '—',
      mapName: this.match.mapDef.name,
    };
  }

  /** 房主顺位移交给房间内最早加入的成员。 */
  reassignHostIfNeeded(): void {
    if (this.match.players.has(this.match.hostId)) return;
    const next = [...this.match.players.values()].sort((a, b) => a.seat - b.seat)[0];
    this.match.hostId = next?.id ?? '';
  }

  /** 空置且非常驻 → 可回收。 */
  recyclable(idleMs: number, now: number): boolean {
    if (this.permanent) return false;
    if (this.playerIds.size > 0 || this.spectatorIds.size > 0) return false;
    return now - this.lastActive >= idleMs;
  }
}

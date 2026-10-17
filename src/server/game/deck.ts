/**
 * 共享牌堆（全局限一副，所有玩家共用）。
 *
 * 规则（用户定案）：
 *  - 开局洗一次牌；**不预先分发**，等待房人齐、进入发牌阶段才各发 3 张。
 *  - 打出的牌进弃牌堆；主牌堆抽空 → 弃牌堆洗回成新主牌堆（记 reshuffles）。
 *  - 每张实体牌有唯一 uid，服务端权威（种子不下发，防预测）。
 */

import type { Rng } from './rng.js';

export interface CardInstance {
  uid: string;
  cardId: string;
}

export class SharedDeck {
  /** 主牌堆；用 head 指针抽牌，避免 shift() 的 O(N) 搬移。 */
  private main: CardInstance[] = [];
  private discardPile: CardInstance[] = [];
  /** 下一张要抽的下标；main[0..head-1] 是已抽过的历史槽位。 */
  private head = 0;
  private uidSeq = 0;

  constructor(
    /** 每种牌的卡定义 id → 张数。 */
    private readonly counts: ReadonlyMap<string, number>,
    private readonly rng: Rng,
  ) {
    this.build();
    this.rng.shuffle(this.main);
  }

  /** 不进牌堆、直接生成一张实体牌（数据包「自选一张牌」用）。 */
  spawn(cardId: string): CardInstance | null {
    if (!this.counts.has(cardId)) return null;
    return { uid: `c${++this.uidSeq}`, cardId };
  }

  private build(): void {
    this.main = [];
    this.head = 0;
    for (const [cardId, count] of this.counts) {
      for (let i = 0; i < count; i++) {
        this.main.push({ uid: `c${++this.uidSeq}`, cardId });
      }
    }
  }

  get remaining(): number {
    return this.main.length - this.head;
  }

  get discarded(): number {
    return this.discardPile.length;
  }

  /** 弃牌堆顶（最近打出 / 弃掉的那张）；没有则 null。 */
  get topDiscard(): CardInstance | null {
    return this.discardPile[this.discardPile.length - 1] ?? null;
  }

  /** 重洗次数（抽空后洗回弃牌堆）。 */
  reshuffles = 0;

  /** 抽一张；主牌堆空则把弃牌堆洗回。返回 null 表示全局无牌。 */
  draw(): CardInstance | null {
    if (this.head >= this.main.length) {
      if (this.discardPile.length === 0) return null;
      this.main = this.discardPile;
      this.discardPile = [];
      this.head = 0;
      this.rng.shuffle(this.main);
      this.reshuffles++;
    }
    return this.main[this.head++] ?? null;
  }

  /** 弃一张进弃牌堆。 */
  discard(card: CardInstance): void {
    this.discardPile.push(card);
  }

  /** 把牌塞回主牌堆顶（偷牌失败回退等场景）。 */
  pushMain(card: CardInstance): void {
    // 复用已抽过的空槽（O(1)）；head 为 0 时才需要 unshift。
    if (this.head > 0) {
      this.main[--this.head] = card;
    } else {
      this.main.unshift(card);
    }
  }
}

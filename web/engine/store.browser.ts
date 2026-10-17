/**
 * 浏览器版内容目录（替代 src/server/data/store.ts 的 fs/zip 加载）。
 * 数据包由 pack.js 从 Supabase 存储桶 datapacks（或本地 /datapacks/ 目录）读取后注入。
 */
import type { CardDef } from '../../src/server/protocol/types.js';
import type { HeroDef } from '../../src/server/game/heroes.js';
import type { MapDef } from '../../src/server/game/grid.js';

export interface Catalog {
  maps: MapDef[];
  heroes: HeroDef[];
  cards: CardDef[];
}

let catalog: Catalog = { maps: [], heroes: [], cards: [] };

export function setCatalog(next: Catalog): void {
  catalog = next;
}

export function getCatalog(): Catalog {
  return catalog;
}

export function heroById(id: string): HeroDef | undefined {
  return catalog.heroes.find((h) => h.id === id);
}

export function mapById(id: string): MapDef | undefined {
  return catalog.maps.find((m) => m.id === id);
}

export function cardById(id: string): CardDef | undefined {
  return catalog.cards.find((c) => c.id === id);
}

export function allCards(): readonly CardDef[] {
  return catalog.cards;
}

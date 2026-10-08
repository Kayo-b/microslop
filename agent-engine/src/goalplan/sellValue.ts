/**
 * Where an item is worth more: the Grand Exchange (our offers go in at 70% of the guide price so they
 * fill at once, minus the 2% tax) or an NPC (a general store pays about 40% of the item's store value,
 * High Alchemy 60%). Selling anywhere but the best exit loses coins.
 */
export const GE_QUICK_SELL = 0.7;
export const GE_TAX = 0.02;
export const SHOP_RATE = 0.4;
export const ALCH_RATE = 0.6;

export interface SellValue {
  /** Coins per item from a quick Grand Exchange sale after tax; null without a price. */
  ge: number | null;
  /** Coins per item at a general store. */
  shop: number | null;
  /** Coins per item from High Alchemy (needs Magic 55, a nature rune and 5 fire runes' worth of time). */
  alch: number | null;
  best: 'ge' | 'shop' | 'alch' | 'unknown';
}

export function sellValue(guidePrice: number | null, storeValue: number | null): SellValue {
  const offer = guidePrice === null ? null : Math.floor(guidePrice * GE_QUICK_SELL);
  // The tax is rounded down per item and does not apply below 50 gp.
  const ge = offer === null ? null : offer - (offer >= 50 ? Math.min(Math.floor(offer * GE_TAX), 5_000_000) : 0);
  const shop = storeValue === null ? null : Math.floor(storeValue * SHOP_RATE);
  const alch = storeValue === null ? null : Math.floor(storeValue * ALCH_RATE);
  // Alchemy is a different activity (and costs a rune): only the shop competes with a plain sale.
  const best = ge === null && shop === null ? 'unknown' : (ge ?? -1) >= (shop ?? -1) ? 'ge' : 'shop';
  return { ge, shop, alch, best };
}

/** True when selling on the Grand Exchange would lose coins against a general store. */
export function geLosesToShop(v: SellValue): boolean {
  return v.best === 'shop';
}

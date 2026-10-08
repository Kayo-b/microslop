/**
 * Dropping items on the floor loses them (potions, herbs, ore, logs all have value). Runs bank what
 * they carry; only worthless leftovers may be dropped.
 */
const WORTHLESS = [/^burnt /i, /^ashes$/i, /^(bronze|iron) (dagger|mace|scimitar|sword|axe|pickaxe)$/i, /^goblin mail$/i, /^empty (jug|pot|vial)$/i, /^(jug|pot|vial)$/i, /^bones$/i, /^(cabbage|egg|bucket of slime)$/i];

export function isDroppable(name: string): boolean {
  return WORTHLESS.some((re) => re.test(name));
}

/** Crafting and skilling materials a fresh quest/LLM activity should not start by carrying around. */
const MATERIALS = [/potion/i, /\(unf\)$/i, /^grimy /i, / ore$/i, /^coal$/i, / bar$/i, / logs$/i, /^logs$/i, /^raw /i, /^uncut /i, /hide$/i, /^leather$/i];

export function isMaterial(name: string): boolean {
  return MATERIALS.some((re) => re.test(name));
}

// Cross-type FUSION: merging two DIFFERENT Trinklings makes a NEW pet with a unique, balanced ability
// (both parents' effects at ~75%), tier = the higher of the two, stats blended into that tier's band, and
// the LOWER of the two levels (per spec). Deterministic & $0 — no per-pair authoring, no per-pair art
// (the client composites the two parents). Works recursively for merges-of-merges (a parent may be fused).
import { CREATURE_BY_ID, CONFIG } from './data/creatures.js';

const BAND = { 1: 4, 2: 6, 3: 8, 4: 10, 5: 14, 6: 18 };   // T5/T6 raised to match the steepened base-stat curve
const BATTLE_TRIGS = ['onStartBattle','onKill','onHurt','onFaint','onFriendFaints','onBeforeAttack','onAfterAttack','onFriendSummoned','onFirstBlood','onLowHealth','everyOtherRound'];
const clampN = (n) => Math.max(1, Math.round(n));

// Does an effect tree contain a summon anywhere? A fused faint-trigger that summons must be limited.
function hasSummon(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.type === 'summon') return true;
  if (Array.isArray(e.effects) && e.effects.some(hasSummon)) return true;
  return hasSummon(e.then) || hasSummon(e.else);
}

// Read a unit's design meta whether it's a base creature or itself a fusion.
function meta(u) {
  if (u.fused) return { tier: u.fused.tier, faction: u.fused.faction, world: u.fused.world, name: u.name, ability: u.fused.ability, art: u.fused.artParents[0] };
  const d = CREATURE_BY_ID[u.defId] || {};
  return { tier: d.tier || 1, faction: d.faction, world: d.world, name: d.name || u.name, ability: d.ability, art: u.defId };
}
function toBattle(e) {
  if (!e || e.type === 'none') return { type: 'none' };
  const c = JSON.parse(JSON.stringify(e));
  if (c.type === 'gold') return { type: 'buff', target: 'self', atk: Math.max(1, c.amount || 1), hp: 0, mode: 'battle' };
  if (c.type === 'buff' && (c.mode === 'perm' || c.mode === 'keep')) c.mode = 'battle';
  if (c.type === 'multi' || c.type === 'randomEffect') c.effects = c.effects.map(toBattle);
  if (c.type === 'chance') { c.then = toBattle(c.then); c.else = toBattle(c.else); }
  return c;
}
function scale(e, f) {
  if (!e || e.type === 'none') return e;
  const c = JSON.parse(JSON.stringify(e));
  const mul = (v) => (v < 0 ? -clampN(-v * f) : clampN(v * f));
  if (c.type === 'buff' || c.type === 'steal') { if (c.atk) c.atk = mul(c.atk); if (c.hp) c.hp = mul(c.hp); }
  else if (c.type === 'shield') { if (c.amount != null) c.amount = clampN(c.amount * f); }
  else if (c.type === 'damage') { if (c.amount !== 'selfAtk' && typeof c.amount === 'number') c.amount = clampN(c.amount * f); }
  else if (c.type === 'multi' || c.type === 'randomEffect') c.effects = c.effects.map((x) => scale(x, f));
  else if (c.type === 'chance') { c.then = scale(c.then, f); c.else = scale(c.else, f); }
  return c;
}
const TGT = { self: 'itself', allFriends: 'all friends', friendBehind: 'the friend behind', friendAhead: 'the friend ahead', lowestHpFriend: 'the weakest friend', randomFriend: 'a random friend', randomFriends: 'random friends', highestAtkFriend: 'the strongest friend', triggerFriend: 'that friend', enemyFront: 'the front enemy', lastEnemy: 'the back enemy', allEnemies: 'all enemies', randomEnemy: 'a random enemy' };
const sgn = (v) => (v >= 0 ? '+' + v : '' + v);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function describe(e) {
  if (!e || e.type === 'none') return '';
  switch (e.type) {
    case 'buff': return `${(e.atk < 0 || e.hp < 0) ? 'weaken' : 'give'} ${TGT[e.target] || e.target} ${sgn(e.atk || 0)}/${sgn(e.hp || 0)}${e.mode === 'perm' ? ' permanently' : ''}`;
    case 'shield': return `give ${TGT[e.target] || e.target} a ${e.amount}-HP shield`;
    case 'damage': return `deal ${e.amount === 'selfAtk' ? 'its attack' : e.amount} to ${TGT[e.target] || e.target}`;
    case 'steal': return `steal ${sgn(e.atk || 0)}/${sgn(e.hp || 0)} from ${TGT[e.target] || e.target}`;
    case 'summon': { const n = e.count || 1; return `summon ${n} ${cap(e.token || 'token')}${n > 1 ? 's' : ''}`; }
    case 'skipAttack': return `stop ${TGT[e.target] || e.target} from attacking`;
    case 'swapStats': return 'swap its attack and health';
    case 'move': return e.to === 'back' ? 'dash to the back' : 'dart to the front';
    case 'multi': { const p = e.effects.map(describe).filter(Boolean); return p.length <= 1 ? (p[0] || '') : p.slice(0, -1).join(', ') + ', then ' + p[p.length - 1]; }
    case 'chance': return `maybe ${describe(e.then)}${e.else ? ', otherwise ' + describe(e.else) : ''}`;
    case 'randomEffect': return 'a random bonus';
    default: return '';   // never leak a raw effect-type keyword into player-facing copy
  }
}
// Flatten nested multis + combine same-target buffs/shields so the blended fusion text reads cleanly
// (e.g. "give itself +2/+1, then give itself +1/+1" → "give itself +3/+2"). Behaviour-identical — the engine
// applies a summed buff the same as two sequential ones, and a flat multi fires the same as a nested one.
function flattenMerge(effects) {
  const flat = [];
  const push = (e) => { if (!e || e.type === 'none') return; if (e.type === 'multi') (e.effects || []).forEach(push); else flat.push(e); };
  effects.forEach(push);
  const out = [];
  for (const e of flat) {
    if (e.type === 'buff') {
      const m = out.find((o) => o.type === 'buff' && o.target === e.target && o.mode === e.mode && (((o.atk || 0) < 0) === ((e.atk || 0) < 0)) && (((o.hp || 0) < 0) === ((e.hp || 0) < 0)));
      if (m) { m.atk = (m.atk || 0) + (e.atk || 0); m.hp = (m.hp || 0) + (e.hp || 0); continue; }
    } else if (e.type === 'shield') {
      const m = out.find((o) => o.type === 'shield' && o.target === e.target);
      if (m) { m.amount = (m.amount || 0) + (e.amount || 0); continue; }
    }
    out.push({ ...e });
  }
  return out;
}
function portmanteau(a, b) { const h = Math.ceil(a.length / 2), t = Math.floor(b.length / 2); return cap((a.slice(0, h) + b.slice(b.length - t)).replace(/\s+/g, '')); }

// A flavour description for EVERY fusion — deterministic template over the parents' names, a pair-hash picks
// the variant, so all 4,656+ pairs read differently with zero authored data.
const FUSE_LINES = [
  (a, b, w) => `Where ${a} and ${b} entwine, a new ${w} spirit wakes — carrying the heart of both.`,
  (a, b) => `${a} and ${b}, bound as one: a single Trinkling that fights with a doubled will.`,
  (a, b) => `Two became one. ${a}'s nature woven through ${b}'s into something fiercer than either alone.`,
  (a, b) => `A rare bonding of ${a} and ${b} — neither on its own, but greater for the union.`,
  (a, b, w) => `The ${w} tell of this pairing: ${a} and ${b}, fused into one storied ally.`,
  (a, b) => `${a} lent its strength, ${b} its cunning; together they answer to a new name.`,
];
function pairHash(a, b) { const s = [a, b].sort().join('~'); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function fuseDesc(nameA, nameB, world, idA, idB) {
  const w = (world || 'old worlds').replace(/^the\s+/i, '');   // avoid "The The Meantide"
  return FUSE_LINES[pairHash(idA, idB) % FUSE_LINES.length](nameA, nameB, w);
}

// Every fusion gains a SIGNATURE "fusion" bonus on top of its blended parent effects — the extra edge that
// makes a merged Trinkling special. The pair deterministically picks one (so fusions feel varied & authored),
// modestly tier-scaled. Trigger-agnostic effects so they read fine on whatever trigger the fusion inherits.
// Flat base amounts — the ENGINE now scales every magnitude by the fused unit's level AND tier, so a
// signature on a high-tier, high-level fusion is automatically much stronger (no tier baked in here).
const FUSE_SIGS = [
  { name: 'Bulwark',   effect: () => ({ type: 'shield', target: 'self', amount: 2 }) },
  { name: 'Onslaught', effect: () => ({ type: 'buff', target: 'self', atk: 2, hp: 0, mode: 'battle' }) },
  { name: 'Kinship',   effect: () => ({ type: 'buff', target: 'allFriends', atk: 1, hp: 1, mode: 'battle' }) },
  { name: 'Emberburst',effect: () => ({ type: 'damage', target: 'randomEnemy', amount: 2 }) },
  { name: 'Vigor',     effect: () => ({ type: 'buff', target: 'self', atk: 1, hp: 2, mode: 'battle' }) },
  { name: 'Aegis',     effect: () => ({ type: 'shield', target: 'friendBehind', amount: 2 }) },
];

export function canFuse(a, b) { return a && b && !a.fused && !b.fused && a.defId !== b.defId; }  // BASE units only

// Fuse two squad units → a new fused squad-unit object (does not mutate inputs).
export function fuseUnit(a, b) {
  const ma = meta(a), mb = meta(b);
  const [hi, lo] = ma.tier >= mb.tier ? [ma, mb] : [mb, ma];
  const tier = Math.min(6, hi.tier);
  // Reband the FOOD-STRIPPED base stats of BOTH parents to the tier band (a balanced COMBINATION of their
  // stats), then re-add the food of the SECOND-CHOSEN pet only (`a` — the fuse target) on top, per feedback.
  // (Battle-effect foods like Firepip/Honey still come from BOTH via the snacks array below.)
  const foodAtk = a.foodAtk || 0, foodHp = a.foodHp || 0;   // second-chosen pet's food only
  let atk = (Math.max(1, a.atk - (a.foodAtk || 0)) + Math.max(1, b.atk - (b.foodAtk || 0))) / 2;
  let hp = (Math.max(1, a.hp - (a.foodHp || 0)) + Math.max(1, b.hp - (b.foodHp || 0))) / 2;
  const k = BAND[tier] / Math.max(1, atk + hp);
  atk = clampN(atk * k + foodAtk); hp = clampN(hp * k + foodHp);
  const trig = [hi.ability?.trigger, lo.ability?.trigger].find((t) => BATTLE_TRIGS.includes(t)) || 'onStartBattle';
  const flevel = Math.min(a.level || 1, b.level || 1);   // inherit the LOWER parent level (per spec)
  const sig = FUSE_SIGS[pairHash(a.defId, b.defId) % FUSE_SIGS.length];   // this fusion's signature bonus
  const effect = { type: 'multi', effects: flattenMerge([sig.effect(), scale(toBattle(hi.ability?.effect), 0.75), scale(toBattle(lo.ability?.effect), 0.75)]) };
  // Never strip a parent's once-per-battle guard, and never create an unlimited "when a friend/it faints →
  // summon another" loop (feedback: makes fights unwinnable). Force once when a parent was guarded, OR when a
  // faint trigger drives a summon (even if neither parent was guarded — a mixed onFaint-summon combo).
  const parentOnce = hi.ability?.once === 'battle' || lo.ability?.once === 'battle';
  const faintSummonLoop = (trig === 'onFriendFaints' || trig === 'onFaint' || trig === 'onFriendSummoned') && hasSummon(effect);
  const once = (parentOnce || faintSummonLoop) ? 'battle' : undefined;
  const TRIGTXT = { onStartBattle: 'Start of the fight', onKill: 'On a knockout', onHurt: 'When hurt', onFaint: 'When it faints', onFriendFaints: 'When a friend faints', onBeforeAttack: 'Before it attacks', onAfterAttack: 'After it attacks', onFriendSummoned: 'When a friend is summoned', onFirstBlood: 'On first blood', onLowHealth: 'At half health', everyOtherRound: 'Every other round' };
  const artA = ma.art, artB = mb.art;
  const name = portmanteau(hi.name, lo.name);
  return {
    defId: 'fus:' + [artA, artB].sort().join('~'),      // identity + carries the two art bases
    // xp must MATCH the inherited level or the level pips render empty (looked like L1). Fused units are
    // terminal (never merge again), so this xp is display-only — it just makes the level read correctly.
    name, atk, hp, level: flevel, xp: flevel >= 3 ? CONFIG.xpToL3 : flevel >= 2 ? CONFIG.xpToL2 : 0,
    snacks: [...(a.snacks || []), ...(b.snacks || [])],
    foodAtk, foodHp,   // carry the inherited food so a fusion-of-a-fusion keeps it too

    fused: {
      parents: [a.defId, b.defId], artParents: [artA, artB], tier, faction: hi.faction, world: hi.world,
      ability: { trigger: trig, effect, ...(once ? { once } : {}), text: `${TRIGTXT[trig] || 'Start of the fight'}: ${describe(effect)}${once ? ' (once per fight)' : ''}.` },
      desc: fuseDesc(hi.name, lo.name, hi.world, a.defId, b.defId),
    },
  };
}

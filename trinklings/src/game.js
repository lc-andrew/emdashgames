// Trinklings — run + shop state machine (UI-agnostic; shared by client, AI bot, and sim).
//
// Holds a single run: gold, hearts, trophies, the 5-slot squad, and the shop. All randomness flows
// through one seeded RNG so an entire run is reproducible. The client wraps this with DOM; the AI bot
// (tools/ai.js) drives the same methods to build ghost opponents and to run the balance sim.

import { RNG } from './rng.js';
import { simulateBattle, resetUid } from './engine.js';
import { CONFIG, CREATURES, CREATURE_BY_ID, SNACKS, SNACK_BY_ID } from './data/creatures.js';
import { fuseUnit } from './fusion.js';

const clamp = (n) => Math.max(0, Math.min(CONFIG.statCap, n));

export function unlockedTier(turn) { return Math.min(CONFIG.maxTier, Math.floor((turn + 1) / 2)); }
function slotsFor(schedule, turn) { return (schedule.find((s) => turn <= s.upToTurn) || schedule[schedule.length - 1]).n; }
function levelForXp(xp) { return xp >= CONFIG.xpToL3 ? 3 : xp >= CONFIG.xpToL2 ? 2 : 1; }

export function makeCreature(defId) {
  const d = CREATURE_BY_ID[defId];
  return { defId, name: d.name, world: d.world, tier: d.tier, atk: d.atk, hp: d.hp, level: 1, xp: 0, snacks: [], foodAtk: 0, foodHp: 0 };
}

export class GameState {
  constructor(seed = 1, opts = {}) {
    this.rng = new RNG(seed);
    this.opts = opts;
    this.coalition = opts.coalition || null;  // array of 2 faction keys; null = all factions (quick play)
    this.turn = 0;
    this.gold = 0;
    this.hearts = opts.easy ? CONFIG.easyHearts : CONFIG.startingHearts;
    this.trophies = 0;
    this.wins = 0;
    this.losses = 0;
    this.lostAny = false;
    this.squad = Array(CONFIG.squadSlots).fill(null);
    this.shop = { pets: [], snacks: [] };
    this.status = 'shop';            // 'shop' | 'won' | 'lost'
    this.pendingReward = null;       // { options: [defId, defId] }
    this.lastBattle = null;          // { result, log, opponent }
    this.history = [];               // per-turn snapshots for ghosts / replay
    this.startTurn();
  }

  // ---- turn lifecycle ----
  startTurn() {
    this.turn += 1;
    this.gold = CONFIG.goldPerTurn;
    // mercy heart (turn 3, if you've lost any)
    if (this.turn === CONFIG.mercyTurn && this.lostAny && this.hearts > 0) this.hearts += 1;
    // onStartTurn shop triggers (e.g. Nib grants gold)
    for (const c of this.livingSquad()) this.fireShop(c, 'onStartTurn');
    this.rollShop(true); // free auto-roll each turn
  }

  // ---- shop ----
  rollShop(free = false) {
    if (!free) {
      if (this.gold < CONFIG.rollCost) return false;
      this.gold -= CONFIG.rollCost;
    }
    const tier = unlockedTier(this.turn);
    const petSlots = slotsFor(CONFIG.shopPetSlots, this.turn);
    const snackSlots = slotsFor(CONFIG.shopSnackSlots, this.turn);
    const petPool = CREATURES.filter((c) => c.tier <= tier && (!this.coalition || this.coalition.includes(c.faction)));
    const snackPool = SNACKS.filter((s) => s.tier <= tier);
    const keep = (arr, n) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push(arr[i] && arr[i].frozen ? arr[i] : null);
      return out;
    };
    const pets = keep(this.shop.pets, petSlots);
    const snacks = keep(this.shop.snacks, snackSlots);
    // Bias ~35% of fresh pet slots toward a Trinkling you already own and can still level up — so building
    // a set to L2/L3 is actually reachable. Stays inside the coalition-filtered pool; seeded for determinism.
    const ownedIds = new Set(this.squad.filter(Boolean).filter((c) => c.xp < CONFIG.xpToL3).map((c) => c.defId));
    const ownedPool = petPool.filter((c) => ownedIds.has(c.id));
    // Sample WITHOUT replacement within a shop: no two identical Trinklings in one shop (kept/frozen ones
    // included), so a roll never wastes slots on dupes. Still seeded and still ~35%-biased toward an owned,
    // still-levelable Trinkling so building to L2/L3 stays reachable. (Feedback: dupes too frequent.)
    const used = new Set(pets.filter(Boolean).map((p) => p.defId));
    for (let i = 0; i < petSlots; i++) {
      if (pets[i]) continue;
      const owned = ownedPool.filter((c) => !used.has(c.id));
      const fresh = petPool.filter((c) => !used.has(c.id));
      const useOwned = owned.length && this.rng.chance(0.35);
      const pick = this.rng.pick(useOwned ? owned : (fresh.length ? fresh : petPool));
      used.add(pick.id);
      pets[i] = { kind: 'pet', defId: pick.id, frozen: false };
    }
    for (let i = 0; i < snackSlots; i++) if (!snacks[i]) snacks[i] = { kind: 'snack', defId: this.rng.pick(snackPool).id, frozen: false };
    this.shop.pets = pets;
    this.shop.snacks = snacks;
    return true;
  }

  toggleFreeze(kind, index) {
    const arr = kind === 'pet' ? this.shop.pets : this.shop.snacks;
    if (arr[index]) arr[index].frozen = !arr[index].frozen;
  }

  // Buy a shop pet into a squad slot. Empty slot -> place; same-type non-max -> merge/combine.
  buyPet(shopIndex, slotIndex) {
    const item = this.shop.pets[shopIndex];
    if (!item) return { ok: false, reason: 'cannot-afford' };
    const cost = item.free ? 0 : CONFIG.buyCost;   // level-up reward pets are free
    if (this.gold < cost) return { ok: false, reason: 'cannot-afford' };
    const target = this.squad[slotIndex];
    if (target && target.defId !== item.defId) return { ok: false, reason: 'occupied' };
    if (target && target.defId === item.defId && target.xp >= CONFIG.xpToL3) return { ok: false, reason: 'max-level' };
    if (!target && this.livingSquad().length >= CONFIG.squadSlots) return { ok: false, reason: 'full' };
    this.gold -= cost;
    this.shop.pets[shopIndex] = null;
    const bought = makeCreature(item.defId);
    if (target) this.mergeInto(target, bought);
    else this.squad[slotIndex] = bought;
    // onFriendBought (e.g. Cove) fires for OTHER squad members
    const placed = this.squad[slotIndex];
    for (const c of this.livingSquad()) if (c !== placed) this.fireShop(c, 'onFriendBought', { triggerFriend: placed });
    return { ok: true };
  }

  // Buy a shop pet AND fuse it onto a DIFFERENT-type squad pet in one action (per feedback): cost buy + fuse.
  buyFuse(shopIndex, slotIndex) {
    const item = this.shop.pets[shopIndex];
    const target = this.squad[slotIndex];
    if (!item || !target || target.fused || target.defId === item.defId) return { ok: false, reason: 'invalid-fuse' };
    const cost = (item.free ? 0 : CONFIG.buyCost) + (CONFIG.fuseCost ?? 10);
    if (this.gold < cost) return { ok: false, reason: 'cannot-afford-fuse', cost };
    this.gold -= cost;
    this.shop.pets[shopIndex] = null;
    this.squad[slotIndex] = fuseUnit(target, makeCreature(item.defId));   // fuseUnit inherits food from the target
    return { ok: true, action: 'fuse' };
  }

  // Merge `src` (a creature object) into `dst` in place: keeps the better stats + combine bump + XP.
  mergeInto(dst, src) {
    const before = dst.level;
    dst.atk = clamp(Math.max(dst.atk, src.atk) + CONFIG.combineStat);
    dst.hp = clamp(Math.max(dst.hp, src.hp) + CONFIG.combineStat);
    dst.xp = Math.min(CONFIG.xpToL3, dst.xp + src.xp + 1);
    dst.snacks = [...dst.snacks, ...src.snacks];
    // stats use max(dst,src)+bump, so keep the food bonus consistent with max (not sum)
    dst.foodAtk = Math.max(dst.foodAtk || 0, src.foodAtk || 0); dst.foodHp = Math.max(dst.foodHp || 0, src.foodHp || 0);
    dst.level = levelForXp(dst.xp);
    if (dst.level > before) this.onLevelUp(dst);
  }

  onLevelUp(creature) {
    this.fireShop(creature, 'onLevelUp');
    if (!CONFIG.levelUpReward) return;
    // Offer a free choice of 2 Trinklings from one tier above — WITHIN YOUR COALITION (keeps "coalition = your deck").
    const tier = Math.min(CONFIG.maxTier, unlockedTier(this.turn) + 1);
    const inCo = (c) => !this.coalition || this.coalition.includes(c.faction);
    let pool = CREATURES.filter((c) => c.tier === tier && inCo(c));
    if (pool.length < 2) pool = CREATURES.filter((c) => c.tier <= tier && inCo(c));
    const opts = this.rng.sample(pool, 2).map((c) => c.id);
    this.pendingReward = { options: opts };
  }

  chooseReward(optionIndex) {
    if (!this.pendingReward) return { ok: false };
    const defId = this.pendingReward.options[optionIndex];
    this.pendingReward = null;
    if (defId == null) return { ok: true }; // declined
    const slot = this.squad.indexOf(null);
    if (slot >= 0) { this.squad[slot] = makeCreature(defId); return { ok: true }; }
    // Squad full: park the FREE reward in a shop slot (within slot count so a roll keeps it, frozen).
    const item = { kind: 'pet', defId, frozen: true, free: true };
    let idx = this.shop.pets.findIndex((p) => !p);
    if (idx < 0) idx = this.shop.pets.findIndex((p) => p && !p.frozen);
    if (idx < 0) idx = this.shop.pets.length - 1;
    this.shop.pets[idx] = item;
    return { ok: true };
  }

  buySnack(shopIndex, slotIndex) {
    const item = this.shop.snacks[shopIndex];
    const target = this.squad[slotIndex];
    if (!item || this.gold < CONFIG.snackCost) return { ok: false, reason: 'cannot-afford' };
    const snack = SNACK_BY_ID[item.defId];
    const e = snack.effect;
    // Snacks that act on a SPECIFIC critter (targeted buffs + held grants like Honeypot/Firepip) need one.
    const needsTarget = e.target === 'chosen' || e.type === 'grantFaint' || e.type === 'grantFirstStrike';
    if (needsTarget && !target) return { ok: false, reason: 'no-target' };
    if ((e.target === 'randomFriend' || e.target === 'randomFriends') && this.livingSquad().length === 0) return { ok: false, reason: 'no-target' };
    this.gold -= CONFIG.snackCost;
    this.shop.snacks[shopIndex] = null;
    this.applySnack(snack, target);
    return { ok: true };
  }

  applySnack(snack, target) {
    const e = snack.effect;
    if (e.type === 'buff') {
      let ts;
      if (e.target === 'randomFriends') ts = this.rng.sample(this.livingSquad(), e.count || 1);
      else if (e.target === 'randomFriend') { const t = this.rng.pick(this.livingSquad()); ts = t ? [t] : []; }
      else ts = target ? [target] : [];
      // Track the permanent FOOD bonus on each unit that actually receives it, so a later FUSION can inherit
      // it (fuseUnit re-adds it on top of the tier-banded base). Attributes correctly for random-target foods.
      for (const t of ts) {
        t.atk = clamp(t.atk + (e.atk || 0)); t.hp = clamp(t.hp + (e.hp || 0));
        t.foodAtk = (t.foodAtk || 0) + (e.atk || 0); t.foodHp = (t.foodHp || 0) + (e.hp || 0);
      }
    } else if (e.type === 'grantFaint') {
      if (target) target.snacks.push(snack.id);      // store the ACTUAL snack (Royal Hive ≠ Honey), not a hardcoded id
    } else if (e.type === 'grantFirstStrike') {
      if (target) target.snacks.push(snack.id);      // …so Emberkeg keeps its tier-5 bonus instead of Chili's
    }
  }

  sell(slotIndex) {
    const c = this.squad[slotIndex];
    if (!c) return { ok: false };
    this.fireShop(c, 'onSell'); // e.g. Tuppence buffs friends before leaving
    this.gold += c.level; // sell value = level
    this.squad[slotIndex] = null;
    return { ok: true };
  }

  // Move or merge within the squad (tap-to-place).
  moveSquad(from, to) {
    if (from === to) return { ok: false };
    const a = this.squad[from];
    if (!a) return { ok: false };
    const b = this.squad[to];
    if (!b) { this.squad[to] = a; this.squad[from] = null; return { ok: true, action: 'move' }; }
    // A fused unit is TERMINAL — it can't merge or fuse again (only BASE characters combine).
    const terminal = a.fused || b.fused;
    if (!terminal && b.defId === a.defId && b.xp < CONFIG.xpToL3) { this.mergeInto(b, a); this.squad[from] = null; return { ok: true, action: 'merge' }; }
    // DIFFERENT base types → FUSE into a new pet (unique balanced ability; inherits the lower level).
    // Fusing now costs gold (a real, powerful choice) — blocked if the player can't afford it.
    if (!terminal && a.defId !== b.defId) {
      const fuseCost = CONFIG.fuseCost ?? 10;
      if (this.gold < fuseCost) return { ok: false, reason: 'cannot-afford-fuse', cost: fuseCost };
      this.gold -= fuseCost;
      this.squad[to] = fuseUnit(b, a); this.squad[from] = null;
      return { ok: true, action: 'fuse' };
    }
    // otherwise just swap positions
    this.squad[from] = b; this.squad[to] = a;
    return { ok: true, action: 'swap' };
  }

  // ---- shop-context effect firing (no enemies) ----
  livingSquad() { return this.squad.filter(Boolean); }

  squadTargets(target, actor, ctx = {}) {
    const line = this.squad.filter(Boolean);
    const idx = line.indexOf(actor);
    switch (target) {
      case 'self': return [actor];
      case 'friendAhead': return idx > 0 ? [line[idx - 1]] : [];
      case 'friendBehind': return idx >= 0 && idx < line.length - 1 ? [line[idx + 1]] : [];
      case 'allFriends': return line.filter((c) => c !== actor);
      case 'randomFriend': { const p = line.filter((c) => c !== actor); return p.length ? [this.rng.pick(p)] : []; }
      case 'randomFriends': { const p = line.filter((c) => c !== actor); return this.rng.sample(p, ctx.count || 1); }
      case 'triggerFriend': return ctx.triggerFriend ? [ctx.triggerFriend] : [];
      default: return [];
    }
  }

  fireShop(actor, trigger, ctx = {}) {
    // fused units carry their own ability; base units look it up. Fused abilities use battle triggers only,
    // so this simply no-ops for them in the shop (guarded), but never crashes on the missing def.
    const ability = actor.fused ? actor.fused.ability : CREATURE_BY_ID[actor.defId]?.ability;
    if (!ability || ability.trigger !== trigger) return;
    this.applyShopEffect(ability.effect, actor, ctx);
  }

  applyShopEffect(effect, actor, ctx = {}) {
    if (!effect || effect.type === 'none') return;
    const lvl = actor.level || 1;
    if (effect.type === 'multi') { for (const e of effect.effects) this.applyShopEffect(e, actor, ctx); return; }
    if (effect.type === 'chance') {
      const p = effect.pByLevel ? (effect.pByLevel[lvl - 1] ?? effect.pByLevel[effect.pByLevel.length - 1]) : effect.p;
      const br = this.rng.chance(p) ? effect.then : effect.else;
      if (br) this.applyShopEffect(br, actor, ctx);
      return;
    }
    if (effect.type === 'buff') {
      const count = (effect.count || 1);
      const tgs = this.squadTargets(effect.target, actor, { ...ctx, count });
      // PERMANENT (and noScale) shop buffs do NOT scale with level — else an L3 perm-scaler (Sprig/Yggy/Cove…)
      // gains ×level every turn and pins the stat cap (99% win-rate exploit). Battle-mode buffs still ×level.
      const m = (effect.mode === 'perm' || effect.noScale) ? 1 : lvl;
      for (const t of tgs) { t.atk = clamp(t.atk + (effect.atk || 0) * m); t.hp = clamp(t.hp + (effect.hp || 0) * m); }
      return;
    }
    if (effect.type === 'gold') { this.gold += (effect.amount || 0) * lvl; return; }
  }

  // ---- end turn: fire onEndTurn, battle the opponent, apply outcome ----
  endTurn(opponentTeam, battleSeed) {
    for (const c of this.livingSquad()) this.fireShop(c, 'onEndTurn');
    const myTeam = this.squadForBattle();
    resetUid(1);
    const seed = battleSeed != null ? battleSeed : this.rng.int(1e9);
    const res = simulateBattle(myTeam, opponentTeam, seed, this.turn);
    // Persist keep-mode permanent buffs onto the LIVE squad (survivors only). livingSquad() order == myTeam order,
    // so the survivor index from the engine maps straight back onto the real creature.
    if (res.keepDeltas && res.keepDeltas.length) {
      const ls = this.livingSquad();
      for (const d of res.keepDeltas) { const c = ls[d.i]; if (c) { c.atk = clamp(c.atk + d.atk); c.hp = clamp(c.hp + d.hp); } }
    }
    if (res.result === 'win') { this.wins += 1; this.trophies += 1; }
    else if (res.result === 'lose') { this.losses += 1; this.lostAny = true; this.hearts -= CONFIG.heartsLostPerLoss; }
    // draw: nothing
    this.lastBattle = { result: res.result, log: res.log, opponent: opponentTeam };
    this.history.push({ turn: this.turn, team: myTeam, result: res.result });
    if (this.trophies >= CONFIG.winTrophies) this.status = 'won';
    else if (this.hearts <= 0) this.status = 'lost';
    return this.lastBattle;
  }

  // Persistent squad -> battle-ready team (plain snapshots the engine consumes).
  squadForBattle() {
    return this.livingSquad().map((c) => ({ defId: c.defId, name: c.name, atk: c.atk, hp: c.hp, level: c.level, snacks: c.snacks.slice(), fused: c.fused }));
  }

  // Serializable view for the client / ghost snapshots.
  view() {
    return {
      turn: this.turn, gold: this.gold, hearts: this.hearts, trophies: this.trophies,
      wins: this.wins, losses: this.losses, status: this.status,
      squad: this.squad, shop: this.shop, pendingReward: this.pendingReward,
      unlockedTier: unlockedTier(this.turn),
    };
  }
}

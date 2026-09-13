// Trinklings — deterministic battle engine.
//
// Pure, DOM-free, fully seeded. Same (teams, seed) → identical battle + identical event log,
// on Node and in the browser. This is what makes golden replays (FB-R20) and the balance sim
// (FB-R7) possible, and lets the client animate a battle it did not compute.
//
// Combat model (verified vs superautopets.wiki.gg, 2026-09-10):
//  • Only the two FRONT pets attack, SIMULTANEOUSLY — compute both damages, apply both, then faint.
//  • Same-trigger abilities fire in DESCENDING ATTACK order; ties broken by seeded RNG.
//  • Per step: damage → faints (onFaint) → summons (placed in fainted slot, 5-cap, overflow dropped)
//    → onFriendSummoned / onFriendFaints → onHurt on survivors → shift forward. Loop until a side empty.
//  • Mutual wipe = draw. A hard turn cap guarantees termination (scored a draw).

import { RNG } from './rng.js';
import { CONFIG, ALL_UNITS_BY_ID, TOKENS, SNACK_BY_ID } from './data/creatures.js';

let UID = 1;
export function resetUid(n = 1) { UID = n; }

// ---- unit construction ------------------------------------------------------

// A persistent (shop) creature: { defId, name, tier, atk, hp, level, xp, snacks:[snackId] }
// Turn it into a battle unit (a disposable working copy).
export function toBattleUnit(shopUnit, side) {
  const def = ALL_UNITS_BY_ID[shopUnit.defId] || {};   // {} guard: fused units aren't in the registry
  const fu = shopUnit.fused;                            // a FUSED unit carries its own tier/ability
  const u = {
    uid: UID++,
    defId: shopUnit.defId,
    name: shopUnit.name || def.name,
    tier: (fu ? fu.tier : def.tier) || 0,
    level: shopUnit.level || 1,
    atk: shopUnit.atk,
    hp: shopUnit.hp,
    startHp: shopUnit.hp,
    shield: 0,
    armor: (fu ? fu.armor : def.armor) || 0,
    side,
    ability: (fu ? fu.ability : def.ability) || null,
    isToken: !!def.token,
    // per-battle flags
    firstStrikeBonus: 0,
    firstStrikeUsed: false,
    faintSummon: null,      // {token, count} granted by Honey
    onceUsed: {},           // trigger-name -> true (for `once:'battle'` abilities)
    skipNextAttack: false,
    _hurtPending: false,
    dead: false,
    srcRef: shopUnit,   // squad unit this clone came from — for keep-mode permanent writeback
    guarding: null,     // 'friendBehind' | 'allFriends' when this unit is an active guardian
  };
  // Apply held items that grant battle effects — values read from the item DATA (not hardcoded here), so
  // editing an item in the data actually changes the battle.
  for (const sid of shopUnit.snacks || []) {
    const eff = SNACK_BY_ID[sid]?.effect;
    if (eff?.type === 'grantFirstStrike') u.firstStrikeBonus += eff.bonus || 0;
    if (eff?.type === 'grantFaint') u.faintSummon = { token: eff.summon || 'bee', count: eff.count || 1 };
  }
  return u;
}

function makeToken(tokenId, side, level = 1, statOverride = null) {
  const def = TOKENS[tokenId];
  const u = {
    uid: UID++, defId: tokenId, name: def.name, tier: 0, level,
    atk: statOverride ? statOverride.atk : def.atk,
    hp: statOverride ? statOverride.hp : def.hp,
    startHp: statOverride ? statOverride.hp : def.hp,
    shield: 0, armor: def.armor || 0, side, ability: def.ability || null, isToken: true,
    firstStrikeBonus: 0, firstStrikeUsed: false, faintSummon: null, onceUsed: {},
    skipNextAttack: false, _hurtPending: false, dead: false, guarding: null,
  };
  return u; // tokens have no srcRef (no shop counterpart) — keep-mode writeback skips them
}

// ---- helpers ----------------------------------------------------------------

const clampStat = (n) => Math.max(0, Math.min(CONFIG.statCap, n));

function sortByAttackDesc(units, rng) {
  // Descending attack; ties broken by seeded RNG (stable-ish via random keys).
  return units
    .map((u) => ({ u, k: u.atk * 1000 + rng.next() }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.u);
}

function living(team) { return team.filter((u) => !u.dead && u.hp > 0); }

// ---- the battle state -------------------------------------------------------

class Battle {
  constructor(teamA, teamB, seed, turnNo = 1) {
    this.rng = new RNG(seed);
    this.turnNo = turnNo;
    this.teams = [
      teamA.map((s) => toBattleUnit(s, 0)),
      teamB.map((s) => toBattleUnit(s, 1)),
    ];
    this.log = [];
    this.guard = 0;
  }

  emit(ev) { this.log.push(ev); }
  friends(u) { return this.teams[u.side]; }
  enemies(u) { return this.teams[u.side ^ 1]; }

  // Resolve a target keyword for `actor` into an array of live units.
  targets(target, actor, ctx = {}) {
    const team = this.teams[actor.side];
    const enemy = this.teams[actor.side ^ 1];
    const liveTeam = living(team);
    const liveEnemy = living(enemy);
    const idx = liveTeam.indexOf(actor);
    switch (target) {
      case 'self': return [actor];
      // Resolve against the FULL team array (the just-fainted actor is still present pre-compaction) and pick
      // the nearest LIVING neighbor — so onFaint abilities (gourdon/vesper) that target the friend behind/ahead
      // actually fire. Behaviour-identical for a living actor. (Bug from mechanics sweep 2026-09-13.)
      case 'friendAhead': {
        const i = team.indexOf(actor); if (i < 0) return [];
        for (let k = i - 1; k >= 0; k--) if (!team[k].dead && team[k].hp > 0) return [team[k]];
        return [];
      }
      case 'friendBehind': {
        const i = team.indexOf(actor); if (i < 0) return [];
        for (let k = i + 1; k < team.length; k++) if (!team[k].dead && team[k].hp > 0) return [team[k]];
        return [];
      }
      case 'allFriends': return liveTeam.filter((u) => u !== actor);
      case 'randomFriend': {
        const pool = liveTeam.filter((u) => u !== actor);
        return pool.length ? [this.rng.pick(pool)] : [];
      }
      case 'randomFriends': {
        const pool = liveTeam.filter((u) => u !== actor);
        return this.rng.sample(pool, ctx.count || 1);
      }
      case 'lowestHpFriend': {
        const pool = liveTeam.slice().sort((a, b) => a.hp - b.hp);
        return pool.length ? [pool[0]] : [];
      }
      case 'highestAtkFriend': {
        const pool = liveTeam.filter((u) => u !== actor).sort((a, b) => b.atk - a.atk);
        return pool.length ? [pool[0]] : [];
      }
      case 'enemyFront': return liveEnemy.length ? [liveEnemy[0]] : [];
      case 'lastEnemy': return liveEnemy.length ? [liveEnemy[liveEnemy.length - 1]] : [];
      case 'randomEnemy': return liveEnemy.length ? [this.rng.pick(liveEnemy)] : [];
      case 'allEnemies': return liveEnemy.slice();
      case 'triggerFriend': return ctx.triggerFriend && !ctx.triggerFriend.dead ? [ctx.triggerFriend] : [];
      default: return [];
    }
  }

  // Magnitude scaling: by LEVEL (×1/2/3) AND by TIER — higher-tier Trinklings hit MUCH harder. A tier-6
  // ability lands ~2.25× a tier-1's (before level); stacked with level a maxed high-tier ability is enormous.
  // This applies to base creatures AND fused units (fusions carry the higher parent's tier), so every
  // (fusion pair × level) yields a distinct real magnitude at battle time.
  scaled(base, actor, noScale = false) {
    if (noScale) return base;
    const tierMult = 1 + (((actor.tier || 1) - 1) * 0.25);
    return Math.round(base * (actor.level || 1) * tierMult);
  }

  // Which living guardian (if any) intercepts damage aimed at `unit`.
  guardianFor(unit) {
    const live = living(this.teams[unit.side]);
    const idx = live.indexOf(unit);
    if (idx > 0 && live[idx - 1].guarding === 'friendBehind') return live[idx - 1];
    let best = null, bestD = Infinity;
    for (let i = 0; i < live.length; i++) {
      const g = live[i];
      if (g !== unit && g.guarding === 'allFriends') { const d = Math.abs(i - idx); if (d < bestD) { bestD = d; best = g; } }
    }
    return best;
  }

  // Apply raw damage to a unit (guard-redirect + shield + armor + min-damage). Returns {hurt, fainted}.
  dealDamage(unit, amount, sourceUid, srcSide, opts = {}) {
    if (unit.dead || amount <= 0) return { hurt: false, fainted: false };
    // guard: enemy-sourced DAMAGE to a guarded friend is redirected to the nearest living guardian.
    if (!opts.redirected && srcSide !== undefined && srcSide !== unit.side) {
      const g = this.guardianFor(unit);
      if (g && g !== unit) { this.emit({ t: 'guardRedirect', from: unit.uid, to: g.uid }); return this.dealDamage(g, amount, sourceUid, srcSide, { redirected: true }); }
    }
    let dmg = Math.max(CONFIG.minDamage, amount - unit.armor);
    if (unit.shield > 0) {
      const absorbed = Math.min(unit.shield, dmg);
      unit.shield -= absorbed; dmg -= absorbed;
    }
    let hurt = false;
    if (dmg > 0) { unit.hp -= dmg; hurt = true; }
    const fainted = unit.hp <= 0;
    this.emit({ t: 'damage', uid: unit.uid, src: sourceUid, amount: dmg, hp: Math.max(0, unit.hp), shield: unit.shield });
    if (hurt && !fainted) unit._hurtPending = true;
    return { hurt, fainted };
  }

  buff(unit, atk, hp) {
    if (unit.dead) return;
    unit.atk = clampStat(unit.atk + atk);
    if (hp !== 0) { unit.hp = clampStat(unit.hp + hp); }
    this.emit({ t: 'buff', uid: unit.uid, atk, hp, newAtk: unit.atk, newHp: unit.hp });
  }

  giveShield(unit, amount) {
    if (unit.dead) return;
    unit.shield += amount;
    this.emit({ t: 'shield', uid: unit.uid, amount, shield: unit.shield });
  }

  // Insert a summoned token into `side`'s board at slot index (fainted pet's spot), 5-cap.
  summon(tokenId, side, slotIndex, count, actor, statOverride) {
    const team = this.teams[side];
    for (let i = 0; i < count; i++) {
      if (living(team).length >= CONFIG.squadSlots) {
        this.emit({ t: 'summonFail', token: tokenId, side });
        break;
      }
      // Safety net: a hard per-unit per-battle summon cap so no ability (e.g. a fused faint→summon that slipped
      // past its once-guard, or a self-referential onFriendSummoned→summon) can respawn tokens forever and make
      // a fight unwinnable. Set well above any legitimate summoner's real output (measured ceiling ~3).
      if (actor) {
        if ((actor._summonsMade || 0) >= (CONFIG.maxSummonsPerUnit || 20)) {
          this.emit({ t: 'summonFail', token: tokenId, side, capped: true });
          break;
        }
        actor._summonsMade = (actor._summonsMade || 0) + 1;
      }
      const tok = makeToken(tokenId, side, actor ? actor.level : 1, statOverride);
      // Insert at slotIndex within the array (dead units may still be present pre-compaction).
      const insertAt = Math.min(slotIndex + i, team.length);
      team.splice(insertAt, 0, tok);
      // Anchor: the nearest still-living unit IN FRONT of the token (lower array index). The client places
      // the new card just behind it so summons land in the right slot ("in its place" / "behind it") instead
      // of always at the back of the row. null => the token is the new front unit.
      // Anchor on the nearest NOT-DEAD unit (even one sitting at 0 HP pre-compaction) — the client keeps a card
      // for every not-yet-dead unit, so this matches DOM order and avoids lane divergence. (Sweep 2026-09-13.)
      let afterUid = null;
      for (let k = insertAt - 1; k >= 0; k--) { if (!team[k].dead) { afterUid = team[k].uid; break; } }
      this.emit({ t: 'summon', uid: tok.uid, token: tokenId, side, atk: tok.atk, hp: tok.hp, afterUid });
      // onFriendSummoned for that side's other living units
      for (const f of sortByAttackDesc(living(team).filter((u) => u !== tok), this.rng)) {
        if (f.ability && f.ability.trigger === 'onFriendSummoned') {
          this.fire(f, { triggerFriend: tok });
        }
      }
    }
  }

  // Execute a unit's ability effect (dispatch on effect.type). `ctx` carries trigger context.
  fire(actor, ctx = {}) {
    if (!actor.ability) return;
    const trig = actor.ability.trigger;
    if (actor.ability.once === 'battle') {
      if (actor.onceUsed[trig]) return;
      actor.onceUsed[trig] = true;
    }
    this.emit({ t: 'ability', uid: actor.uid, trigger: trig });
    this.applyEffect(actor.ability.effect, actor, ctx);
  }

  applyEffect(effect, actor, ctx = {}) {
    if (!effect || effect.type === 'none') return;
    switch (effect.type) {
      case 'multi':
        for (const e of effect.effects) this.applyEffect(e, actor, ctx);
        return;
      case 'chance': {
        const p = effect.pByLevel ? (effect.pByLevel[(actor.level || 1) - 1] ?? effect.pByLevel[effect.pByLevel.length - 1]) : effect.p;
        const branch = this.rng.chance(p) ? effect.then : effect.else;
        if (branch) this.applyEffect(branch, actor, ctx);
        return;
      }
      case 'buff': {
        const count = effect.count ? this.scaled(effect.count, actor, true) : 1;
        const tgs = this.targets(effect.target, actor, { ...ctx, count });
        const a = this.scaled(effect.atk || 0, actor, effect.noScale);
        const h = this.scaled(effect.hp || 0, actor, effect.noScale);
        for (const t of tgs) {
          this.buff(t, a, h); // negative a/h = a "pare" (shave); buff() clamps to 0 and never sets _hurtPending
          if (effect.mode === 'keep' && t.srcRef && !t.isToken) { // permanent buff — ACCUMULATE, persisted post-fight
            t._keepAtk = (t._keepAtk || 0) + a; t._keepHp = (t._keepHp || 0) + h;  // for SURVIVORS only (see simulateBattle)
          }
        }
        return;
      }
      case 'shield': {
        const amt = this.scaled(effect.amount, actor, effect.noScale);
        for (const t of this.targets(effect.target, actor, ctx)) this.giveShield(t, amt);
        return;
      }
      case 'damage': {
        let amt;
        if (effect.amount === 'selfAtk') amt = actor.atk;
        else amt = this.scaled(effect.amount, actor, effect.noScale);
        for (const t of this.targets(effect.target, actor, ctx)) this.dealDamage(t, amt, actor.uid, actor.side);
        return;
      }
      case 'steal': { // transfer atk/hp from each enemy target to self (per-target self-gain). Bypasses guard.
        const a = this.scaled(effect.atk || 0, actor, effect.noScale);
        const h = this.scaled(effect.hp || 0, actor, effect.noScale);
        for (const t of this.targets(effect.target, actor, ctx)) {
          t.atk = clampStat(t.atk - a); t.hp = clampStat(t.hp - h);
          // Emit the victim's NEW absolute atk/hp (tatk/thp) so the client can update its badge — a steal
          // only buffs the stealer via a separate 'buff' event, so without these the victim's numbers desync.
          this.emit({ t: 'steal', from: t.uid, to: actor.uid, atk: a, hp: h, tatk: Math.max(0, t.atk), thp: Math.max(0, t.hp) });
          this.buff(actor, a, h);
        }
        return;
      }
      case 'swapStats': {
        for (const t of this.targets(effect.target, actor, ctx)) {
          const a = t.atk, h = t.hp; t.atk = clampStat(h); t.hp = clampStat(a); t.startHp = t.hp;
          this.emit({ t: 'buff', uid: t.uid, atk: t.atk - a, hp: t.hp - h, newAtk: t.atk, newHp: t.hp });
        }
        return;
      }
      case 'guard': { // become a live damage-redirect aura for friends (checked per-hit in dealDamage)
        actor.guarding = effect.target; // 'friendBehind' | 'allFriends'
        this.emit({ t: 'guard', uid: actor.uid, mode: effect.target });
        return;
      }
      case 'randomEffect': { // pick exactly one (all options caster-positive) — seeded
        const pick = this.rng.pick(effect.effects);
        if (pick) this.applyEffect(pick, actor, ctx);
        return;
      }
      case 'summon': {
        // countScales means "summon COUNT equal to level" — scale by LEVEL ONLY (never the tier multiplier),
        // else Morel (tier 3) summons round(level×1.5) = 2/3/5 instead of 1/2/3. (Sweep 2026-09-13.)
        const cnt = effect.countScales ? (effect.count || 1) * (actor.level || 1) : (effect.count || 1);
        const team = this.teams[actor.side];
        const idx = team.indexOf(actor);
        // A LIVING summoner plants tokens BEHIND itself (higher index = further back); a FAINTING one (dead,
        // still in the array during the faint step) summons "in its place" — its own slot. Without this, a
        // living summoner (willow/podlet's "behind it") pushed the token to a LOWER index → it appeared in
        // FRONT of the summoner. `pos` may override explicitly. (Bug from feedback 2026-09-13.)
        const behind = effect.pos === 'behind' || (effect.pos !== 'front' && idx >= 0 && !actor.dead && actor.hp > 0);
        const slot = idx < 0 ? 0 : (behind ? idx + 1 : idx);
        const so = effect.atk != null ? { atk: this.scaled(effect.atk, actor, true), hp: this.scaled(effect.hp, actor, true) } : null;
        this.summon(effect.token, actor.side, slot, cnt, actor, so);
        return;
      }
      case 'move': {
        const team = this.teams[actor.side];
        const i = team.indexOf(actor);
        if (i < 0) return;
        team.splice(i, 1);
        if (effect.to === 'back') team.push(actor); else team.unshift(actor);
        this.emit({ t: 'move', uid: actor.uid, to: effect.to });
        return;
      }
      case 'skipAttack': {
        for (const t of this.targets(effect.target, actor, ctx)) { t.skipNextAttack = true; this.emit({ t: 'skip', uid: t.uid }); }
        return;
      }
      case 'gold': return; // shop-only; no-op in battle
      default: return;
    }
  }

  // Fire onFriendFaints for the fainting unit's living teammates.
  friendFaints(fainter) {
    for (const f of sortByAttackDesc(living(this.teams[fainter.side]), this.rng)) {
      if (f.ability && f.ability.trigger === 'onFriendFaints') this.fire(f, { triggerFriend: fainter });
    }
  }

  // Resolve all pending faints + hurts until the board is stable.
  settle() {
    let loops = 0;
    while (loops++ < 500) {
      // 1) collect newly fainted (hp<=0, not yet marked dead)
      const fainted = [];
      for (const side of [0, 1]) {
        this.teams[side].forEach((u) => { if (!u.dead && u.hp <= 0) { u.dead = true; fainted.push(u); } });
      }
      if (fainted.length) {
        for (const f of sortByAttackDesc(fainted, this.rng)) {
          this.emit({ t: 'faint', uid: f.uid, side: f.side });
          if (f.ability && f.ability.trigger === 'onFaint') this.fire(f);
          if (f.faintSummon) {
            const slot = this.teams[f.side].indexOf(f);
            this.summon(f.faintSummon.token, f.side, slot < 0 ? 0 : slot, f.faintSummon.count, f);
          }
          this.friendFaints(f);
        }
        // compact: physically remove the dead
        for (const side of [0, 1]) this.teams[side] = this.teams[side].filter((u) => !u.dead);
        // onFirstBlood: the FIRST faint of the whole battle wakes every living holder (both teams), once.
        if (!this.firstBloodDone) { this.firstBloodDone = true; this.fireLiving('onFirstBlood'); }
        continue; // re-loop to catch cascades (e.g. onFaint damage causing new faints)
      }
      // 2) no faints — process hurt triggers on survivors
      const hurt = [];
      for (const side of [0, 1]) this.teams[side].forEach((u) => { if (u._hurtPending) { u._hurtPending = false; hurt.push(u); } });
      if (hurt.length) {
        for (const h of sortByAttackDesc(hurt, this.rng)) {
          if (h.ability && h.ability.trigger === 'onHurt') this.fire(h);
        }
        continue; // hurt effects may cause damage → re-check faints
      }
      // 3) onLowHealth: any survivor now at/below HALF its starting HP fires once (a cornered-beast reaction)
      const low = [];
      for (const side of [0, 1]) for (const u of this.teams[side]) {
        if (!u.dead && u.hp > 0 && u.hp <= Math.floor(u.startHp / 2) && u.ability && u.ability.trigger === 'onLowHealth' && !u.onceUsed.onLowHealth) { u.onceUsed.onLowHealth = true; low.push(u); }
      }
      if (low.length) { for (const u of sortByAttackDesc(low, this.rng)) if (!u.dead) this.fire(u); continue; }
      break;
    }
  }

  // Fire a trigger on every LIVING unit on both teams, in descending-attack order (seeded ties).
  fireLiving(trigger, ctx) {
    const all = sortByAttackDesc(living(this.teams[0]).concat(living(this.teams[1])), this.rng);
    for (const u of all) if (!u.dead && u.ability && u.ability.trigger === trigger) this.fire(u, ctx);
  }

  firstStrike(u) {
    if (u.firstStrikeBonus > 0 && !u.firstStrikeUsed) { u.firstStrikeUsed = true; return u.firstStrikeBonus; }
    return 0;
  }

  // One attack round between the two front pets.
  attackStep() {
    // everyOtherRound: a repeating drumbeat on rounds 2, 4, 6… (round 1 skipped so it never overlaps
    // onStartBattle). Escalates a stalling fight; all living holders fire before the front units swing.
    this.combatRound = (this.combatRound || 0) + 1;
    if (this.combatRound % 2 === 0) { this.fireLiving('everyOtherRound'); this.settle(); }
    const a = living(this.teams[0])[0];
    const b = living(this.teams[1])[0];
    if (!a || !b) return;

    // before-attack (desc attack) — e.g. Sir Reginald honk. Gate on hp>0 so a unit sparked to 0 HP by an
    // earlier onBeforeAttack can't fire its own (and can't self-heal back to cancel the kill). (Sweep 2026-09-13.)
    for (const u of sortByAttackDesc([a, b], this.rng)) {
      if (u.ability && u.ability.trigger === 'onBeforeAttack' && !u.dead && u.hp > 0) this.fire(u);
    }

    // A unit at 0 HP (from an onBeforeAttack spark) deals no swing — it's about to faint in settle().
    const dmgA = (a.dead || a.hp <= 0) ? 0 : (a.skipNextAttack ? 0 : a.atk + this.firstStrike(a));
    const dmgB = (b.dead || b.hp <= 0) ? 0 : (b.skipNextAttack ? 0 : b.atk + this.firstStrike(b));
    a.skipNextAttack = false; b.skipNextAttack = false;

    this.emit({ t: 'attack', a: a.uid, b: b.uid, dmgA, dmgB });
    // simultaneous: compute both, then apply both
    const resToB = this.dealDamage(b, dmgA, a.uid, a.side); // a hits b
    const resToA = this.dealDamage(a, dmgB, b.uid, b.side); // b hits a

    // onKill — attacker survives and its target fainted
    if (resToB.fainted && a.hp > 0 && a.ability && a.ability.trigger === 'onKill') this.fire(a);
    if (resToA.fainted && b.hp > 0 && b.ability && b.ability.trigger === 'onKill') this.fire(b);

    // onAfterAttack — surviving attackers (e.g. Zip leaps back)
    for (const u of sortByAttackDesc([a, b], this.rng)) {
      if (u.hp > 0 && !u.dead && u.ability && u.ability.trigger === 'onAfterAttack') this.fire(u);
    }

    this.settle();
  }

  run() {
    // Start of battle (both teams, desc attack, random ties)
    this.emit({ t: 'startBattle', turnNo: this.turnNo, teams: this.snapshotTeams() });
    const starters = sortByAttackDesc([...this.teams[0], ...this.teams[1]].filter((u) => u.ability && u.ability.trigger === 'onStartBattle'), this.rng);
    // Gate on hp>0: a unit zeroed by an earlier starter's damage must not still fire its own onStartBattle.
    for (const u of starters) if (!u.dead && u.hp > 0) this.fire(u);
    this.settle();

    // Attack rounds
    while (this.guard++ < CONFIG.maxBattleTurns) {
      if (!living(this.teams[0]).length || !living(this.teams[1]).length) break;
      this.attackStep();
    }

    const aliveA = living(this.teams[0]).length;
    const aliveB = living(this.teams[1]).length;
    let result;
    if (aliveA > 0 && aliveB === 0) result = 'win';
    else if (aliveB > 0 && aliveA === 0) result = 'lose';
    else result = 'draw'; // mutual wipe or turn-cap
    this.emit({ t: 'end', result, aliveA, aliveB });
    return { result, log: this.log, aliveA, aliveB };
  }

  snapshotTeams() {
    return this.teams.map((team) => team.map((u) => ({
      uid: u.uid, defId: u.defId, name: u.name, level: u.level, atk: u.atk, hp: u.hp, side: u.side, isToken: u.isToken,
      tier: u.tier,   // scaling input: FUSED units aren't in CREATURE_BY_ID, so the client must be told the tier
      abilityText: u.ability ? u.ability.text : '',   // for the replay hold-for-ability tooltip (+ callouts)
      effect: u.ability ? u.ability.effect : null,    // effect tree → tooltip can render engine-exact scaled numbers for fusions
    })));
  }
}

// Public API: simulate a battle. teamA/teamB are arrays of persistent (shop) creatures.
// Returns { result: 'win'|'lose'|'draw' (from teamA's view), log, aliveA, aliveB }.
export function simulateBattle(teamA, teamB, seed = 1, turnNo = 1) {
  const b = new Battle(teamA, teamB, seed, turnNo);
  const res = b.run();
  // Keep-mode (permanent) buffs — e.g. Candela/Grudge/Vesper "kept between fights" — persist ONLY for the
  // units that SURVIVED, written back to the caller's squad afterwards (the srcRef write mid-battle used to
  // hit a throwaway snapshot and vanish). Aligned by the survivor's index in teamA (srcRef === that element).
  const keepDeltas = [];
  for (const uu of b.teams[0]) {
    if (uu.dead || uu.hp <= 0 || uu.isToken || !uu.srcRef || (!uu._keepAtk && !uu._keepHp)) continue;
    const i = teamA.indexOf(uu.srcRef);
    if (i >= 0) keepDeltas.push({ i, atk: uu._keepAtk || 0, hp: uu._keepHp || 0 });
  }
  res.keepDeltas = keepDeltas;
  return res;
}

// Trinklings — AI shopper bot.
//
// One component, three jobs (advisor's highest-leverage recommendation):
//   1. Build GHOST opponent teams for the single-player run (scaled to the turn).
//   2. Drive the BALANCE SIM (AI-vs-AI, thousands of runs) to find dead/dominant Trinklings (FB-R7).
//   3. Prove DEFAULT DIFFICULTY challenges a competent player (FB-R12) via measurable win rates.
//
// The AI drives the exact same GameState methods the human client does — no privileged path.

import { GameState } from '../src/game.js';
import { RNG } from '../src/rng.js';
import { CONFIG, CREATURE_BY_ID, FACTIONS } from '../src/data/creatures.js';

// Pick a random coalition of 2 factions (deterministic per seed).
export function randomCoalition(seed) { const r = new RNG((seed >>> 0) ^ 0x5eed1); return r.sample(FACTIONS.map((f) => f.key), CONFIG.coalitionSize || 2); }

// Position by ROLE, not raw HP: frontline bruisers/guardians up front (where they tank + trigger onHurt),
// payoff/backline pieces (faint, summon, snipers, economy, buffers) tucked behind. HP breaks ties.
const FRONT_SCORE = {
  guardian: 100, tank: 95, protect: 90, endure: 88, thorns: 80, pare: 70,     // want the front
  paradox: 55, lien: 40, chaos: 35, tempo: 30, gamble: 25, evolve: 20,        // middle-ish
  damage: 15, buff: 12, support: 10, scaler: 8, summoner: 6, summon: 5,        // want the back
  faint: 3, economy: 1,
};
function positionSquad(game) {
  const units = game.squad.filter(Boolean);
  units.sort((a, b) => {
    const ra = FRONT_SCORE[CREATURE_BY_ID[a.defId]?.role] ?? 50;
    const rb = FRONT_SCORE[CREATURE_BY_ID[b.defId]?.role] ?? 50;
    return (rb - ra) || (b.hp - a.hp) || (b.atk - a.atk);   // higher front-score = closer to front
  });
  const next = Array(CONFIG.squadSlots).fill(null);
  units.forEach((u, i) => { next[i] = u; });
  game.squad = next;
}

// Play one shop phase greedily. difficulty>=1 = plays well; <1 = plays a bit worse (weaker ghosts).
export function aiShop(game, difficulty = 1) {
  // Ghosts now keep developing after the board fills (was: stopped rerolling once full → dumped its gold).
  const rollBudget = difficulty >= 1 ? 5 : 2;

  const tryMerges = () => {
    for (let si = 0; si < game.shop.pets.length; si++) {
      const item = game.shop.pets[si];
      if (!item) continue;
      const slot = game.squad.findIndex((c) => c && c.defId === item.defId && c.xp < CONFIG.xpToL3);
      if (slot >= 0 && game.gold >= CONFIG.buyCost) game.buyPet(si, slot);
      if (game.pendingReward) game.chooseReward(0);
    }
  };

  // Draft value: tier + body + an ABILITY/synergy bonus so ghosts assemble kits, not just big vanilla stats.
  const draftScore = (d) => {
    let s = d.tier * 10 + (d.atk + d.hp);
    if (d.ability && d.ability.effect && d.ability.effect.type !== 'none') s += 4;          // an active kit
    const owned = game.squad.filter(Boolean);
    if (owned.some((c) => CREATURE_BY_ID[c.defId]?.faction === d.faction)) s += 2;           // faction synergy
    const summonEcho = ['summon','summoner','scaler'].includes(d.role);
    if (summonEcho && owned.some((c) => ['buff','summon','summoner'].includes(CREATURE_BY_ID[c.defId]?.role))) s += 3;
    return s;
  };
  const fillEmpties = () => {
    let guard = 0;
    while (game.gold >= CONFIG.buyCost && game.squad.includes(null) && guard++ < 12) {
      let best = -1, bestScore = -1;
      for (let si = 0; si < game.shop.pets.length; si++) {
        const item = game.shop.pets[si]; if (!item) continue;
        const score = draftScore(CREATURE_BY_ID[item.defId]);
        if (score > bestScore) { bestScore = score; best = si; }
      }
      if (best < 0) break;
      const slot = game.squad.indexOf(null);
      if (!game.buyPet(best, slot).ok) break;
    }
  };

  tryMerges();
  fillEmpties();

  // Keep spending: reroll to hunt merges (and fill any gaps) even with a FULL board, until the gold runs low.
  let rolls = 0;
  while (game.gold >= CONFIG.rollCost + Math.min(CONFIG.buyCost, CONFIG.snackCost) && rolls < rollBudget) {
    game.rollShop(false); rolls++;
    tryMerges(); fillEmpties();
    if (game.pendingReward) game.chooseReward(0);
    if (game.gold < CONFIG.buyCost && game.gold < CONFIG.snackCost) break;
  }

  // spend leftover gold on a snack for the front-line Trinkling
  if (game.gold >= CONFIG.snackCost) {
    const si = game.shop.snacks.findIndex((x) => x);
    if (si >= 0) { const front = game.squad.findIndex(Boolean); game.buySnack(si, front >= 0 ? front : 0); }
  }

  if (game.pendingReward) game.chooseReward(0);
  positionSquad(game);
}

// Advance the AI's own turn without a battle (used only for ghost construction).
function advanceNoBattle(game) {
  for (const c of game.livingSquad()) game.fireShop(c, 'onEndTurn');
  game.startTurn();
}

// Build a plausible opponent team as it would look at the start of `turn`.
export function buildAITeam(turn, seed, difficulty = 1, coalition = null) {
  const g = new GameState(seed, { ai: true, coalition: coalition || randomCoalition(seed) });
  for (let t = 1; t <= turn; t++) {
    aiShop(g, difficulty);
    if (t < turn) advanceNoBattle(g);
  }
  const team = g.squadForBattle();
  if (difficulty < 1 && team.length > 1) team.pop();                 // easier ghosts field one fewer
  else if (difficulty > 1) for (const u of team) { u.atk = Math.max(1, Math.round(u.atk * difficulty)); u.hp = Math.max(1, Math.round(u.hp * difficulty)); }  // harder ghosts hit harder (offline difficulty)
  return team;
}

export const generateGhostTeam = (turn, seed, difficulty = 1) => buildAITeam(turn, seed, difficulty);

// Play a whole run with the AI as the player vs ghost opponents. Returns the outcome.
export function runAIGame(seed, difficulty = 1, ghostDifficulty = 1, coalition = null) {
  const g = new GameState(seed, { coalition: coalition || randomCoalition(seed) });
  let guard = 0;
  while (g.status === 'shop' && guard++ < 60) {
    aiShop(g, difficulty);
    const ghost = generateGhostTeam(g.turn, (seed * 7 + g.turn * 131 + 977) >>> 0, ghostDifficulty);
    g.endTurn(ghost);
    if (g.status === 'shop') g.startTurn();
  }
  return { status: g.status, turns: g.turn, wins: g.wins, losses: g.losses, trophies: g.trophies, hearts: g.hearts };
}

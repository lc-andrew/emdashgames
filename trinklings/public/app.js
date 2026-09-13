// Trinklings — mobile web client. Tap-to-place shop, animated battle replay, teach-by-play.
import { GameState, unlockedTier } from '../src/game.js';
import { simulateBattle, resetUid } from '../src/engine.js';   // host resolves LOCAL P2P battles client-side
import { generateGhostTeam } from '../tools/ai.js';
import { CREATURE_BY_ID, SNACK_BY_ID, ALL_UNITS_BY_ID, CONFIG, FACTIONS } from '../src/data/creatures.js';
// NOTE: `snacks` / `SNACK_BY_ID` / `shopSnacks` are the code identifiers for what the UI calls "Items".

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---- world tints for art / card accents ----
const WORLD_COLOR = {
  Oathenveld: '#2f3a72', Skerrow: '#26364f', Oluvane: '#274a55', Tallowmar: '#3a2f66',
  Avarinth: '#332a63', Farrago: '#452a63', Writholm: '#2b3350', 'The Gainsay': '#3b2c66', 'The Meantide': '#22405e',
};
const tint = (w) => WORLD_COLOR[w] || '#1b2044';

// cohesive vinyl-toy UI icons (FB-R32)
const icon = (n) => `<img class="ic" src="assets/ui/${n}.png" alt="">`;

// rival trainers you face across a run (names only — no venue framing/commentary, per feedback)
const RIVALS = [
  { n: 'Pib', l: '“Bet you a marble I win!”' },
  { n: 'Odd Betty', l: '“My lot never lose. Mostly.”' },
  { n: 'Little Bram', l: '“Front row saved me the good ones.”' },
  { n: 'Thimble', l: '“Go on then — fight me.”' },
  { n: 'Wren of Row 9', l: '“The whole stand is watching!”' },
  { n: 'Dour Hal', l: '“…this won’t take long.”' },
  { n: 'Gilt-Tooth Nan', l: '“Grandma’s got tricks, dear.”' },
  { n: 'Coss', l: '“Traded up all week for this!”' },
  { n: 'the Snuff Twins', l: '“Two of us. Plenty of them.”' },
  { n: 'Marrow', l: '“Usher’s kid. I see everything.”' },
];

// ---- tiny procedural sound (no assets) ----
let AC = null, muted = localStorage.getItem('cc_mute') === '1';
let silentApply = false;   // true while Skip fast-forwards the replay synchronously → suppress the SFX burst
function beep(freq, dur = 0.08, type = 'sine', vol = 0.06) {
  if (muted || silentApply) return;
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type; o.frequency.value = freq; o.connect(g); g.connect(AC.destination);
    g.gain.setValueAtTime(vol, AC.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + dur);
    o.start(); o.stop(AC.currentTime + dur);
  } catch {}
}
// Sampled SFX (ElevenLabs-generated files in assets/audio) for the tactile progression moments —
// combine/fuse/level-up/buy. One reusable Audio per clip; muted honoured; failures are silent.
const _samples = {};
function playSample(name, vol = 0.55) {
  if (muted || silentApply) return;
  try {
    let a = _samples[name];
    if (!a) { a = _samples[name] = new Audio(`assets/audio/${name}.mp3`); a.preload = 'auto'; }
    a.volume = vol; a.currentTime = 0; a.play().catch(() => {});
  } catch {}
}
const SFX = {
  tap: () => beep(520, 0.05, 'triangle'),
  buy: () => playSample('buy', 0.5),
  merge: () => playSample('merge', 0.6),
  fuse: () => playSample('fuse', 0.62),
  attack: () => playSample('attack', 0.4),           // fires often → keep quiet
  hit: () => beep(180, 0.07, 'sawtooth', 0.05),      // invalid-action buzz (synth)
  faint: () => playSample('faint', 0.5),
  win: () => playSample('win', 0.6),
  lose: () => playSample('lose', 0.6),
  freeze: () => playSample('freeze', 0.55),
  // reward/ability schedule their chimes via setTimeout, so they must bail at CALL time during a Skip
  // fast-forward (else the deferred beeps fire after silentApply clears and bleed onto the result screen).
  reward: () => { if (silentApply) return; [784, 988, 1318].forEach((f, i) => setTimeout(() => beep(f, 0.12, 'triangle'), i * 90)); },
  ability: () => { if (silentApply) return; [988, 1319, 1760].forEach((f, i) => setTimeout(() => beep(f, 0.09, 'triangle', 0.05), i * 70)); },
  // distinct triumphant rise for a level-up / evolve moment
  levelup: () => playSample('levelup', 0.6),
};

// ---- music: a quiet ambient loop (Lingering Breeze) under menus/shop, plus a louder-energy but still
// quiet BATTLE loop (Fluteforge Frenzy) during a fight that cuts the instant a result shows. Both start on
// the first user gesture (autoplay is blocked) and follow the Sound toggle. ----
const bgm = document.getElementById('bgm');
const bgmBattle = document.getElementById('bgm-battle');
const AMBIENT_VOL = 0.3, BATTLE_VOL = 0.2;           // battle track quieter than the ambient bed
if (bgm) bgm.volume = 0;
if (bgmBattle) bgmBattle.volume = 0;
// iOS Safari historically IGNORES HTMLMediaElement.volume, so the music fades below would snap on iPhone.
// Route each track through the shared AudioContext via a GainNode (GainNode.gain DOES respond on iOS — it's
// why the synth beeps already fade). createMediaElementSource is once-per-element, guarded by the WeakMap.
const _musicGain = new WeakMap();
function musicGain(el) {
  if (!el) return null;
  if (_musicGain.has(el)) return _musicGain.get(el);
  let g = null;
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const src = AC.createMediaElementSource(el);
    g = AC.createGain(); g.gain.value = 0; src.connect(g); g.connect(AC.destination);
    el.volume = 1;   // the GainNode is the volume control now; keep the source at full pre-gain level
  } catch { g = null; }   // fall back to el.volume ramps (desktop) if the graph can't be built
  _musicGain.set(el, g);
  return g;
}
// smooth volume ramp so tracks EASE in/out instead of snapping (auto-plays if fading up from paused).
function fadeAudio(el, to, ms = 550) {
  if (!el) return; clearInterval(el._fade); clearTimeout(el._pauseT);
  if (AC && AC.state === 'suspended') AC.resume().catch(() => {});
  if (to > 0 && el.paused) { el.play().catch(() => {}); }
  const g = musicGain(el);
  if (g) {                                              // GainNode path (works on iOS + desktop)
    const now = AC.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, to)), now + Math.max(0.02, ms / 1000));
    if (to <= 0.001) el._pauseT = setTimeout(() => el.pause(), ms + 40);
    return;
  }
  if (to > 0 && el.paused) el.volume = 0;
  const from = el.volume, steps = 16; let i = 0;
  el._fade = setInterval(() => { i++; el.volume = Math.max(0, Math.min(1, from + (to - from) * i / steps)); if (i >= steps) { clearInterval(el._fade); if (to <= 0.001) el.pause(); } }, ms / steps);
}
// A looping track shouldn't hard-cut and restart — ease its volume DOWN over the last few seconds, then ease
// it back IN on the restart (per feedback). We drive the loop ourselves (loop=false) so the seam gets a fade:
// a tail-fade rides the GainNode to 0 WITHOUT pausing (so the element still fires 'ended'), then 'ended'
// seeks to 0 and fades back up to the track's target volume. Falls back to el.volume where there's no gain graph.
const FADE_TAIL = 3.2;   // seconds of fade-out at the end of the loop
function tailFade(el, ms) {
  const g = musicGain(el);
  if (g) { const now = AC.currentTime; g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + Math.max(0.05, ms / 1000)); return; }
  clearInterval(el._fade); const from = el.volume, steps = 16; let i = 0;   // desktop fallback — ramp, never pause
  el._fade = setInterval(() => { i++; el.volume = Math.max(0, from * (1 - i / steps)); if (i >= steps) clearInterval(el._fade); }, ms / steps);
}
function enableFadeLoop(el, targetVol) {
  if (!el) return;
  el.loop = false;                                  // we handle looping so the seam can fade
  el._targetVol = targetVol;
  el.addEventListener('timeupdate', () => {
    if (!el.duration || el.paused) return;
    const left = el.duration - el.currentTime;
    if (left > FADE_TAIL) { el._tailing = false; return; }
    if (el._tailing || muted) return;
    el._tailing = true; tailFade(el, left * 1000);  // ease down over exactly the time remaining
  });
  el.addEventListener('ended', () => {
    el._tailing = false; el.currentTime = 0;
    if (muted) return;
    el.play().catch(() => {});
    fadeAudio(el, el._targetVol, 1500);             // ease back in on the restart
  });
}
enableFadeLoop(bgm, AMBIENT_VOL);
enableFadeLoop(bgmBattle, BATTLE_VOL);
function startMusic() { if (muted) return; if (bgmBattle && !bgmBattle.paused) return; fadeAudio(bgm, AMBIENT_VOL, 850); }
function startBattleMusic() { fadeAudio(bgm, 0, 400); if (muted) return; if (bgmBattle) bgmBattle.currentTime = 0; fadeAudio(bgmBattle, BATTLE_VOL, 550); }
function stopBattleMusic() { fadeAudio(bgmBattle, 0, 450); if (!muted) fadeAudio(bgm, AMBIENT_VOL, 750); }
window.addEventListener('pointerdown', function once() { startMusic(); window.removeEventListener('pointerdown', once); }, { once: true });
// pause music when the window/tab loses focus, resume the same track when it returns (per feedback)
let _bgmWasOn = false, _battleWasOn = false;
function musicBlur() {
  _bgmWasOn = !!(bgm && !bgm.paused); _battleWasOn = !!(bgmBattle && !bgmBattle.paused);
  if (bgm) bgm.pause(); if (bgmBattle) bgmBattle.pause();
}
function musicFocus() {
  if (muted) return;
  if (_battleWasOn && bgmBattle) bgmBattle.play().catch(() => {});
  else if (_bgmWasOn && bgm) bgm.play().catch(() => {});
}
window.addEventListener('blur', musicBlur);
window.addEventListener('focus', musicFocus);
document.addEventListener('visibilitychange', () => (document.hidden ? musicBlur() : musicFocus()));

// short trigger → badge label (fall back to 'Ability' for triggers the data agent may add)
const TRIGGER_LABEL = {
  onStartBattle: 'Start', onHurt: 'Hurt', onFaint: 'Faint', onFriendFaints: 'Ally Down',
  onFriendSummoned: 'Summon', onEndTurn: 'Turn End', onStartTurn: 'Turn', onLevelUp: 'Level Up',
  onSell: 'Sell', onFriendBought: 'Buy', onBeforeAttack: 'Attack', onAfterAttack: 'On Hit', passive: 'Passive',
  onKill: 'Kill', onStartBattle2: 'Start', onFirstBlood: 'First Blood', onLowHealth: 'Half HP', everyOtherRound: 'Every 2nd Attack',
};

// Plain-language glossary of when each ability fires — shown in Settings ▸ "When abilities trigger".
// Keyed to TRIGGER_LABEL so the wording here matches the tag printed on every card. Only the triggers the
// roster actually uses are listed. (Verified in-engine by simulating each — tools sim, 2026-09-13.)
const TRIGGER_GLOSSARY = [
  // Two rules that apply to EVERY trigger, called out first (matches engine.js: sortByAttackDesc + once:'battle').
  { note: 'order', label: 'Who goes first', text: 'When several Trinklings share the same moment, the one with the highest <b>⚔ Attack</b> acts first — ties are broken at random.' },
  { note: 'limit', label: 'Limits', text: "Some abilities fire only once per fight (or once per turn). Whenever there's a limit, it's written right on that Trinkling's card." },
  { section: 'During a battle — an “attack” is the two front Trinklings trading blows' },
  { trig: 'onStartBattle', when: 'The instant the fight begins, before anyone attacks.' },
  { trig: 'onBeforeAttack', when: 'Just before this Trinkling swings — every time it attacks.' },
  { trig: 'onAfterAttack', when: 'Right after it swings, if it lived through the clash.' },
  { trig: 'onHurt', when: 'Each time it takes damage and survives. (A few cards limit this to the first hit — they say so.)' },
  { trig: 'onLowHealth', when: 'The first time it drops to half its starting health or below — once per fight.' },
  { trig: 'onKill', when: 'Whenever its attack knocks out an enemy.' },
  { trig: 'onFirstBlood', when: 'On the very first faint of the whole fight, friend or foe — once per fight.' },
  { trig: 'onFaint', when: 'As it faints and leaves the lane.' },
  { trig: 'onFriendFaints', when: 'Each time another Trinkling on your side faints. (A few cards limit this to the first — they say so.)' },
  { trig: 'onFriendSummoned', when: 'When a token or new Trinkling appears on your side mid-fight.' },
  { trig: 'everyOtherRound', when: 'Every second attack, once the front line has started trading blows.' },
  { trig: 'passive', when: 'Always on — an ongoing effect, no moment needed.' },
  { section: 'Back in the shop' },
  { trig: 'onStartTurn', when: 'At the start of each shop turn (often a little bonus gold).' },
  { trig: 'onFriendBought', when: 'When you buy another Trinkling.' },
  { trig: 'onLevelUp', when: 'When three combine and it reaches a new level.' },
  { trig: 'onSell', when: 'When you sell it.' },
  { trig: 'onEndTurn', when: 'When you press End Turn, just before the fight starts.' },
];

function openTriggers() {
  SFX.tap();
  const body = $('#triggersBody'); body.innerHTML = '';
  TRIGGER_GLOSSARY.forEach((e) => {
    if (e.note) {
      const n = document.createElement('div'); n.className = 'trig-note';
      n.innerHTML = `<span class="trig-note-lbl">${e.label}</span><span class="trig-note-txt">${e.text}</span>`;
      body.appendChild(n); return;
    }
    if (e.section) {
      const h = document.createElement('div'); h.className = 'trig-sec'; h.textContent = e.section;
      body.appendChild(h); return;
    }
    const row = document.createElement('div'); row.className = 'trig-row';
    row.innerHTML = `<span class="trig-tag">${TRIGGER_LABEL[e.trig] || e.trig}</span><span class="trig-when">${e.when}</span>`;
    body.appendChild(row);
  });
  body.scrollTop = 0;
  $('#triggersModal').hidden = false;
}

// ---- game state ----
let game = null;
let easy = false;
let runSeed = 1;
let runCoalition = null;
let sel = null;           // selection SOURCE: {kind:'shopPet'|'shopSnack'|'squad', index}
let selTarget = null;     // selection TARGET: {kind:'squad', index} — set when acting ONTO an occupied slot,
                          // so combine/fuse/swap/feed wait for an explicit tap of the #actionBtn (no accidental fuses)
let coachStep = 0;        // teach-by-play progression
let lastCoachTier = 1;    // highest tier we've announced an unlock for
let tierMsgTurn = 0;      // turn on which to keep showing the tier-unlock line (sticky across re-renders)
let hasBought = false;
let pendingEvolve = null;  // {slot, level} — a card that just leveled up, to animate after render()
let pendingMerge = null;   // {slot} — a card that just merged (no level-up), to burst after render()
let pendingFuse = null;    // {slot} — two different types just fused into a new pet, to burst after render()
let suppressReward = false; // hold the level-up reward modal until the evolve burst finishes
// The defId currently "held" by the selection — used to light up merge targets (shop card + squad slot).
function selectedDefId() {
  if (!sel) return null;
  if (sel.kind === 'shopPet') return game.shop.pets[sel.index]?.defId;
  if (sel.kind === 'squad') return game.squad[sel.index]?.defId;
  return null;
}
// True if a squad Trinkling of this type exists and can still take a merge (not yet max level).
function ownedMergeable(defId) {
  return game.squad.some((c) => c && c.defId === defId && (c.xp || 0) < CONFIG.xpToL3);
}

// ---- screen switching ----
function show(id) { if (id !== 'battle' && typeof stopBattleMusic === 'function') stopBattleMusic(); $$('.screen').forEach((s) => s.classList.remove('show')); $('#' + id).classList.add('show'); }

// ---- art markup (with graceful fallback if the PNG isn't there yet) ----
function artHTML(defId, level = 1) {
  // FUSED units carry their two parent art bases in the defId ('fus:artA~artB') — composite them.
  if (typeof defId === 'string' && defId.startsWith('fus:')) {
    const key = defId.slice(4);                 // 'artA~artB' (already sorted in fuseUnit)
    const [a, b] = key.split('~');
    // Prefer the BESPOKE fused artwork (fus_<a>~<b>.png). If it isn't generated yet, the img errors and we
    // fall back to compositing the two parent halves — so fusions always render something.
    return `<div class="art fused">
      <img class="fused-solo" src="assets/creatures/fus_${key}.png" alt="" onerror="this.remove(); this.parentElement.classList.add('composite')">
      <img class="fa" src="assets/creatures/${a}.png" alt="" onerror="this.style.opacity=0">
      <img class="fb" src="assets/creatures/${b}.png" alt="" onerror="this.style.opacity=0">
      <span class="fuse-spark">✦</span>
    </div>`;
  }
  const u = ALL_UNITS_BY_ID[defId];
  const initial = (u?.name || '?').replace('Sir ', '')[0];
  const base = `assets/creatures/${defId}.png`;
  // Level-appropriate art: L2/L3 are subtle image-edits of the base (glow/gem → radiant/crown). If a
  // variant PNG is missing, fall back to the base art; if that's missing too, show the letter tile.
  const src = level >= 3 ? `assets/creatures/${defId}_l3.png`
            : level >= 2 ? `assets/creatures/${defId}_l2.png` : base;
  return `<div class="art" style="--tint:${tint(u?.world)}">
    <img src="${src}" data-base="${base}" alt="${u?.name || ''}"
         onerror="if(this.src.indexOf('_l')>-1){this.src=this.dataset.base}else{this.remove();this.parentElement.querySelector('.initial').style.display='flex'}">
    <span class="initial" style="display:none;background:radial-gradient(circle at 50% 35%,#fff6,${tint(u?.world)});position:absolute;inset:0;border-radius:10px;align-items:center;justify-content:center">${initial}</span>
  </div>`;
}
// Level indicator: a "Lv" tag + two groups of segments showing progress to L2 then L3 (group sizes derived
// from CONFIG so it stays correct). Owned units carry `xp`; shop/reward previews don't → show the tag only.
// Level shown ONLY as two groups of rounded segments (no tier chip, no "Lv" text). Groups sized from
// CONFIG (progress to L2 then L3), filled by xp. Previews (shop/reward) are L1 → empty groups.
function levelIndicatorHTML(c) {
  const g1 = CONFIG.xpToL2, g2 = CONFIG.xpToL3 - CONFIG.xpToL2;
  const lvl = c.level || 1;
  const xp = c.xp !== undefined ? (c.xp || 0) : (lvl >= 3 ? g1 + g2 : lvl >= 2 ? g1 : 0);
  const seg = (n, f) => Array.from({ length: n }, (_, i) => `<i class="${i < f ? 'on' : ''}"></i>`).join('');
  return `<div class="lvl${lvl >= 3 ? ' max' : ''}"><span class="lvgrp">${seg(g1, Math.min(xp, g1))}</span><span class="lvgrp">${seg(g2, Math.max(0, xp - g1))}</span></div>`;
}
function lvlPips(level) { return levelIndicatorHTML({ level }); }   // back-compat
// Visual evolution: a leveled Trinkling looks distinctly stronger. L2 → a silver ring/glow; L3 → an
// amethyst aura + crown mark (+ a slight scale on shop/squad cards). Reused on shop/squad AND battle cards.
function evoClass(level) { return level >= 3 ? ' evo3' : level >= 2 ? ' evo2' : ''; }
// Level-progress bar under a card. Derived from the unit's xp + CONFIG thresholds (never hardcoded copy
// counts) so it stays correct if xpToL2/xpToL3 change. Only owned units carry `xp`; shop/reward preview
// objects don't, so the bar naturally appears only on squad cards.
function xpBarHTML(c) {
  if (!c || c.xp === undefined) return '';
  const xp = c.xp || 0;
  if (xp >= CONFIG.xpToL3) return `<div class="xpbar max"><span class="xp-lbl">MAX ✦</span></div>`;
  let nextLvl, cur, need;
  if ((c.level || 1) >= 2) { nextLvl = 3; cur = xp - CONFIG.xpToL2; need = CONFIG.xpToL3 - CONFIG.xpToL2; }
  else { nextLvl = 2; cur = xp; need = CONFIG.xpToL2; }
  need = Math.max(1, need);
  const pct = Math.max(0, Math.min(100, Math.round((cur / need) * 100)));
  return `<div class="xpbar"><div class="xp-fill" style="width:${pct}%"></div><span class="xp-lbl">Lv${nextLvl} · ${cur}/${need}★</span></div>`;
}

// ---- render ----
function render() {
  if (!game) return;
  const v = game.view();
  $('#hudTurn').textContent = v.turn;
  $('#hudGold').textContent = v.gold;
  $('#hudHearts').textContent = v.hearts;
  $('#hudTrophies').textContent = v.trophies;
  $('#tierTag').textContent = 'Tier ' + v.unlockedTier;
  $('#game').classList.toggle('duel', duelMode);
  renderSquad(); renderShop();
  if (duelMode) renderDuelHeader(); else renderCoach();
  renderCardDetail();   // tap-to-detail: full ability/flavor for the selected card (cards themselves stay clean)
  // ONE contextual action slot: Sell (a squad pet selected) OR Freeze (a shop item selected) — never both,
  // so the bar stays [Roll][contextual][End Turn] and never overflows.
  const sb = $('#sellBtn'), fb = $('#freezeBtn'), ab = $('#actionBtn'), swb = $('#swapBtn');
  const pend = pendingAction();
  const shopSel = sel && (sel.kind === 'shopPet' || sel.kind === 'shopSnack') && (sel.kind === 'shopPet' ? game.shop.pets : game.shop.snacks)[sel.index];
  // a swap alternative is offered whenever two SQUAD pets are paired for a Combine/Fuse (so the player can
  // reorder instead of combining) — not shown when the only action already IS a swap.
  const canSwap = pend && pend.kind === 'move' && pend.label !== 'Swap' && sel.kind === 'squad';
  if (swb) swb.hidden = !canSwap;
  if (pend) {   // source + occupied target chosen → the explicit Combine/Fuse/Swap/Feed confirm
    ab.hidden = false; sb.hidden = true; if (fb) fb.hidden = true; disarmSell();
    // every action carries its own cost now (Fuse 10, Feed 2, shop-Combine 3, shop-Fuse 13) — show it + gate.
    const cost = pend.cost || 0;
    $('#actionLbl').innerHTML = pend.label + (cost ? ` <span class="cost"><img class="ic" src="assets/ui/coin.png" alt="">${cost}</span>` : '');
    ab.disabled = cost > 0 && game.gold < cost;
  } else if (sel && sel.kind === 'squad' && game.squad[sel.index]) {
    ab.hidden = true; sb.hidden = false; if (fb) fb.hidden = true; $('#sellVal').textContent = game.squad[sel.index].level;
    if (sellArmed && sellArmIndex !== sel.index) disarmSell();
    else if (!sellArmed) { sb.classList.remove('armed'); $('#sellLbl').textContent = 'Sell'; }
  } else if (shopSel && fb) {
    ab.hidden = true; fb.hidden = false; sb.hidden = true; disarmSell();
    $('#freezeLbl').textContent = shopSel.frozen ? 'Unfreeze' : 'Freeze'; fb.classList.toggle('on', !!shopSel.frozen);
  } else { ab.hidden = true; sb.hidden = true; if (fb) fb.hidden = true; disarmSell(); }
  $('#rollBtn').disabled = game.gold < CONFIG.rollCost;
  { const rb = $('#replayBtn'); if (rb) rb.hidden = !game.lastBattle; }   // ↺ appears once there's a battle to rewatch
  // A freshly-merged card leveled up: play the evolve burst now that the squad DOM is rebuilt,
  // then let playEvolve release the reward modal when the animation ends.
  if (pendingEvolve) { const pe = pendingEvolve; pendingEvolve = null; pendingMerge = null; pendingFuse = null; playEvolve(pe.slot, pe.level); }
  else if (pendingFuse) { const pf = pendingFuse; pendingFuse = null; pendingMerge = null; playFuseBurst(pf.slot); }
  else if (pendingMerge) { const pm = pendingMerge; pendingMerge = null; playMergeBurst(pm.slot); }
  if (game.pendingReward && !suppressReward) openReward();
}

// Queue a satisfying evolve burst on the card at `slot` (plays on the next render).
function queueEvolve(slot, level) { pendingEvolve = { slot, level }; suppressReward = true; }
function playEvolve(slot, level) {
  const squadEl = $('#squad');
  const card = squadEl && squadEl.children[slot];
  const done = () => { suppressReward = false; if (game && game.pendingReward) openReward(); };
  if (!card) { done(); return; }
  SFX.levelup();
  card.classList.add('evolving');
  const ring = document.createElement('div'); ring.className = 'evolve-ring'; card.appendChild(ring);
  const lbl = document.createElement('div'); lbl.className = 'evolve-label';
  lbl.textContent = level >= 3 ? 'MAX! ✦' : 'LEVEL UP!';
  card.appendChild(lbl);
  sparkleBurst(card, 14); shockwaveRing(card, "violet");
  setTimeout(() => { card.classList.remove("evolving"); ring.remove(); lbl.remove(); done(); }, 900);
}
// A merge that didn't cross a level threshold still deserves a beat: a quick "COMBINED!" pop + stat-bump
// float so every combine feels like progress (the level-up burst above handles threshold crossings).
function playMergeBurst(slot) {
  const card = $('#squad') && $('#squad').children[slot];
  if (!card) return;
  SFX.merge();
  card.classList.add('merging');
  const lbl = document.createElement('div'); lbl.className = 'merge-label';
  lbl.innerHTML = `COMBINED! <b>+${CONFIG.combineStat}/+${CONFIG.combineStat}</b>`;
  card.appendChild(lbl);
  sparkleBurst(card, 10); shockwaveRing(card, 'gold');
  setTimeout(() => { card.classList.remove('merging'); lbl.remove(); }, 720);
}
// A fusion of two DIFFERENT pets into a new one — a bigger, distinct celebration than a same-type merge.
// CINEMATIC fusion (per feedback): the card is caught in a spinning energy vortex, a light beam erupts, a
// white flash peaks, then the new fused Trinkling is revealed with a golden shockwave + sparkles + label.
function playFuseBurst(slot) {
  const card = $('#squad') && $('#squad').children[slot];
  if (!card) return;
  SFX.fuse();
  card.classList.add('evolving', 'fusing-cine');
  const add = (cls) => { const d = document.createElement('div'); d.className = cls; card.appendChild(d); return d; };
  const vortex = add('fuse-vortex'), beam = add('fuse-beam'), flash = add('fuse-flash'), ring = document.createElement('div');
  ring.className = 'evolve-ring fuse-ring'; card.appendChild(ring);
  const els = [vortex, beam, flash, ring];
  setTimeout(() => { SFX.levelup(); sparkleBurst(card, 24); shockwaveRing(card, 'gold'); shockwaveRing(card, 'violet');   // reveal burst at the flash peak
    const lbl = document.createElement('div'); lbl.className = 'evolve-label fuse-label'; lbl.textContent = '✦ FUSED! ✦'; card.appendChild(lbl); els.push(lbl);
  }, 560);
  setTimeout(() => { card.classList.remove('evolving', 'fusing-cine'); els.forEach((e) => e.remove()); }, 1550);
}
// A burst of sparkle particles flying out from a card — juice for merge/fuse/level-up moments.
function sparkleBurst(card, n = 10) {
  const box = document.createElement('div'); box.className = 'spark-burst';
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    const ang = (i / n) * 360 + (i * 47 % 23);
    const dist = 26 + (i * 13 % 20);
    s.style.setProperty('--dx', `${Math.cos(ang * Math.PI / 180) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(ang * Math.PI / 180) * dist}px`);
    s.style.animationDelay = `${(i % 5) * 20}ms`;
    box.appendChild(s);
  }
  card.appendChild(box);
  setTimeout(() => box.remove(), 900);
}
// NEW merged-pet effect: an expanding shockwave ring + a quick radiant flash on the card.
function shockwaveRing(card, hue = 'gold') {
  const r = document.createElement('div'); r.className = 'shockwave ' + hue; card.appendChild(r);
  card.classList.add('flash-pulse');
  setTimeout(() => { r.remove(); card.classList.remove('flash-pulse'); }, 640);
}

// Derive the LEVEL-SCALED ability description straight from the ability.effect object — never by
// blindly multiplying digits in the copy (that re-creates text↔effect lies). We compute each scalable
// magnitude's base→scaled value and substitute it into the authored text in effect order, mirroring
// engine.js scaling EXACTLY: buff/damage/shield/steal/gold magnitudes ×level (unless effect.noScale or
// amount==='selfAtk'); summon token stats NEVER scale (count only via countScales, which the copy
// renders as "equal to its level" — no number to touch); chance scales the branch magnitudes (its
// probability is never stated numerically in copy); multi/randomEffect recurse. Anything we can't
// cleanly map → return null so the caller falls back to base text + a "Lv{n}" chip.
// abOverride/tierOverride: for FUSED units (defId 'fus:…') and any unit NOT in CREATURE_BY_ID — pass the
// snapshot's { text, effect } ability + its tier so battle tooltips scale exactly like the engine does.
const SHOP_TRIGS = new Set(['onStartTurn', 'onEndTurn', 'onSell', 'onFriendBought', 'onLevelUp', 'onBuy', 'onFriendSold']);
export function scaledAbilityText(defId, level, abOverride, tierOverride) {
  const ab = abOverride || CREATURE_BY_ID[defId]?.ability;
  if (!ab || !ab.text) return '';
  // SHOP-phase effects are applied by game.js at ×1 (the anti-scaler-stack guard), so their text must NOT be
  // inflated by level/tier — only BATTLE effects scale. (QA: shop perm-buff text over-stated the applied value.)
  if (ab.trigger && SHOP_TRIGS.has(ab.trigger)) return ab.text;
  level = level || 1;
  // Mirror engine.js scaled(base, actor) EXACTLY: round(base * level * tierMult), tierMult=1+(tier-1)*0.25.
  const tier = (tierOverride != null ? tierOverride : CREATURE_BY_ID[defId]?.tier) || 1;
  const tierMult = 1 + ((tier - 1) * 0.25);
  const mag = (base) => Math.round(base * level * tierMult);
  if (level <= 1 && tier <= 1) return ab.text;   // only truly unscaled at level 1, tier 1
  let text = ab.text, ok = true;
  // Try each [regex, replacement] in order; the first whose base literal is present wins. `global`
  // replaces every occurrence (for one effect the copy mentions twice, e.g. a steal's "loses X / gains X").
  // We anchor on the BASE integer literal, so an already-scaled number (a different value) is never
  // re-matched, and word/lookahead boundaries stop a base from matching inside a larger number.
  const sub = (patterns, global) => {
    for (const [re, rep] of patterns) {
      if (re.test(text)) { text = text.replace(global ? new RegExp(re.source, 'g') : re, rep); return true; }
    }
    ok = false; return false;
  };
  const walk = (e) => {
    if (!e || e.type === 'none') return;
    switch (e.type) {
      case 'multi': case 'randomEffect': e.effects.forEach(walk); return;
      case 'chance': if (e.then) walk(e.then); if (e.else) walk(e.else); return;
      case 'summon': case 'guard': case 'move': case 'skipAttack': case 'swapStats': return; // no scalable copy
      case 'gold': {
        if (e.amount == null) return;
        const s = mag(e.amount);
        sub([[new RegExp(`\\b${e.amount}\\b(?=\\s*gold)`), `${s}`]]);
        return;
      }
      case 'shield': {
        if (e.noScale || e.amount == null) return;
        const b = e.amount, s = mag(b);
        sub([
          [new RegExp(`\\b${b}-HP shield`), `${s}-HP shield`],
          [new RegExp(`shield up ${b}\\b`), `shield up ${s}`],
          [new RegExp(`\\b${b}-HP`), `${s}-HP`],
        ]);
        return;
      }
      case 'damage': {
        if (e.amount === 'selfAtk' || e.noScale || e.amount == null) return;
        const b = e.amount, s = mag(b);
        sub([
          [new RegExp(`deal ${b} damage`), `deal ${s} damage`],
          [new RegExp(`deal ${b} to`), `deal ${s} to`],
          [new RegExp(`dealing ${b}\\b`), `dealing ${s}`],
          [new RegExp(`for ${b}\\b`), `for ${s}`],
          [new RegExp(`take ${b} damage`), `take ${s} damage`],
          [new RegExp(`\\b${b} damage`), `${s} damage`],
          [new RegExp(`\\bdeal ${b}\\b`), `deal ${s}`],
        ]);
        return;
      }
      case 'buff': case 'steal': {
        if (e.noScale) return;
        const A = Math.abs(e.atk || 0), H = Math.abs(e.hp || 0);
        const sA = mag(A), sH = mag(H), global = e.type === 'steal';
        if (A && H) {
          sub([
            [new RegExp(`\\+${A}\\/\\+${H}`), `+${sA}/+${sH}`],
            [new RegExp(`-${A}\\/-${H}`), `-${sA}/-${sH}`],
            [new RegExp(`\\b${A}\\/${H}\\b`), `${sA}/${sH}`],
          ], global);
        } else if (A) {
          sub([
            [new RegExp(`\\+${A}\\/\\+0`), `+${sA}/+0`],
            [new RegExp(`-${A}\\/\\+0`), `-${sA}/+0`],
            [new RegExp(`\\+${A}(?=\\s*(attack|atk))`), `+${sA}`],
            [new RegExp(`\\b${A}(?=\\s*attack)`), `${sA}`],
          ], global);
        } else if (H) {
          sub([
            [new RegExp(`\\+0\\/\\+${H}`), `+0/+${sH}`],
            [new RegExp(`\\+0\\/-${H}`), `+0/-${sH}`],
            [new RegExp(`\\b${H}(?=\\s*(health|HP))`), `${sH}`],
          ], global);
        }
        return;
      }
      default: return;
    }
  };
  walk(ab.effect);
  return ok ? text : null;
}

// The trigger BADGE already names WHEN an ability fires, so strip a duplicate "Trigger: " prefix from the
// text (e.g. "Start of fight: give…" → badge[Start] + "Give…") — no more "Start … Start" double-up.
function abilityEffect(t) { t = t || ''; const i = t.indexOf(': '); const s = i >= 0 ? t.slice(i + 2) : t; return s ? s[0].toUpperCase() + s.slice(1) : s; }
function abilityLineHTML(defId, level = 1) {
  const ab = CREATURE_BY_ID[defId]?.ability;         // tokens have no ability → skip
  if (!ab || !ab.text) return '';
  const label = TRIGGER_LABEL[ab.trigger] || 'Ability';
  let txt = ab.text, chip = '';
  if (level > 1) {
    const scaled = scaledAbilityText(defId, level);
    if (scaled) txt = scaled;                                  // leveled numbers substituted in
    else chip = ` <span class="lvchip">Lv${level}</span>`;     // shape we can't cleanly scale → mark it
  }
  return `<div class="card-abil"><span class="trig-badge">${label}</span><span class="abil-txt">${abilityEffect(txt)}${chip}</span></div>`;
}
// SAP-style tier chip (T1..T6). Works for BOTH Trinklings (CREATURE_BY_ID) and Items (SNACK_BY_ID) —
// items are tier-gated (they surface as the shop tier climbs), so the badge makes that visible on item
// cards too. Tokens have no tier → '' (skipped).
function tierChip(t) { return t ? `<span class="tierbadge t${t}" title="Tier ${t}">${t}</span>` : ''; }  // single number
function tierBadgeHTML(defId) { return tierChip((CREATURE_BY_ID[defId] || SNACK_BY_ID[defId])?.tier); }
const unitTier = (c) => c?.fused ? c.fused.tier : (CREATURE_BY_ID[c?.defId] || {}).tier;   // fused carry own tier
// HEAVILY SIMPLIFIED card: art + tier number + name + level dots + stats. NO ability text (shown on tap
// via the detail panel), no xp bar (dots carry the level). Keeps cards clean and word-spill-free.
function creatureCardHTML(c, extra = '') {
  return `<div class="art-wrap">${artHTML(c.defId, c.level)}</div>
    ${levelIndicatorHTML(c)}
    ${c.snacks?.length ? `<span class="snackpip">${c.snacks.map((s) => SNACK_BY_ID[s] ? `<img class="pip-ic" src="assets/items/${s}.png" alt="${SNACK_BY_ID[s].name}">` : '').join('')}</span>` : ''}
    <div class="stats"><span class="stat">${c.atk} / ${c.hp}</span></div>${extra}`;
}

function renderSquad() {
  const el = $('#squad'); el.innerHTML = '';
  for (let i = 0; i < CONFIG.squadSlots; i++) {
    const c = game.squad[i];
    const d = document.createElement('div');
    if (!c) { d.className = 'card empty' + (sel && sel.kind !== 'shopSnack' ? ' drop-target' : ''); d.dataset.slot = i; d.onclick = () => onSquadTap(i); }
    else {
      // Light up this slot as a merge target when the held selection is a same-type, non-max copy.
      const selId = selectedDefId();
      const self = sel && sel.kind === 'squad' && sel.index === i;
      const armed = selTarget && selTarget.index === i;                                 // chosen target, awaiting confirm
      const heldFused = sel && sel.kind === 'squad' && game.squad[sel.index]?.fused;   // a fused held unit can't combine
      const canCombine = !c.fused && !heldFused;                                        // only BASE ↔ BASE combines
      const isMergeTarget = canCombine && selId && c.defId === selId && (c.xp || 0) < CONFIG.xpToL3 && !self;
      // holding one of YOUR base units over a DIFFERENT base unit → fuse into a new pet
      const isFuseTarget = canCombine && !isMergeTarget && !self && sel && (sel.kind === 'squad' || sel.kind === 'shopPet') && selId && c.defId !== selId;
      d.className = 'card t' + (unitTier(c) || 1) + evoClass(c.level) + (self ? ' selected' : '') + (armed ? ' target-armed' : '') + (isMergeTarget ? ' mergeable' : '') + (isFuseTarget ? ' fusable' : '') + (c.fused ? ' is-fused' : '');
      // no on-card action text — the amber/green target glow + the bottom confirm button convey Combine/Fuse
      d.innerHTML = creatureCardHTML(c);
      d.dataset.slot = i;
      d.onclick = () => onSquadTap(i);
      d.addEventListener('pointerdown', (e) => dragStart(e, { kind: 'squad', index: i }));   // drag SOURCE (alt to tap; onclick still handles taps)
    }
    el.appendChild(d);
  }
}

function renderShop() {
  const petEl = $('#shopPets'); petEl.innerHTML = '';
  game.shop.pets.forEach((item, i) => {
    const d = document.createElement('div');
    if (!item) { d.className = 'card empty'; petEl.appendChild(d); return; }
    const def = CREATURE_BY_ID[item.defId];
    const mergeable = ownedMergeable(item.defId);   // you already own one that can still combine
    d.className = 'card t' + (def.tier || 1) + (sel && sel.kind === 'shopPet' && sel.index === i ? ' selected' : '') + (item.frozen ? ' frozen' : '') + (mergeable ? ' has-merge' : '');
    d.innerHTML = `${item.free ? '<span class="price pet-price">FREE</span>' : ''}
      ${item.frozen ? `<span class="frozen-badge">${icon('snowflake')}</span>` : ''}
      ${mergeable ? '<span class="merge-badge" title="You own one — buy to combine">✦</span>' : ''}
      ${creatureCardHTML({ defId: item.defId, name: def.name, level: 1, atk: def.atk, hp: def.hp })}`;
    d.onclick = () => onShopPetTap(i);
    d.addEventListener('pointerdown', (e) => dragStart(e, { kind: 'shopPet', index: i }));   // drag SOURCE (alt to tap)
    petEl.appendChild(d);
  });
  const snkEl = $('#shopSnacks'); snkEl.innerHTML = '';
  game.shop.snacks.forEach((item, i) => {
    const d = document.createElement('div');
    if (!item) { d.className = 'card empty'; snkEl.appendChild(d); return; }
    const s = SNACK_BY_ID[item.defId];
    d.className = 'card t' + (s.tier || 1) + (sel && sel.kind === 'shopSnack' && sel.index === i ? ' selected' : '') + (item.frozen ? ' frozen' : '');
    // item card shows ONLY the art — its tier + name appear in the tap-detail panel once selected
    d.innerHTML = `${item.frozen ? `<span class="frozen-badge">${icon('snowflake')}</span>` : ''}
      <div class="art-wrap"><div class="art"><img src="assets/items/${item.defId}.png" alt="${s.name}"></div></div>`;
    d.onclick = () => onShopSnackTap(i);
    d.addEventListener('pointerdown', (e) => dragStart(e, { kind: 'shopSnack', index: i }));   // drag SOURCE (alt to tap)
    snkEl.appendChild(d);
  });
}

// ---- teach-by-play coach ----
const COACH = [
  'Welcome! Tap a Trinkling in the <b>Shop</b>, then tap an empty <b>squad</b> slot to buy it (3<img class="ic" src="assets/ui/coin.png" alt=" gold">).',
  'Every Trinkling has an <b>ability</b> — <b>tap</b> it to read it. Then hit <b>End Turn</b> to fight.',
  // copies-to-combine derived from CONFIG: a fresh copy adds 1 xp on merge, so Lv2 needs xpToL2 + 1 copies.
  `Tip: buy <b>${CONFIG.xpToL2 + 1} of the same</b> Trinkling to <b>combine</b> them — bigger stats + stronger ability, and it <b>levels up</b>!`,
  'Tip: <b>Reroll</b> the shop for new Trinklings, or tap a shop item and hit <b>Freeze</b> to keep it next turn (free).',
  'Tip: 🍎 <b>Items</b> give permanent boosts — tap an item, then tap who gets it.',
  'Tip: 💸 tap one of your Trinklings, then <b>Sell</b> to turn it back into gold.',
];
// Turn 6+ rotation — always something helpful & flavourful on screen (FB: coach went silent past turn 5).
const LIVE_TIPS = [
  'Tip: your <b>rightmost ▶</b> Trinkling fights first — keep a tough body on the right to shield the fragile ones behind it.',
  'Tip: combining copies levels the <b>ability</b>, not just the stats — one Lv3 Trinkling outpunches three Lv1s.',
  'Tip: tap a strong shop Trinkling you can’t afford yet and hit <b>Freeze</b> — it waits for you next turn, free.',
  'Tip: 🍎 <b>Items</b> are permanent — feed them to a Trinkling you plan to keep all run.',
  'Tip: gold <b>doesn’t carry over</b> — spend it all before you End Turn.',
  'Tip: watch which of the rival’s Trinklings strikes first in the fight, then <b>reorder</b> yours to answer it next turn.',
];
function liveCoachLine() {
  // react to state first, then fall back to a rotating tip
  if (game.hearts <= 2) return `❤️ Only <b>${game.hearts}</b> heart${game.hearts === 1 ? '' : 's'} left — play safe. A solid <b>front line</b> soaks the early hits.`;
  if (game.trophies >= 7) return `🏆 <b>${game.trophies}/10</b> wins — the Cup is close! Keep your combos tight and finish strong.`;
  const maxed = game.livingSquad().find((c) => (c.xp || 0) >= CONFIG.xpToL3);
  if (maxed) return `✦ <b>${maxed.name}</b> is <b>maxed</b> — its ability is at full power. Build the rest of your line around it.`;
  if (game.wins >= 3 && game.losses === 0) return `🔥 Unbeaten at <b>${game.wins}</b> wins — press your advantage!`;
  return LIVE_TIPS[game.turn % LIVE_TIPS.length];
}
// Detail-on-tap: when a card is selected, show its FULL info (ability + flavor + stats) here so the cards
// themselves can stay clean. Hides (and lets the coach show) when nothing is selected.
function renderCardDetail() {
  const el = $('#cardDetail'); if (!el) return;
  const coach = $('#coach');
  // The trigger badge already names WHEN an ability fires, so drop the duplicate "Trigger: " prefix from the
  // ability text (mirrors the battle callout). "When sold: give all friends…" → badge[Sell] + "Give all friends…".
  const effect = (t) => { t = t || ''; const i = t.indexOf(': '); const s = i >= 0 ? t.slice(i + 2) : t; return s ? s[0].toUpperCase() + s.slice(1) : s; };
  let defId = null, level = 1, unit = null, isItem = false;
  if (sel?.kind === 'shopPet') defId = game.shop.pets[sel.index]?.defId;
  else if (sel?.kind === 'shopSnack') { defId = game.shop.snacks[sel.index]?.defId; isItem = true; }
  else if (sel?.kind === 'squad') { unit = game.squad[sel.index]; defId = unit?.defId; level = unit?.level || 1; }
  if (!defId) { el.hidden = true; el.innerHTML = ''; if (coach) coach.style.display = ''; return; }
  const costChip = (n) => `<span class="cd-cost">${icon('coin')}${n}</span>`;   // price shown here on tap
  // labeled meta row: Tier / Level / Atk / Def — same chip styling as elsewhere, but clearly labelled on select
  const metaItem = (label, valHTML) => `<span class="cd-m"><i>${label}</i>${valHTML}</span>`;
  const cdMeta = (tier, lvl, atk, hp, showLevel = true) => `<div class="cd-meta">${metaItem('Tier', tierChip(tier))}${showLevel ? metaItem('Level', `<b class="cd-mv">${lvl}</b>`) : ''}${metaItem('Atk', `<b class="atk">${atk}</b>`)}${metaItem('Def', `<b class="hp">${hp}</b>`)}</div>`;
  if (isItem) {
    const s = SNACK_BY_ID[defId];
    el.innerHTML = `<div class="cd-head"><b>${s.name}</b>${costChip(CONFIG.snackCost)}<div class="cd-meta">${metaItem('Tier', tierChip(s.tier))}</div></div>${s.text ? `<div class="cd-abil">${s.text}</div>` : ''}`;
  } else if (unit?.fused) {   // FUSED unit — read its carried def
    const fu = unit.fused, ab = fu.ability;
    // Show the REAL inherited trigger label (the whole blended combo fires on this one trigger) so WHEN it
    // fires is clear — not a static "Fusion" word. The ✦ FUSED chip still marks it as a fusion.
    const ftrig = ab ? (TRIGGER_LABEL[ab.trigger] || 'Ability') : '';
    el.innerHTML = `<div class="cd-head"><b>${unit.name}</b><span class="fused-chip">✦ FUSED</span>${cdMeta(fu.tier, level, unit.atk, unit.hp)}</div>
      ${ab ? `<div class="cd-abil"><span class="trig-badge">${ftrig}</span> ${effect(ab.text)}</div>` : ''}
      <div class="cd-flavor">${fu.desc || ('A fusion of ' + fu.parents.map((p) => (CREATURE_BY_ID[p]?.name || 'a Trinkling')).join(' + ') + '.')}</div>`;
  } else {
    const def = CREATURE_BY_ID[defId]; if (!def) { el.hidden = true; if (coach) coach.style.display = ''; return; }
    const ab = def.ability;
    const abTxt = scaledAbilityText(defId, level) || ab?.text || '';
    const trig = ab ? (TRIGGER_LABEL[ab.trigger] || 'Ability') : '';
    const cost = sel?.kind === 'shopPet' ? costChip(CONFIG.buyCost) : '';
    el.innerHTML = `<div class="cd-head"><b>${def.name}</b>${cost}${cdMeta(def.tier, level, unit ? unit.atk : def.atk, unit ? unit.hp : def.hp)}</div>
      ${ab ? `<div class="cd-abil"><span class="trig-badge">${trig}</span> ${effect(abTxt)}</div>` : ''}`;
  }
  el.hidden = false;
  if (coach) coach.style.display = 'none';   // focus on the detail while a card is selected
}
function renderCoach() {
  const el = $('#coach');
  let msg = '';
  // Tier unlocks are now announced by the #tierModal (openTierModal), so the coach no longer repeats them.
  if (game.turn === 1 && !hasBought) msg = COACH[0];
  else if (game.turn === 1 && hasBought) msg = COACH[1];
  else if (game.turn === 2) msg = COACH[2];
  else if (game.turn === 3) msg = COACH[3];
  else if (game.turn === 4) msg = COACH[4];
  else if (game.turn === 5) msg = COACH[5];
  else msg = liveCoachLine();
  if (msg) { el.innerHTML = msg; el.classList.add('show'); } else { el.classList.remove('show'); el.innerHTML = ''; }
}
function hint(t) { $('#hint').textContent = t || ''; }

// ---- interactions ----
function clearSel() { sel = null; selTarget = null; }
// The pending two-card action (source + occupied target) awaiting the #actionBtn tap. Returns {label, kind}
// or null. The label/kind mirror game.moveSquad's decision so the button never disagrees with what happens.
function pendingAction() {
  if (!sel || !selTarget) return null;
  const ti = selTarget.index, tgt = game.squad[ti];
  if (!tgt) return null;   // empty targets execute instantly and never become pending
  if (sel.kind === 'shopPet') {
    const src = game.shop.pets[sel.index]; if (!src) return null;
    if (!tgt.fused && tgt.defId === src.defId && (tgt.xp || 0) < CONFIG.xpToL3) return { label: 'Combine', kind: 'buy', cost: src.free ? 0 : CONFIG.buyCost };
    // NEW (per feedback): drop a shop pet onto a DIFFERENT-type squad pet → buy + fuse in one go (3 + 10 = 13)
    if (!tgt.fused && tgt.defId !== src.defId) return { label: 'Fuse', kind: 'buy-fuse', cost: (src.free ? 0 : CONFIG.buyCost) + (CONFIG.fuseCost ?? 10) };
    return null;
  }
  if (sel.kind === 'shopSnack') { return game.shop.snacks[sel.index] ? { label: 'Feed', kind: 'feed', cost: CONFIG.snackCost } : null; }
  if (sel.kind === 'squad') {
    if (sel.index === ti) return null;
    const a = game.squad[sel.index]; if (!a) return null;
    const terminal = a.fused || tgt.fused;
    if (!terminal && tgt.defId === a.defId && (tgt.xp || 0) < CONFIG.xpToL3) return { label: 'Combine', kind: 'move', cost: 0 };
    if (!terminal && tgt.defId !== a.defId) return { label: 'Fuse', kind: 'move', cost: CONFIG.fuseCost ?? 10 };
    return { label: 'Swap', kind: 'move', cost: 0 };
  }
  return null;
}
// The three action executors (also called directly for instant placement onto EMPTY slots).
function execBuy(shopIndex, slot) {
  const tgt = game.squad[slot], before = tgt ? tgt.level : null;
  const boughtDefId = game.shop.pets[shopIndex]?.defId;
  const r = game.buyPet(shopIndex, slot);
  if (r.ok) {
    markSeen(boughtDefId); SFX.buy(); hasBought = true; clearSel(); hint('');
    const after = game.squad[slot];
    if (after && before !== null && after.level > before) queueEvolve(slot, after.level);
    else if (before !== null) pendingMerge = { slot };
  } else { hint(reason(r.reason)); flashInvalid(slot); }
  render();
}
// buy a shop pet AND fuse it onto a different squad pet in one tap (per feedback)
function execBuyFuse(shopIndex, slot) {
  const boughtDefId = game.shop.pets[shopIndex]?.defId;
  const r = game.buyFuse(shopIndex, slot);
  if (r.ok) { markSeen(boughtDefId); SFX.fuse(); hasBought = true; clearSel(); hint(''); pendingFuse = { slot }; }
  else { hint(reason(r.reason)); flashInvalid(slot); }
  render();
}
function execMove(from, to) {
  const tgt = game.squad[to], before = tgt ? tgt.level : null;
  const r = game.moveSquad(from, to);
  if (r.ok) {
    // merge/fuse play their own richer sound from the burst (playMergeBurst/playFuseBurst); only move/swap taps here
    if (r.action === 'merge') { const after = game.squad[to]; if (after && before !== null && after.level > before) queueEvolve(to, after.level); else pendingMerge = { slot: to }; }
    else if (r.action === 'fuse') pendingFuse = { slot: to };
    else SFX.tap();
  }
  clearSel(); hint(''); render();
}
function execFeed(snackIndex, slot) {
  const r = game.buySnack(snackIndex, slot);
  if (r.ok) { SFX.merge(); clearSel(); hint(''); } else { hint(reason(r.reason)); flashInvalid(slot); }
  render();
}
function onShopPetTap(i) {
  if (!game.shop.pets[i]) return;
  SFX.tap();
  if (sel && sel.kind === 'shopPet' && sel.index === i) { clearSel(); hint(''); render(); return; }
  sel = { kind: 'shopPet', index: i }; selTarget = null;
  const def = CREATURE_BY_ID[game.shop.pets[i].defId];
  hint('');   // the tap-detail panel carries the ability — don't echo it in the hint too
  render();
}
function onShopSnackTap(i) {
  if (!game.shop.snacks[i]) return;
  SFX.tap();
  if (sel && sel.kind === 'shopSnack' && sel.index === i) { clearSel(); hint(''); render(); return; }
  sel = { kind: 'shopSnack', index: i }; selTarget = null;
  const s = SNACK_BY_ID[game.shop.snacks[i].defId];
  hint('');   // item detail shows in the tap-detail panel
  render();
}
function onSquadTap(i) {
  const tgt = game.squad[i];
  // A source is selected → this tap chooses the target slot. EMPTY slot = simple placement (buy/move), done
  // instantly. OCCUPIED slot = an ambiguous/irreversible action (combine/fuse/swap/feed) → arm #actionBtn.
  if (sel && sel.kind === 'shopPet') {
    if (!tgt) { execBuy(sel.index, i); return; }                     // empty → buy instantly
    const src = game.shop.pets[sel.index];                           // occupied → combine (same type) or fuse (different type)
    if (src && !tgt.fused && tgt.defId === src.defId && (tgt.xp || 0) < CONFIG.xpToL3) { selTarget = { kind: 'squad', index: i }; SFX.tap(); hint(''); render(); return; }
    // different base type → arm the buy+fuse confirm (pendingAction shows the "Fuse" label + cost; execBuyFuse handles gold)
    if (src && !tgt.fused && tgt.defId !== src.defId) { selTarget = { kind: 'squad', index: i }; SFX.tap(); hint(''); render(); return; }
    hint(reason('occupied')); flashInvalid(i); return;              // fused target, or a maxed same-type copy
  }
  if (sel && sel.kind === 'shopSnack') {
    if (!tgt) { hint(reason('no-target')); flashInvalid(i); return; }   // can't feed an empty slot
    selTarget = { kind: 'squad', index: i }; SFX.tap(); hint(''); render(); return;
  }
  if (sel && sel.kind === 'squad') {
    if (sel.index === i) { clearSel(); hint(''); render(); return; }    // tap self = deselect
    if (!tgt) { execMove(sel.index, i); return; }                        // move to an empty slot = instant
    selTarget = { kind: 'squad', index: i }; SFX.tap(); hint(''); render(); return;
  }
  // nothing selected -> select this squad unit (if any)
  if (game.squad[i]) { sel = { kind: 'squad', index: i }; SFX.tap(); hint(''); render(); }   // detail panel carries the info
}
function reason(r) {
  return ({ 'cannot-afford': 'Not enough gold.', occupied: "That slot has a different Trinkling.", full: 'Squad is full.',
    'max-level': 'Already max level.', 'no-target': 'Pick a Trinkling to feed.',
    'cannot-afford-fuse': 'Not enough gold to fuse.', 'invalid-fuse': "Those two can’t be fused." })[r] || 'Can’t do that.';
}
// Rejected action feedback: beep + a red shake on the hint, and (after render rebuilds the squad)
// a red shake on the slot the player tried to act on — so a failed buy/placement is felt, not just heard.
function flashInvalid(slot) {
  SFX.hit();
  const h = $('#hint'); if (h) { h.classList.remove('invalid'); void h.offsetWidth; h.classList.add('invalid'); setTimeout(() => h.classList.remove('invalid'), 420); }
  if (slot != null) requestAnimationFrame(() => { const el = $('#squad').children[slot]; if (el) { el.classList.add('invalid'); setTimeout(() => el.classList.remove('invalid'), 420); } });
}

// ---- DRAG & DROP (pointer-based; an ALTERNATIVE to tap, never a replacement) --------------------
// A press that never travels DRAG_PX stays a pure tap (the native click still fires onSquadTap/onShopPetTap/
// onShopSnackTap, unchanged); crossing the threshold turns the gesture into a drag and the trailing click is
// swallowed. We NEVER call render() during the move phase (only toggle classes on the live DOM) so the source
// card is never torn out from under an in-flight touch pointer (removing the implicitly-captured pointerdown
// target fires pointercancel and kills the drag). All gold/fusion/validity rules stay in game.* via the shared
// exec* actions; occupied-target decisions defer to pendingAction() so drag and tap can never disagree.
const DRAG_PX = 8;            // travel (px) that separates a drag from a tap
let drag = null;             // {src,pointerId,startX,startY,started,sourceEl,ghost,grabDX,grabDY,hoverSlot}
let swallowClick = false;    // eat the one click the browser fires after a mouse drag

// What a drop of `src` onto squad slot `slot` does. OCCUPIED targets borrow sel/selTarget and ask pendingAction()
// (the verbatim tap decision), then map kind->exec*. ok:false = illegal drop (blocked / feed-empty / self).
function dragResolve(src, slot) {
  const tgt = game.squad[slot];
  if (src.kind === 'shopSnack' && !tgt) return { ok: false, reason: 'no-target' };   // can't feed an empty slot
  if (src.kind === 'squad' && src.index === slot) return { ok: false, self: true };  // dropped on itself
  if (!tgt) {                                        // EMPTY slot -> instant place / move (mirrors onSquadTap)
    if (src.kind === 'shopPet') return { ok: true, run: () => execBuy(src.index, slot) };
    if (src.kind === 'squad')   return { ok: true, run: () => execMove(src.index, slot) };
    return { ok: false };
  }
  const s0 = sel, t0 = selTarget;                    // OCCUPIED slot -> reuse pendingAction's Combine/Fuse/Swap/Feed
  sel = src; selTarget = { kind: 'squad', index: slot };
  const pend = pendingAction();
  sel = s0; selTarget = t0;
  if (!pend) return { ok: false, reason: 'occupied' };
  const run = pend.kind === 'buy' ? () => execBuy(src.index, slot)
            : pend.kind === 'buy-fuse' ? () => execBuyFuse(src.index, slot)
            : pend.kind === 'feed' ? () => execFeed(src.index, slot)
            : () => execMove(src.index, slot);
  return { ok: true, label: pend.label, cost: pend.cost, run };
}
// Light up every squad slot's drop affordance for the current drag (reusing the tap-flow classes).
function paintDropTargets() {
  const kids = $('#squad').children;
  for (let i = 0; i < kids.length; i++) {
    const card = kids[i]; if (!card) continue;
    card.classList.remove('drop-target', 'mergeable', 'fusable', 'drag-ok', 'target-armed');
    const r = dragResolve(drag.src, i);
    if (!r.ok) continue;
    if (!game.squad[i]) card.classList.add('drop-target');   // empty valid slot (styled .card.empty.drop-target)
    else card.classList.add(r.label === 'Combine' ? 'mergeable' : r.label === 'Fuse' ? 'fusable' : 'drag-ok');
  }
}
function clearDropTargets() {
  const kids = $('#squad').children;
  for (let i = 0; i < kids.length; i++) kids[i]?.classList.remove('drop-target', 'mergeable', 'fusable', 'drag-ok', 'target-armed');
}
// Squad slot index under a screen point (ghost is pointer-events:none, so hit-testing sees the card beneath).
function slotAtPoint(x, y) {
  const card = document.elementFromPoint(x, y)?.closest('#squad .card[data-slot]');
  return card ? +card.dataset.slot : null;
}
// pointerdown on a shop/squad card: ARM a potential drag (don't commit -- a sub-threshold press is still a tap).
function dragStart(e, src) {
  if (e.button != null && e.button !== 0) return;    // primary button / touch / pen only
  if (drag) return;                                  // one pointer at a time (ignore extra fingers)
  drag = { src, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false, sourceEl: e.currentTarget, ghost: null, grabDX: 0, grabDY: 0, hoverSlot: null };
}
function dragBegin(e) {
  const el = drag.sourceEl, rect = el.getBoundingClientRect();
  drag.started = true;
  drag.grabDX = drag.startX - rect.left; drag.grabDY = drag.startY - rect.top;
  const g = el.cloneNode(true);
  g.className = el.className.replace(/\bselected\b/g, '').trim() + ' drag-ghost';
  g.style.width = rect.width + 'px'; g.style.height = rect.height + 'px';
  document.body.appendChild(g); drag.ghost = g;
  el.classList.add('drag-source');
  try { document.body.setPointerCapture(e.pointerId); } catch (_) {}   // stable capture: survives drop-time re-render + lets a mouse leave the window
  paintDropTargets();
  moveGhost(e.clientX, e.clientY);
  SFX.tap();
}
function moveGhost(x, y) { if (drag?.ghost) drag.ghost.style.transform = `translate(${x - drag.grabDX}px, ${y - drag.grabDY}px)`; }
function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_PX) return;   // still within tap slop
    dragBegin(e);
  }
  e.preventDefault();
  moveGhost(e.clientX, e.clientY);
  const slot = slotAtPoint(e.clientX, e.clientY);
  if (slot !== drag.hoverSlot) {
    const kids = $('#squad').children;
    if (drag.hoverSlot != null) kids[drag.hoverSlot]?.classList.remove('target-armed');
    drag.hoverSlot = slot;
    if (slot != null && dragResolve(drag.src, slot).ok) kids[slot]?.classList.add('target-armed');
  }
}
function onDragUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.started) { drag = null; return; }        // never crossed threshold -> it was a tap; let the click through
  finishDrag(slotAtPoint(e.clientX, e.clientY));
}
function onDragCancel(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (drag.started) finishDrag(null); else drag = null;
}
// Tear down ghost + highlights, then run the resolved action (or cancel) through the shared exec* path.
function finishDrag(slot) {
  const src = drag.src, sourceEl = drag.sourceEl, pid = drag.pointerId;
  clearDropTargets();
  if (drag.ghost) drag.ghost.remove();
  sourceEl.classList.remove('drag-source');
  try { document.body.releasePointerCapture(pid); } catch (_) {}
  drag = null;
  swallowClick = true; setTimeout(() => (swallowClick = false), 350);   // eat the trailing mouse click
  // Cancel silently on an off-board drop OR if the waiting-lock engaged mid-drag (duel/local squad already submitted).
  if (slot == null || $('#game').classList.contains('waiting')) { render(); return; }
  const r = dragResolve(src, slot);
  if (!r.ok) { if (!r.self) { hint(reason(r.reason || 'occupied')); flashInvalid(slot); } render(); return; }
  r.run();   // exec* enforces gold/fusion rules, then clearSel() + render()
}
// Attached ONCE: the shared move/up/cancel stream, the native-image-drag guard, and the post-drag click swallow.
document.addEventListener('pointermove', onDragMove, { passive: false });
document.addEventListener('pointerup', onDragUp);
document.addEventListener('pointercancel', onDragCancel);
document.addEventListener('dragstart', (e) => { if (drag) e.preventDefault(); }, true);   // stop the card <img> starting a native HTML5 drag that would steal the gesture
document.addEventListener('click', (e) => { if (swallowClick || (drag && drag.started)) { e.stopPropagation(); e.preventDefault(); swallowClick = false; } }, true);   // swallow the post-drag click; also block a 2nd-finger tap from render()-wiping mid-drag

// ---- reward modal ----
function openReward() {
  const r = game.pendingReward; if (!r) return;
  if (!$('#game').classList.contains('show')) return;   // never float the reward over battle/result — it re-opens on the next build render
  SFX.reward();
  const box = $('#rewardOptions'); box.innerHTML = '';
  r.options.forEach((defId, idx) => {
    const def = CREATURE_BY_ID[defId];
    const d = document.createElement('div'); d.className = 'card reward-card';
    // Show the NAME under the art + a hover/press-hold tooltip with the tier & ability, so it's not a blind pick.
    d.innerHTML = creatureCardHTML({ defId, name: def.name, level: 1, atk: def.atk, hp: def.hp }) + `<div class="reward-name">${def.name}</div>`;
    attachRewardTip(d, defId);
    d.onclick = () => { hideRewardTip(); markSeen(defId); game.chooseReward(idx); SFX.buy(); $('#rewardModal').hidden = true; render(); };
    box.appendChild(d);
  });
  $('#rewardModal').hidden = false;
}
$('#rewardSkip').onclick = () => { hideRewardTip(); game.pendingReward = null; $('#rewardModal').hidden = true; render(); };
// Reward-card tooltip: hover (desktop) or press-hold (touch) to preview the pet's name/tier/ability before picking.
let rewardTipEl = null;
function attachRewardTip(el, defId) {
  let held = false, timer = null;
  el.addEventListener('mouseenter', () => showRewardTip(defId, el));
  el.addEventListener('mouseleave', hideRewardTip);
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; held = false; timer = setTimeout(() => { held = true; showRewardTip(defId, el); }, 320); });
  el.addEventListener('pointerup', () => { clearTimeout(timer); if (held) setTimeout(hideRewardTip, 1400); });
  el.addEventListener('pointercancel', () => { clearTimeout(timer); hideRewardTip(); });
  el.addEventListener('click', (e) => { if (held) { e.stopImmediatePropagation(); e.preventDefault(); held = false; } }, true);   // a hold-preview must not also pick
}
function showRewardTip(defId, el) {
  hideRewardTip();
  const def = CREATURE_BY_ID[defId]; if (!def) return;
  const ab = scaledAbilityText(defId, 1) || def.ability?.text || 'No ability.';
  const t = document.createElement('div'); t.className = 'hold-tip reward-tip';
  t.innerHTML = `<div class="ht-name">${def.name} · T${def.tier}</div><div class="ht-abil">${ab}</div>`;
  document.body.appendChild(t);
  const r = el.getBoundingClientRect(), w = t.offsetWidth || 200;
  t.style.left = Math.min(Math.max(6, (r.left + r.right) / 2 - w / 2), window.innerWidth - w - 6) + 'px';
  t.style.top = (r.top - t.offsetHeight - 10 > 6 ? r.top - t.offsetHeight - 10 : r.bottom + 10) + 'px';
  rewardTipEl = t;
}
function hideRewardTip() { if (rewardTipEl) { rewardTipEl.remove(); rewardTipEl = null; } }

// ---- tier-unlock modal ----
// A new Trinkling tier opens every 2 turns (unlockedTier = floor((turn+1)/2)). Announce it with a modal
// the first time it changes, in BOTH solo (singleContinue) and duel (duelBeginRound).
function maybeTierModal(prevTurn, newTurn) {
  const after = unlockedTier(newTurn);
  if (after > unlockedTier(prevTurn)) openTierModal(after);
}
function openTierModal(tier) {
  SFX.reward();
  $('#tierBig').textContent = tier;
  $('#tierModalTitle').textContent = `Tier ${tier} unlocked!`;
  $('#tierModal').hidden = false;
}
$('#tierModalOk').onclick = () => { $('#tierModal').hidden = true; };

// ---- roll / sell / end turn ----
$('#rollBtn').onclick = () => { if (game.rollShop(false)) { SFX.tap(); clearSel(); render(); } };
$('#freezeBtn').onclick = () => { if (!sel) return; game.toggleFreeze(sel.kind === 'shopPet' ? 'pet' : 'snack', sel.index); SFX.freeze(); render(); };
// Sell is a TWO-STEP confirm so nothing is sold by accident: first tap arms (button goes hot + "tap again"),
// a second tap within a few seconds sells. Selecting elsewhere, or the timeout, cancels it.
let sellArmed = false, sellArmIndex = null, sellTimer = null;
function disarmSell() {
  sellArmed = false; sellArmIndex = null;
  if (sellTimer) { clearTimeout(sellTimer); sellTimer = null; }
  const b = $('#sellBtn'); if (b) { b.classList.remove('armed'); const l = $('#sellLbl'); if (l) l.textContent = 'Sell'; }
}
function armSell() {
  if (!(sel && sel.kind === 'squad' && game.squad[sel.index])) return;
  sellArmed = true; sellArmIndex = sel.index; SFX.tap();
  const val = game.squad[sel.index].level;
  $('#sellBtn').classList.add('armed');
  $('#sellLbl').textContent = `Sell for ${val}g? Tap again`;
  if (sellTimer) clearTimeout(sellTimer);
  sellTimer = setTimeout(disarmSell, 3000);
}
$('#sellBtn').onclick = () => {
  if (!(sel && sel.kind === 'squad' && game.squad[sel.index])) return;
  if (!sellArmed) { armSell(); return; }
  disarmSell(); game.sell(sel.index); SFX.tap(); clearSel(); render();
};
// The explicit confirm for a two-card action (Combine/Fuse/Swap/Feed) onto an occupied slot.
$('#actionBtn').onclick = () => {
  const pend = pendingAction(); if (!pend || !selTarget) return;
  const ti = selTarget.index;
  if (pend.kind === 'buy') execBuy(sel.index, ti);
  else if (pend.kind === 'buy-fuse') execBuyFuse(sel.index, ti);
  else if (pend.kind === 'feed') execFeed(sel.index, ti);
  else execMove(sel.index, ti);
};
// Swap alternative — reorder the two chosen squad pets instead of combining/fusing them.
$('#swapBtn').onclick = () => {
  if (!(sel && sel.kind === 'squad' && selTarget)) return;
  const from = sel.index, to = selTarget.index, s = game.squad;
  if (!s[from] || !s[to] || from === to) return;
  [s[from], s[to]] = [s[to], s[from]];
  SFX.tap(); clearSel(); hint(''); render();
};
$('#endBtn').onclick = () => (lMode ? (lPhase === 'waiting' ? localUnready() : localReady()) : duelMode ? (duelLocalPhase === 'waiting' ? duelUnready() : duelReady()) : endTurn());

let runWinStreak = 0; // consecutive single-player wins this run — drives reactive rival taunts

// A reactive rival: name varies per run (not a fixed 10-in-order cycle; a nemesis can recur), and the taunt
// reacts to the score AND name-drops the biggest Trinkling you're actually facing (links rival to their team).
function pickRival(game, ghost) {
  const r = RIVALS[((runSeed >>> 3) + (game.turn - 1) * 5) % RIVALS.length];
  let boss = null, bs = -1;
  for (const u of ghost) { const s = (u.atk || 0) + (u.hp || 0); if (s > bs) { bs = s; boss = CREATURE_BY_ID[u.defId]; } }
  const bossName = boss ? boss.name : 'my lot';
  const nearCup = game.trophies >= CONFIG.winTrophies - 2;
  let taunt;
  if (game.turn === 1) taunt = r.l;
  else if (game.hearts <= 1) taunt = `“On your last life? ${bossName} makes it quick.”`;
  else if (nearCup) taunt = `“One win from the Cup — you won’t get past ${bossName}.”`;
  else if (runWinStreak >= 3) taunt = `“${runWinStreak} on the trot? ${bossName} ends that streak.”`;
  else { const pool = [`“${bossName} says hello.”`, `“Front row’s ${bossName} — good luck.”`, r.l, `“Back again? ${bossName}’s ready.”`]; taunt = pool[(runSeed + game.turn) % pool.length]; }
  return { n: r.n, l: taunt };
}

function endTurn() {
  if (!game.livingSquad().length) { hint('Buy at least one Trinkling before fighting!'); return; }   // QA: empty squad silently cost a heart
  clearSel();
  const ghost = generateGhostTeam(game.turn, (runSeed + game.turn * 7919) >>> 0, easy ? 0.85 : 1.25);   // normal offline is harder — ghosts hit ~25% harder (per feedback)
  const rival = pickRival(game, ghost);
  $('#enemyLabel').textContent = rival.n;
  document.querySelector('.vs-label').textContent = rival.l;
  const battle = game.endTurn(ghost);
  playBattle(battle);
}

// ---- battle animation ----
let animTimer = null, animQueue = [], animIdx = 0, elMap = {}, MYSIDE = 0, playbackOnEnd = null;
let staged = {};   // uid -> {el, tx, ty, fresh} for pets currently staged (fighting) in the pit
let animDelay = 400, replaySpeed = 1, replayPaused = false;   // replay transport state
let curLog = null, curSide = 0, curOnEnd = null, isRewatch = false;   // remembered so Rewind can restart
// Generalized replay: `mySide` is the side rendered at the bottom as "mine" (0 single-player, slot in duel).
function runPlayback(log, mySide, onEnd, rewatch = false) {
  MYSIDE = mySide; playbackOnEnd = onEnd; curLog = log; curSide = mySide; curOnEnd = onEnd; isRewatch = rewatch;
  if (animTimer) { clearTimeout(animTimer); animTimer = null; }
  replaySpeed = 1; replayPaused = false; hideHoldTip();
  show('battle');
  startBattleMusic();   // energetic battle loop (cut when the result shows)
  $('#battleResult').hidden = true;
  hideAbilityCallout();
  const teams = log[0].teams; // startBattle snapshot
  elMap = {}; staged = {};
  buildLine($('#myLine'), teams[mySide], 'mine');
  buildLine($('#enemyLine'), teams[1 - mySide], 'enemy');
  animQueue = log.slice(1);
  animIdx = 0;
  // Budget against the WEIGHTED step cost (attacks/abilities linger longer than minor events) so a fight
  // lands near TARGET_MS regardless of event mix — the old raw-count formula blew a busy fight out to ~28s.
  const wsum = animQueue.reduce((s, ev) => s + stepWeight(ev), 0) || 1;
  animDelay = Math.max(420, Math.min(1300, Math.round(21000 / wsum)));   // ~21s slow, readable pace (Fast btn = 2.5× escape)
  $('#battle').classList.toggle('rewatch', rewatch);   // show the transport bar in rewatch mode
  if (rewatch) document.querySelector('.vs-label').textContent = 'Fight!';   // no leftover rival taunt on replay
  updateReplayControls();
  stepAnim();
}
function playBattle(battle) { runPlayback(battle.log, 0, showResult); }
function buildLine(container, units, sideCls) {
  container.innerHTML = '';
  for (const u of units) {
    const d = document.createElement('div'); d.className = 'bcard slide-' + sideCls + evoClass(u.level);  // slide in from its side
    d.dataset.uid = u.uid;
    d.innerHTML = `${artHTML(u.defId, u.level)}<div class="stats"><span class="stat"><b class="a">${u.atk}</b> / <b class="h">${u.hp}</b></span></div>`;
    attachHold(d, u);   // press-and-hold a pet during the (re)play → its ability tooltip
    container.appendChild(d);
    // store name + ability text so the hold tooltip AND the battle callout work (incl. fused units)
    elMap[u.uid] = { el: d, uid: u.uid, side: u.side, defId: u.defId, level: u.level || 1, name: u.name, abilityText: u.abilityText || '' };
  }
}
// ---- hold-for-ability (touch long-press / mouse press-hold) ----
let holdTimer = null, holdTipEl = null;
function attachHold(el, u) {
  const start = () => { clearTimeout(holdTimer); holdTimer = setTimeout(() => showHoldTip(u, el), 380); };
  const cancel = () => { clearTimeout(holdTimer); hideHoldTip(); };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());   // Android eats long-press otherwise
}
function showHoldTip(u, el) {
  hideHoldTip();
  const arena = document.querySelector('.arena'); if (!arena) return;
  let txt = u.abilityText || CREATURE_BY_ID[u.defId]?.ability?.text || 'No ability.';
  // Show the SAME level/tier-scaled magnitudes the engine uses (mirrors the shop detail card). Base creatures
  // scale via scaledAbilityText; fused units/tokens (not in CREATURE_BY_ID) keep base text. (Feedback: battle showed L1.)
  const inReg = !!CREATURE_BY_ID[u.defId]?.ability?.text;
  if (inReg || (u.abilityText && u.effect)) {   // fused units (not in CREATURE_BY_ID) scale from the snapshot's carried effect+tier
    const scaled = inReg
      ? scaledAbilityText(u.defId, u.level || 1)
      : scaledAbilityText(u.defId, u.level || 1, { text: u.abilityText, effect: u.effect }, u.tier);
    if (scaled) txt = scaled;
    else if ((u.level || 1) > 1) txt = `${txt} (Lv${u.level})`;   // unmappable shape → at least mark the level
  }
  holdTipEl = document.createElement('div'); holdTipEl.className = 'hold-tip';
  holdTipEl.innerHTML = `<div class="ht-name">${u.name || 'Trinkling'}</div><div class="ht-abil">${txt}</div>`;
  arena.appendChild(holdTipEl);
  const ar = arena.getBoundingClientRect(), r = el.getBoundingClientRect();
  const w = holdTipEl.offsetWidth || 190;
  holdTipEl.style.left = Math.min(Math.max(6, (r.left + r.right) / 2 - ar.left - w / 2), ar.width - w - 6) + 'px';
  holdTipEl.style.top = Math.max(6, r.top - ar.top - holdTipEl.offsetHeight - 8) + 'px';
  SFX.tap();
}
function hideHoldTip() { if (holdTipEl) { holdTipEl.remove(); holdTipEl = null; } }
function setStat(uid, key, val) { const m = elMap[uid]; if (m) { const b = m.el.querySelector('.' + key); if (b) b.textContent = val; } }
function floatText(uid, text, cls) {
  const m = elMap[uid]; if (!m) return;
  const f = document.createElement('div'); f.className = 'float ' + cls; f.textContent = text;
  m.el.appendChild(f); setTimeout(() => f.remove(), 1000);
}
// brief whole-arena shake on a heavy hit (≥4 damage)
let shakeT = null;
function arenaShake() { const a = document.querySelector('.arena'); if (!a) return; a.classList.remove('shake'); void a.offsetWidth; a.classList.add('shake'); clearTimeout(shakeT); shakeT = setTimeout(() => a.classList.remove('shake'), 300); }
// a rising sparkle when a unit is buffed
function sparkleRise(uid) { const m = elMap[uid]; if (!m) return; const s = document.createElement('div'); s.className = 'sparkle-rise'; s.textContent = '✦'; s.style.left = '50%'; s.style.top = '30%'; m.el.appendChild(s); setTimeout(() => s.remove(), 800); }
// Attack animation: the two combatants CHARGE into the centre PIT (clashMeet below is the ONE live path
// wired to the 'attack' event). Earlier spell-bolt / lunge variants were removed as dead code.
// The two combatants CHARGE into the centre PIT (both horizontally AND vertically), clash face-to-face over
// the glowing ring, then spring back to their lanes — a proper 1v1 meet in the middle.
// ===== CINEMATIC BATTLE STAGING (per feedback) =====
// The two front pets JUMP into the pit and stand SIDE BY SIDE (you on the left, the enemy on the right,
// flipped to face you), trade blows there over several seconds with kicked-up dirt, and a KO'd pet is BLOWN
// off — yours to the left, the enemy's to the right — before the next pet jumps in.
const STAGE_XOFF = 78, STAGE_Y = 0.5;   // side-by-side offset (further apart) + vertical anchor
function arenaBox() { const a = document.querySelector('.arena'); return a ? { a, r: a.getBoundingClientRect() } : null; }
function returnToLane(s) { if (!s || !s.el) return; const sp = replaySpeed || 1; s.el.style.willChange = 'transform'; s.el.style.setProperty('--persp-dur', (0.5 / sp).toFixed(2) + 's'); s.el.style.transition = `transform ${(0.34 / sp).toFixed(2)}s var(--ease-bounce)`; s.el.style.transform = ''; s.el.style.zIndex = ''; s.el.classList.remove('in-arena', 'face-left'); setTimeout(() => { if (!s.el.classList.contains('in-arena')) s.el.style.willChange = ''; }, 340 / sp + 40); }
// kick a spray of dirt clods up from a point in the pit (arena-local coords)
function kickDirt(lx, ly, arena) {
  if (!arena) return;
  const d = document.createElement('div'); d.className = 'dirt-kick'; d.style.left = lx + 'px'; d.style.top = ly + 'px';
  for (let i = 0; i < 7; i++) { const c = document.createElement('i'); c.style.setProperty('--a', (i * 47 + 200) + 'deg'); c.style.setProperty('--d', (18 + Math.random() * 22).toFixed(0) + 'px'); d.appendChild(c); }
  arena.appendChild(d); setTimeout(() => d.remove(), 700);
}
// jump one pet from its lane into the pit at (centre+xoff). Skips if it's already staged (the surviving pet).
// Uses requestAnimationFrame so the CSS transition actually RUNS (setting transition+transform in one tick
// teleported). transform-heavy so it composites on the GPU → smooth 60fps.
function placeStage(m, xoff, flip) {
  if (!m || !m.el || staged[m.uid]) return;
  const box = arenaBox(); if (!box) return; const { a: arena, r: ar } = box;
  const rr = m.el.getBoundingClientRect();
  const tx = (ar.left + ar.width / 2 + xoff) - (rr.left + rr.right) / 2;
  const ty = (ar.top + ar.height * STAGE_Y) - (rr.top + rr.bottom) / 2;
  const sp = replaySpeed || 1;
  m.el.style.zIndex = 22; m.el.style.willChange = 'transform'; m.el.style.setProperty('--persp-dur', (0.5 / sp).toFixed(2) + 's'); m.el.classList.add('in-arena'); if (flip) m.el.classList.add('face-left');
  staged[m.uid] = { el: m.el, tx, ty, fresh: true };
  // 1) pin the current lane position with NO transition + force a reflow, 2) animate on the next frame → no teleport
  m.el.style.transition = 'none';
  m.el.style.transform = 'translate(0px, 0px) scale(1)';
  void m.el.offsetWidth;
  requestAnimationFrame(() => {
    m.el.style.transition = `transform ${(0.6 / sp).toFixed(2)}s cubic-bezier(.25,-0.35,.4,1)`;   // leap up + over
    m.el.style.transform = `translate(${tx}px, ${(ty - 56).toFixed(1)}px) scale(1.14)`;
    setTimeout(() => {                                                                            // land with a bounce
      m.el.style.transition = `transform ${(0.36 / sp).toFixed(2)}s cubic-bezier(.3,1.5,.5,1)`;
      m.el.style.transform = `translate(${tx}px, ${ty}px) scale(1.12)`;
      kickDirt(ar.width / 2 + xoff, ar.height * STAGE_Y + 14, arena);
    }, 600 / sp);
  });
}
// begin a matchup: return anyone staged who isn't in it, then jump the two front pets in (you left / foe right)
function stageMatchup(A, B) {
  if (!A || !B) return;
  const mine = A.side === MYSIDE ? A : B, foe = A.side === MYSIDE ? B : A;
  for (const uid in staged) if (uid != mine.uid && uid != foe.uid) { returnToLane(staged[uid]); delete staged[uid]; }
  placeStage(mine, -STAGE_XOFF, false);
  placeStage(foe, STAGE_XOFF, true);
}
// the two staged pets CHARGE from their far-apart spots and MEET in the centre when they slam, then spring back.
// Only the fighters move (no arena-wide shake). Delayed on first arrival so you see them stand apart first.
function bumpFight(A, B) {
  const box = arenaBox(); if (!box) return; const { a: arena, r: ar } = box;
  const sp = replaySpeed || 1;
  const sa = staged[A?.uid], sb = staged[B?.uid];
  const justArrived = (sa && sa.fresh) || (sb && sb.fresh);
  const dirTo = (m) => (m.side === MYSIDE ? 1 : -1);         // mine (left) lunges right; foe (right) lunges left
  const move = (m, dx, sc, dur) => { const s = staged[m.uid]; if (!s || !m.el) return; m.el.style.transition = `transform ${(dur / sp).toFixed(2)}s ease-out`; m.el.style.transform = `translate(${(s.tx + dx).toFixed(1)}px, ${s.ty}px) scale(${(1.12 * sc).toFixed(3)})`; };
  const toward = STAGE_XOFF - 16;                            // travel almost to the centre → they MEET when they slam
  const lunge = () => {
    fireProjectile(A.el, B.el, A.side === MYSIDE ? '#8fd0ff' : '#ff9a6a');
    requestAnimationFrame(() => {
      move(A, dirTo(A) * toward, 1.06, 0.18); move(B, dirTo(B) * toward, 1.06, 0.18);   // charge in
      setTimeout(() => {                                     // SLAM in the centre
        const aR = A.el.getBoundingClientRect(), bR = B.el.getBoundingClientRect();
        spawnClashFx(aR, bR); kickDirt(ar.width / 2, ar.height * STAGE_Y + 16, arena);
        move(A, dirTo(A) * (toward - 18), 0.98, 0.09); move(B, dirTo(B) * (toward - 24), 0.9, 0.09);   // recoil
        setTimeout(() => { move(A, 0, 1, 0.26); move(B, 0, 1, 0.26); }, 160 / sp);      // spring back apart
      }, 190 / sp);
    });
  };
  if (justArrived) { if (sa) sa.fresh = false; if (sb) sb.fresh = false; setTimeout(lunge, 900 / sp); }  // stand apart first
  else lunge();
}
// KO: blow the fainted pet off-screen — yours to the LEFT, the enemy's to the RIGHT — with a tumble.
function blowOut(m) {
  if (!m || !m.el) return;
  const dir = m.side === MYSIDE ? -1 : 1;
  delete staged[m.uid];
  const sp = replaySpeed || 1;
  m.el.style.zIndex = 15; m.el.style.willChange = 'transform, opacity';
  m.el.style.transition = `transform ${(0.62 / sp).toFixed(2)}s cubic-bezier(.35,0,.9,.4), opacity ${(0.6 / sp).toFixed(2)}s ease-out`;
  m.el.style.transform = `translate(${dir * 340}px, -30px) scale(1.05) rotate(${dir * 42}deg)`;
  m.el.style.opacity = '0';
}
// Inserting/removing a card in a centre-justified flex lane RE-CENTERS the row, shifting the layout box of any
// pet currently STAGED in the pit — but its fixed pit transform stays put, so it teleports sideways mid-fight.
// FLIP (First-Last-Invert-Play): snapshot EVERY card's screen position, run the lane-mutating DOM op, then
// animate each card from its OLD position to the new one so bench cards GLIDE instead of snapping when a
// summon is inserted / a fainter is removed / a pet moves. The staged fighter stays pinned to the pit (its
// stored transform is shifted by the pure layout delta). Kills the "bench teleports" on any lane reflow.
function compensateStagedForReflow(container, mutate) {
  const sp = replaySpeed || 1;
  const cards = [...container.children].map((el) => ({ el, r: el.getBoundingClientRect(), inArena: el.classList.contains('in-arena') }));
  mutate();
  for (const c of cards) {
    const el = c.el; if (!el.isConnected) continue;
    const nr = el.getBoundingClientRect(), dx = c.r.left - nr.left, dy = c.r.top - nr.top;   // invert = old − new
    if (!dx && !dy) continue;
    if (c.inArena) {                          // staged fighter: keep it pinned to the pit through the reflow
      const s = staged[el.dataset.uid];
      if (s) { s.tx += dx; s.ty += dy; const prev = el.style.transition; el.style.transition = 'none'; el.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(1.12)`; void el.offsetWidth; el.style.transition = prev; }
      continue;
    }
    el.style.transition = 'none';             // bench card FLIP: jump back to the old spot, then glide to the new
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    void el.offsetWidth;
    el.style.transition = `transform ${(0.34 / sp).toFixed(2)}s cubic-bezier(.3,1.2,.5,1)`;
    el.style.transform = '';
    const clear = () => { el.style.transition = ''; el.removeEventListener('transitionend', clear); };
    el.addEventListener('transitionend', clear);
  }
}
function clashMeet(A, B) { if (A && B) { stageMatchup(A, B); bumpFight(A, B); } }   // legacy name → new staging
// A glowing projectile that streaks from one combatant across the pit to the other — the "ranged" spectacle
// layered over the melee clash. Tinted per side; captured positions are the pre-charge spots.
function fireProjectile(fromEl, toEl, hue) {
  const arena = document.querySelector('.arena'); if (!arena || !fromEl || !toEl) return;
  const ar = arena.getBoundingClientRect();
  const fr = fromEl.getBoundingClientRect(), tr = toEl.getBoundingClientRect();
  const sx = (fr.left + fr.right) / 2 - ar.left, sy = (fr.top + fr.bottom) / 2 - ar.top;
  const tx = (tr.left + tr.right) / 2 - ar.left, ty = (tr.top + tr.bottom) / 2 - ar.top;
  const ang = Math.atan2(ty - sy, tx - sx) * 180 / Math.PI;
  const p = document.createElement('div'); p.className = 'projectile';
  p.style.left = sx + 'px'; p.style.top = sy + 'px';
  p.style.setProperty('--hue', hue || '#ffd66a'); p.style.setProperty('--ang', ang + 'deg');
  arena.appendChild(p);
  const flight = Math.max(170, Math.min(animDelay * 0.5, 380)) / (replaySpeed || 1);
  requestAnimationFrame(() => { p.style.transition = `transform ${flight}ms cubic-bezier(.35,.02,.7,1)`; p.style.transform = `translate(${tx - sx}px, ${ty - sy}px) scale(.75)`; });
  setTimeout(() => p.remove(), flight + 50);
}
function spawnClashFx(aR, bR) {
  const fx = $('#clashFx'); const arena = document.querySelector('.arena');
  if (!fx || !arena) return;
  const ar = arena.getBoundingClientRect();
  const mx = ((aR.left + aR.right) / 2 + (bR.left + bR.right) / 2) / 2 - ar.left;
  const my = ((aR.top + aR.bottom) / 2 + (bR.top + bR.bottom) / 2) / 2 - ar.top;
  fx.style.left = mx + 'px'; fx.style.top = my + 'px'; fx.style.margin = '-29px 0 0 -29px';
  fx.classList.remove('boom'); void fx.offsetWidth; fx.classList.add('boom');
}
// death punch: a shard/flash puff over the fallen unit (the .faint class does the scale-up + fade)
function deathBurst(el) {
  const arena = document.querySelector('.arena'); if (!arena || !el) return;
  const ar = arena.getBoundingClientRect(), r = el.getBoundingClientRect();
  const burst = document.createElement('div'); burst.className = 'death-burst';
  burst.style.left = ((r.left + r.right) / 2 - ar.left) + 'px';
  burst.style.top = ((r.top + r.bottom) / 2 - ar.top) + 'px';
  for (let i = 0; i < 7; i++) {
    const s = document.createElement('i');
    s.style.setProperty('--a', (i * 51 + Math.random() * 20) + 'deg');
    s.style.setProperty('--d', (16 + Math.random() * 14).toFixed(0) + 'px');
    burst.appendChild(s);
  }
  arena.appendChild(burst);
  setTimeout(() => burst.remove(), 600);
}
function stepAnim() {
  animTimer = null;
  if (replayPaused) return;
  if (animIdx >= animQueue.length) { if (playbackOnEnd) playbackOnEnd(); return; }
  const e = animQueue[animIdx++];
  applyEvent(e);
  animTimer = setTimeout(stepAnim, Math.max(120, stepDelay(e, animDelay) / replaySpeed));
}
// ---- replay transport (pause / fast / rewind); Skip already fast-forwards to the end ----
function replayPause() { replayPaused = !replayPaused; if (!replayPaused && !animTimer) stepAnim(); else if (animTimer) { clearTimeout(animTimer); animTimer = null; } updateReplayControls(); }
function replayFast() { replaySpeed = replaySpeed === 1 ? 2.5 : 1; updateReplayControls(); }
function replayRewind() { if (curLog) runPlayback(curLog, curSide, curOnEnd, isRewatch); }
function updateReplayControls() {
  const pb = $('#pauseBtn'); if (pb) pb.classList.toggle('on', replayPaused);
  const fb = $('#fastBtn'); if (fb) fb.classList.toggle('on', replaySpeed > 1);
}
// Per-event pace weight (relative to the base step). Shared by the budget calc in runPlayback and the
// per-step scheduler so the total playback time actually tracks the ~15s target.
function stepWeight(e) {
  if (e.t === 'ability') return 1.3;            // let ability moments read
  if (e.t === 'attack') return 1.5;             // linger on each 1v1 clash
  if (e.t === 'faint' || e.t === 'summon') return 1;
  return 0.62;
}
// Attacks get a minimum dwell so the slower charge-in + trade-blows clash always finishes before the next
// one starts (per feedback: pets spend more time reaching + fighting in the middle).
// Cinematic pacing (per feedback): attacks dwell long (jump-in + stand + trade blows), and a KO gets time to
// blow the pet off-screen before the next pet jumps in.
function stepDelay(e, base) {
  const d = Math.round(base * stepWeight(e));
  if (e.t === 'attack') return Math.max(1700, d);
  if (e.t === 'faint') return Math.max(820, d);
  return d;
}
function applyEvent(e) {
  switch (e.t) {
    case 'attack': { clashMeet(elMap[e.a], elMap[e.b]); SFX.attack(); break; }
    case 'damage': {
      setStat(e.uid, 'h', e.hp);
      const m = elMap[e.uid];
      if (m && e.amount > 0) { m.el.classList.add('hit'); setTimeout(() => m.el.classList.remove('hit'), 250); floatText(e.uid, '-' + e.amount, 'dmg'); SFX.hit(); }
      updateShield(e.uid, e.shield);
      break;
    }
    case 'buff': { setStat(e.uid, 'a', e.newAtk); setStat(e.uid, 'h', e.newHp); const dn = (e.atk || 0) < 0 || (e.hp || 0) < 0; const sg = (v) => ((v || 0) >= 0 ? '+' + (v || 0) : '' + (v || 0)); floatText(e.uid, `${sg(e.atk)}/${sg(e.hp)}`, dn ? 'dmg' : 'buff'); if (!dn && ((e.atk || 0) > 0 || (e.hp || 0) > 0)) sparkleRise(e.uid); break; }
    case 'shield': updateShield(e.uid, e.shield); floatText(e.uid, '🛡+' + e.amount, 'buff'); break;
    case 'ability': { abilityPop(e.uid); SFX.ability(); break; }
    case 'faint': { const m = elMap[e.uid]; if (m) { deathBurst(m.el); blowOut(m); SFX.faint(); setTimeout(() => { const line = m.el.parentElement; if (line) compensateStagedForReflow(line, () => m.el.remove()); else m.el.remove(); }, 700 / (replaySpeed || 1)); } break; }
    case 'summon': { addSummon(e); break; }
    // steal transfers atk/hp from the victim to the stealer: the stealer updates via its own 'buff' event,
    // so here we update the VICTIM (e.from) to its new absolute stats (tatk/thp) or its numbers would desync.
    case 'steal': { setStat(e.from, 'a', e.tatk); setStat(e.from, 'h', e.thp); const m = elMap[e.from]; if (m) { m.el.classList.add('hit'); setTimeout(() => m.el.classList.remove('hit'), 250); } floatText(e.from, `-${e.atk}/-${e.hp}`, 'dmg'); break; }
    case 'move': {
      const m = elMap[e.uid];
      if (m) {
        const line = m.el.parentElement;
        const wasStaged = staged[m.uid];
        // FLIP the reparent so a NON-staged mover (and its lane-mates) GLIDE to their new slots, not teleport.
        compensateStagedForReflow(line, () => { if (e.to === 'back') line.appendChild(m.el); else line.prepend(m.el); });
        // A STAGED mover (e.g. Skiff dashing to the back after attacking) glides home from the pit instead.
        if (wasStaged) { void m.el.offsetWidth; returnToLane(wasStaged); delete staged[m.uid]; }
      }
      break;
    }
    case 'skip': floatText(e.uid, 'HONK!', 'abil'); break;
    default: break;
  }
}
// Named, legible battle callout: WHO fired and WHAT it does (derived from the live ability data).
// Anchored in the top void (CSS) so it never covers the actors. Chained fires at the start of a
// battle are QUEUED — each holds a minimum ~720ms instead of being instantly overwritten.
let calloutTimer = null, calloutQueue = [], calloutBusy = false;
const CALLOUT_HOLD = 720, CALLOUT_LINGER = 1100;
// On-pet ability cue: a quick sparkle-pop + glow ON the pet whose ability fired (no big centre tooltip).
// The player can press-and-hold any pet to read its full ability (attachHold) if they want the details.
function abilityPop(uid) {
  const m = elMap[uid]; if (!m) return;
  m.el.classList.remove('abil-fire'); void m.el.offsetWidth; m.el.classList.add('abil-fire');
  setTimeout(() => { if (m.el) m.el.classList.remove('abil-fire'); }, 760);
}
function showAbilityCallout(uid) {   // legacy centre callout — no longer wired (kept to avoid breakage)
  const m = elMap[uid];
  // prefer the stored name/abilityText (works for FUSED units too, which aren't in CREATURE_BY_ID)
  const name = (m && (m.name || CREATURE_BY_ID[m.defId]?.name || ALL_UNITS_BY_ID[m.defId]?.name)) || 'Trinkling';
  const lvl = (m && m.level) || 1;
  let full = (m && m.abilityText) || CREATURE_BY_ID[m?.defId]?.ability?.text || '', mark = '';
  if (full && lvl > 1 && CREATURE_BY_ID[m.defId]) {       // level-scale base units (fused/tokens keep base text)
    const scaled = scaledAbilityText(m.defId, lvl);
    if (scaled) full = scaled; else mark = ` · Lv${lvl}`;
  }
  let summary = '';
  if (full) { const i = full.indexOf(': '); summary = (i >= 0 ? full.slice(i + 2) : full) + mark; }
  calloutQueue.push({ name, summary });
  if (!calloutBusy) pumpCallout();
}
function pumpCallout() {
  const el = $('#abilityCallout'); if (!el) return;
  if (calloutTimer) { clearTimeout(calloutTimer); calloutTimer = null; }
  if (!calloutQueue.length) { calloutBusy = false; calloutTimer = setTimeout(hideAbilityCallout, CALLOUT_LINGER); return; }
  calloutBusy = true;
  const { name, summary } = calloutQueue.shift();
  el.innerHTML = `<span class="ac-name">✨ ${name}</span>${summary ? `<span class="ac-eff">${summary}</span>` : ''}`;
  el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';  // replay the pop per queued fire
  calloutTimer = setTimeout(pumpCallout, CALLOUT_HOLD);
}
function hideAbilityCallout() {
  if (calloutTimer) { clearTimeout(calloutTimer); calloutTimer = null; }
  calloutQueue = []; calloutBusy = false;
  const el = $('#abilityCallout'); if (el) { el.hidden = true; el.innerHTML = ''; }
}
function updateShield(uid, shield) {
  const m = elMap[uid]; if (!m) return;
  let b = m.el.querySelector('.shieldbadge');
  if (shield > 0) { if (!b) { b = document.createElement('div'); b.className = 'shieldbadge'; m.el.appendChild(b); } b.textContent = shield; }
  else if (b) b.remove();
}
function addSummon(e) {
  const container = e.side === MYSIDE ? $('#myLine') : $('#enemyLine');
  const u = ALL_UNITS_BY_ID[e.token];
  const d = document.createElement('div'); d.className = 'bcard slide-' + (e.side === MYSIDE ? 'mine' : 'enemy') + evoClass(e.level || 1); d.dataset.uid = e.uid;
  d.innerHTML = `${artHTML(e.token, e.level || 1)}<div class="stats"><span class="stat"><b class="a">${e.atk}</b> / <b class="h">${e.hp}</b></span></div>`;
  const nm = u?.name || 'Token';
  attachHold(d, { defId: e.token, name: nm, abilityText: u?.ability?.text || '' });
  // Place the token in its REAL slot, not always at the back: the engine sends afterUid = the living unit
  // it was summoned just behind ("in its place" / "behind it"). .line is front→back in DOM order, so insert
  // right after that anchor's card; afterUid == null means the token is the new front unit.
  const anchor = e.afterUid != null ? elMap[e.afterUid]?.el : null;
  compensateStagedForReflow(container, () => {   // don't let the insert re-center a currently-fighting pet
    if (anchor && anchor.parentElement === container) anchor.insertAdjacentElement('afterend', d);
    else if (e.afterUid == null) container.prepend(d);
    else container.appendChild(d);
  });
  elMap[e.uid] = { el: d, uid: e.uid, side: e.side, defId: e.token, level: e.level || 1, name: nm, abilityText: u?.ability?.text || '' };
  SFX.tap();
}
$('#skipBtn').onclick = () => {
  if (animTimer) clearTimeout(animTimer);
  silentApply = true;   // clean cut: apply the remaining events' state without firing every SFX at once
  while (animIdx < animQueue.length) applyEvent(animQueue[animIdx++]);
  silentApply = false;
  hideAbilityCallout();
  if (playbackOnEnd) playbackOnEnd();   // the single win/lose sample now plays into a quiet result screen
};
// ---- replay transport wiring ----
$('#pauseBtn').onclick = () => { replayPause(); $('#pauseBtn').textContent = replayPaused ? 'Resume' : 'Pause'; };
$('#fastBtn').onclick = replayFast;
$('#rewindBtn').onclick = () => { $('#pauseBtn').textContent = 'Pause'; replayRewind(); };
// ---- rewatch entry (HUD ↺ → choose your side or the rival's) ----
const backToShop = () => { $('#battle').classList.remove('rewatch'); show('game'); render(); };
$('#replayBtn').onclick = () => { if (game && game.lastBattle) { SFX.tap(); $('#rewatchModal').hidden = false; } };
$('#rewatchClose').onclick = () => { $('#rewatchModal').hidden = true; };
$('#rewatchSelf').onclick = () => { $('#rewatchModal').hidden = true; if (game?.lastBattle) runPlayback(game.lastBattle.log, 0, backToShop, true); };
$('#rewatchRival').onclick = () => { $('#rewatchModal').hidden = true; if (game?.lastBattle) runPlayback(game.lastBattle.log, 1, backToShop, true); };
// Outcome-themed result screen: emblem + big banner + a soft subtitle, on a tinted card. No sad emoji —
// a loss stays upbeat ("come back stronger"), keeping the whimsical tone. Shared by solo + duel.
const RESULT_UI = {
  win:  { txt: 'Victory!',    sub: 'Your squad holds the field.',            emblem: 'trinkling-happy', snd: () => SFX.win() },
  lose: { txt: 'Defeated',    sub: 'Shake it off — come back stronger.',      emblem: 'trinkling-sad',   snd: () => SFX.lose() },
  draw: { txt: "It's a draw", sub: 'Evenly matched — not a scratch on either side.', emblem: 'trinkling-draw', snd: () => {} },
};
function applyResultScreen(result) {
  stopBattleMusic();   // cut the battle track the instant a win/lose/draw is shown
  const r = RESULT_UI[result] || RESULT_UI.draw;
  const banner = $('#resultBanner');
  banner.textContent = r.txt; banner.className = 'result-banner ' + result;
  // a loss is kept simple: just "Defeated" + how many hearts it cost / how many remain
  // Solo: keep it succinct — mirror the "−1 ❤" defeat line with a "+1 🏆" victory line. (Duel/Local track hearts, not trophies.)
  let sub = r.sub;
  if (!duelMode && !lMode && game) {
    if (result === 'lose') sub = `−${CONFIG.heartsLostPerLoss} ❤ · ${game.hearts} left`;
    else if (result === 'win') sub = `+1 🏆 · ${game.trophies}/${CONFIG.winTrophies}`;
  }
  $('#resultSub').textContent = sub;
  $('#resultEmblem').src = `assets/ui/${r.emblem}.png`;
  $('#resultCard').className = 'result-card ' + result;
  r.snd();
}
function showResult() {
  if (animTimer) clearTimeout(animTimer);
  const b = game.lastBattle;
  runWinStreak = b.result === 'win' ? runWinStreak + 1 : 0;   // feeds reactive rival taunts
  $('#duelScore').hidden = true;
  applyResultScreen(b.result);
  $('#battleResult').hidden = false;
}
function singleContinue() {
  if (game.status === 'won') return gameOver(true);
  if (game.status === 'lost') return gameOver(false);
  const prev = game.turn;
  game.startTurn(); show('game'); render();
  maybeTierModal(prev, game.turn);
}
$('#continueBtn').onclick = singleContinue;

// ---- persistent best record (FB-R14) + rank ladder ----
// Themed progression ladder mapped to lifetime Cups won — a reason to replay.
const RANKS = [
  { cups: 0,  name: 'Tide-Waif' },
  { cups: 1,  name: 'Driftward' },
  { cups: 3,  name: 'Wardling' },
  { cups: 6,  name: 'Tidewarden' },
  { cups: 10, name: 'Moonvow Keeper' },
  { cups: 15, name: 'Warden of the Arena' },
  { cups: 25, name: 'Tidelord' },
];
function rankFor(cups) {
  cups = cups || 0;
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (cups >= RANKS[i].cups) idx = i;
  return { idx, name: RANKS[idx].name, floor: RANKS[idx].cups, next: RANKS[idx + 1] || null, atMax: idx === RANKS.length - 1 };
}
let lastRankUp = null; // set by saveBest when a fresh Cup crosses a rank threshold; announced on the game-over screen
function saveBest(won) {
  const b = JSON.parse(localStorage.getItem('cc_best') || '{}');
  b.trophies = Math.max(b.trophies || 0, game.trophies);
  lastRankUp = null;
  if (won) {
    const before = rankFor(b.cups || 0).idx;
    b.cups = (b.cups || 0) + 1; b.bestTurns = Math.min(b.bestTurns || 99, game.turn);
    const after = rankFor(b.cups);
    if (after.idx > before) lastRankUp = after.name;
  }
  localStorage.setItem('cc_best', JSON.stringify(b));
}
function showBest() {
  const b = JSON.parse(localStorage.getItem('cc_best') || '{}');
  const el = $('#bestRecord');
  if (el) {
    if (b.cups) el.innerHTML = `${icon('trophy')} Cups won: ${b.cups} · best run: ${b.bestTurns} turns`;
    else if (b.trophies) el.innerHTML = `${icon('trophy')} Best so far: ${b.trophies}/10 wins`;
    else el.textContent = '';
  }
  showRank(b.cups || 0);
}
function showRank(cups) {
  const el = $('#rankRow'); if (!el) return;
  const r = rankFor(cups);
  const prog = r.atMax
    ? `<span class="rank-prog">✦ highest rank reached · ${cups} Cups</span>`
    : `<span class="rank-prog"><b>${cups}</b>/<b>${r.next.cups}</b> Cups to <b>${r.next.name}</b></span>`;
  el.innerHTML = `<span class="rank-name">${icon('trophy')} ${r.name}</span>${prog}`;
}

// ---- Trinkling Codex — browse every Trinkling; track which you've FIELDED (localStorage 'cc_seen') ----
const SEEN_KEY = 'cc_seen';
function loadSeen() { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } }
function markSeen(defId) {
  if (!defId || !CREATURE_BY_ID[defId]) return;
  const s = loadSeen();
  if (!s.has(defId)) { s.add(defId); localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); }
}
function openCodex() {
  SFX.tap();
  const seen = loadSeen();
  const all = Object.values(CREATURE_BY_ID);
  const seenCount = all.filter((c) => seen.has(c.id)).length;
  $('#codexProgress').innerHTML = `${icon('trophy')} <b>${seenCount}</b>/<b>${all.length}</b> Trinklings fielded`;
  const wrap = $('#codexList'); wrap.innerHTML = '';
  FACTIONS.forEach((f) => {
    const mine = all.filter((c) => c.faction === f.key).sort((a, b) => a.tier - b.tier);
    const seenF = mine.filter((c) => seen.has(c.id)).length;
    const sec = document.createElement('div'); sec.className = 'codex-faction';
    sec.innerHTML = `<div class="codex-fhead">
        <div class="codex-fname">${f.name}</div>
        <div class="codex-flaw">Law: <b>${f.law}</b> · ${factionTag(f)}</div>
        <div class="codex-fsyn">${factionBlurb(f)}</div>
        <div class="codex-fcount">${seenF}/${mine.length} fielded</div>
      </div>`;
    const grid = document.createElement('div'); grid.className = 'codex-grid';
    mine.forEach((c) => {
      const isSeen = seen.has(c.id);
      const row = document.createElement('div'); row.className = 'codex-entry' + (isSeen ? '' : ' unseen');
      const ab = c.ability?.text ? `<div class="codex-abil">${c.ability.text}</div>` : '';
      row.innerHTML = `
        <div class="codex-art" style="--tint:${tint(c.world)}">
          <img src="assets/creatures/${c.id}.png" alt="${c.name}" loading="lazy" onerror="this.style.display='none'">
        </div>
        <div class="codex-body">
          <div class="codex-nm">${c.name}<span class="tierbadge t${c.tier}">T${c.tier}</span></div>
          ${ab}
          <div class="codex-flavor">${c.flavor}</div>
        </div>
        ${isSeen ? '' : '<div class="codex-lock">Not yet fielded</div>'}`;
      grid.appendChild(row);
    });
    sec.appendChild(grid); wrap.appendChild(sec);
  });
  $('#codexList').scrollTop = 0;
  show('codex');
}

// ---- game over ----
function gameOver(won) {
  saveBest(won);
  $('#goEmoji').innerHTML = won
    ? `<img src="assets/ui/trophy.png" alt="" style="width:104px;height:104px;object-fit:contain;filter:drop-shadow(0 6px 12px rgba(20,18,16,.28))">`
    : `<img src="assets/ui/trinkling-sad.png" alt="" style="width:172px;height:172px;object-fit:contain;filter:drop-shadow(0 8px 16px rgba(20,18,16,.34))">`;
  $('#gameover').classList.toggle('defeat', !won);
  $('#goTitle').textContent = won ? 'You took the Cup!' : 'Defeat';
  $('#goText').innerHTML = won
    ? `<b>${game.wins}</b> fights won in <b>${game.turn}</b> turns, <b>${game.hearts}</b>❤️ to spare.`
    : `You reached <b>${game.trophies}</b> <img class="ic" src="assets/ui/trophy.png" alt="trophies"> in the arena over <b>${game.turn}</b> turns. Go again?`;
  if (won && lastRankUp) {
    $('#goText').innerHTML += `<br><span class="rankup-line">✦ Rank up — you are now <b>${lastRankUp}</b>!</span>`;
    SFX.levelup();
  }
  show('gameover');
}

// ---- start / menu / howto ----
// Daily deck: seed derived from the local calendar day so every player gets the SAME never-seen-before deck
// today. Truly random cards across ALL factions (run with coalition=null → src/game.js pool skips the faction
// filter). Fully deterministic & offline. Same date → same number everywhere; only the rollover moment is local.
function dailySeed(d = new Date()) {
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let h = 2166136261 >>> 0;                       // FNV-1a, same fold as src/rng.js hashString
  for (let i = 0; i < ymd.length; i++) { h ^= ymd.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;                                 // 32-bit uint — runSeed must stay numeric
}
function startRun(mode, coalition, daily) {
  easy = mode === 'easy' || (mode !== 'duel' && easyPref);   // Offline honours the Easy-mode setting
  runCoalition = daily ? null : (coalition || null);              // Daily Deck → null coalition = shop draws ALL factions
  duelMode = false; duelStopPoll(); duel = null;
  startMusic();   // ensure the loop is going once a run begins (belt-and-braces for the first-gesture start)
  $('#game').classList.remove('duel', 'waiting');
  $('#endBtn').textContent = 'End Turn ▶'; $('#endBtn').disabled = false;
  $('#continueBtn').textContent = 'Continue ▶'; $('#continueBtn').onclick = singleContinue;
  $('#duelScore').hidden = true;
  runSeed = daily
    ? dailySeed()                                                 // date-seeded: identical run for everyone playing today's Daily Deck
    : ((Date.now() >>> 0) ^ (Math.floor(Math.random() * 1e9) >>> 0));
  game = new GameState(runSeed, { easy, coalition: runCoalition });
  sel = null; selTarget = null; hasBought = false; pendingEvolve = null; pendingMerge = null; pendingFuse = null; suppressReward = false; runWinStreak = 0;
  lastCoachTier = unlockedTier(game.turn); tierMsgTurn = 0;
  $('#tierModal').hidden = true;
  show('game'); render();
  if (AC && AC.state === 'suspended') AC.resume();
}
// ---- deck select (coalition of 2) ----
let pendingMode = 'normal', pendingCoalition = [];
// synergy reads like "HEADLINE — detailed strategy…"; split so the card can show a bold headline
// plus a real strategy blurb (tap-to-expand for the full text) instead of just the first fragment.
const factionTag = (f) => (f.synergy.split('—')[0] || '').trim();
const factionBlurb = (f) => { const i = f.synergy.indexOf('—'); return i >= 0 ? f.synergy.slice(i + 1).trim() : ''; };
function openDeckSelect(mode) {
  pendingMode = mode; pendingCoalition = [];
  const grid = $('#factionGrid'); grid.innerHTML = '';
  FACTIONS.forEach((f) => {
    const d = document.createElement('div'); d.className = 'faction-card'; d.dataset.key = f.key;
    // no description on pick — just the name + short theme tag (full strategy lives in the Codex)
    d.innerHTML = `<span class="fpick">✦</span><div class="fname">${f.name}</div><div class="ftag">${factionTag(f)}</div>`;
    d.onclick = () => toggleFaction(f.key);
    grid.appendChild(d);
  });
  updateDeckBtn(); show('deckselect');
}
function toggleFaction(key) {
  const i = pendingCoalition.indexOf(key);
  if (i >= 0) pendingCoalition.splice(i, 1);
  else { if (pendingCoalition.length >= 2) pendingCoalition.shift(); pendingCoalition.push(key); }
  [...$('#factionGrid').children].forEach((c) => c.classList.toggle('sel', pendingCoalition.includes(c.dataset.key)));
  SFX.tap(); updateDeckBtn();
}
function updateDeckBtn() { const b = $('#deckBegin'), n = pendingCoalition.length; b.disabled = n < 2; b.classList.toggle('primary', n >= 2); b.textContent = n >= 2 ? 'FIGHT' : `${n}/2 selected`; }
$('#deckBegin').onclick = () => { if (pendingCoalition.length < 2) return; const co = [...pendingCoalition]; if (pendingMode === 'duel') enterDuelLobby(co); else if (pendingMode === 'local') enterLocalLobby(co); else startRun(pendingMode, co); };
$('#deckDaily').onclick = () => { if (pendingMode === 'duel') enterDuelLobby(null, true); else if (pendingMode === 'local') enterLocalLobby(null, true); else startRun(pendingMode, null, true); };   // Daily Deck: date-seeded all-factions pool — offline, duel, OR local
$('#deckBack').onclick = () => { show('title'); showBest(); };
$$('[data-start]').forEach((b) => (b.onclick = () => openDeckSelect(b.dataset.start)));
$('#goTitleBtn').onclick = () => { show('title'); showBest(); };
// ---- title: Offline / Online + Settings (Codex / How-to / Feedback / Sound / Easy moved here) ----
const closeSettings = () => ($('#settingsModal').hidden = true);
$('#titleSettings').onclick = () => { updateMuteLabels(); updateEasyLabel(); $('#settingsModal').hidden = false; };
$('#settingsClose').onclick = closeSettings;
$('#onlineBtn').onclick = () => openDeckSelect('duel');
$('#localBtn').onclick = () => openDeckSelect('local');   // Local P2P duel over same-Wi-Fi WebRTC — pick a deck first, then Host/Join
// simple connection indicator on the Online button (green dot when the device is online)
function updateOnlineDot() { const d = $('#onlineDot'); if (d) d.classList.toggle('on', navigator.onLine); }
window.addEventListener('online', updateOnlineDot);
window.addEventListener('offline', updateOnlineDot);
updateOnlineDot();
$('#settingsHowTo').onclick = () => { closeSettings(); $('#howModal').hidden = false; };
$('#settingsTriggers').onclick = () => { closeSettings(); openTriggers(); };
$('#triggersClose').onclick = () => { SFX.tap(); $('#triggersModal').hidden = true; };
$('#settingsEasy').onclick = () => { easyPref = !easyPref; localStorage.setItem('cc_easy', easyPref ? '1' : '0'); updateEasyLabel(); };
function updateEasyLabel() { const b = $('#settingsEasy'); if (b) b.textContent = 'Easy mode: ' + (easyPref ? 'On (7 hearts)' : 'Off'); }
let easyPref = localStorage.getItem('cc_easy') === '1';
$('#howClose').onclick = () => ($('#howModal').hidden = true);

// menu
$('#menuBtn').onclick = () => { updateMuteLabels(); $('#menuModal').hidden = false; };
$('#menuResume').onclick = () => ($('#menuModal').hidden = true);
$('#menuQuit').onclick = () => { $('#menuModal').hidden = true; if (duelMode) { duelStopPoll(); duelMode = false; duel = null; duelGame = null; } lReset(); show('title'); showBest(); };   // QA: stop the duel poll so we're not yanked back into the match
$('#menuMute').onclick = toggleMute;
$('#settingsSound').onclick = toggleMute;
function toggleMute() { muted = !muted; localStorage.setItem('cc_mute', muted ? '1' : '0'); updateMuteLabels(); if (muted) { if (bgm) bgm.pause(); } else { startMusic(); SFX.tap(); } }
function updateMuteLabels() {
  const lbl = muted ? 'Sound: Off' : 'Sound: On';
  const mm = $('#menuMute'); if (mm) mm.textContent = lbl;
  const ss = $('#settingsSound'); if (ss) ss.textContent = lbl;
}

// ---- in-app feedback (saved server-side to feedback.jsonl) ----
let recog = null, recogOn = false;
// Progressive enhancement only: the textarea is the primary path (phone keyboards have a dictation mic
// with zero permissions). Offer the Web Speech button only where it actually works.
function micAvailable() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const okProto = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return !!SR && okProto;
}
function setupMic() {
  const btn = $('#fbMic');
  if (!micAvailable()) { btn.hidden = true; return; }
  btn.hidden = false; btn.innerHTML = '<img class="ic" src="assets/ui/mic.png" alt=""> Speak'; btn.onclick = toggleMic;
}
function stopRecog() { if (recog) { try { recog.stop(); } catch {} } recogOn = false; }
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (recogOn) { stopRecog(); return; }
  recog = new SR(); recog.lang = 'en-US'; recog.interimResults = true; recog.continuous = true;
  const ta = $('#fbText');
  let base = ta.value;
  recog.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) base = (base ? base + ' ' : '') + r[0].transcript.trim();
      else interim += r[0].transcript;
    }
    ta.value = (base + (interim ? (base ? ' ' : '') + interim : '')).slice(0, 1000);
  };
  recog.onend = () => { recogOn = false; $('#fbMic').innerHTML = '<img class="ic" src="assets/ui/mic.png" alt=""> Speak'; };
  recog.onerror = () => { recogOn = false; $('#fbMic').innerHTML = '<img class="ic" src="assets/ui/mic.png" alt=""> Speak'; };
  try { recog.start(); recogOn = true; $('#fbMic').textContent = 'Stop'; } catch {}
}
function openFeedback() {
  $('#fbText').value = ''; $('#fbStatus').textContent = ''; $('#fbSend').disabled = false;
  setupMic();
  $('#feedbackModal').hidden = false;
  setTimeout(() => { try { $('#fbText').focus(); } catch {} }, 60);
}
function closeFeedback() { stopRecog(); $('#feedbackModal').hidden = true; }
async function sendFeedback() {
  stopRecog();
  const ta = $('#fbText');
  const message = (ta.value || '').trim().slice(0, 1000);
  if (!message) { $('#fbStatus').textContent = 'Type a little something first 🙂'; return; }
  const screen = (document.querySelector('.screen.show') || {}).id || '';
  const payload = {
    message, screen,
    turn: game ? game.turn : null,
    coalition: (game && game.coalition) || runCoalition || null,
    squad: game ? game.squad.filter(Boolean).map((c) => ({ id: c.defId, lvl: c.level })) : [],
    hearts: game ? game.hearts : null,
    trophies: game ? game.trophies : null,
    ts: new Date().toISOString(),
    ua: navigator.userAgent,
  };
  $('#fbSend').disabled = true; $('#fbStatus').textContent = 'Sending…';
  try {
    const r = await fetch(SERVER_BASE + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('bad-status');
    $('#fbStatus').textContent = 'Thanks! 💜';
    ta.value = '';
    setTimeout(closeFeedback, 900);
  } catch {
    $('#fbSend').disabled = false;
    $('#fbStatus').textContent = 'Could not send — check your connection and try again.'; // keep the text so nothing is lost
  }
}
$('#settingsFeedback').onclick = () => { closeSettings(); openFeedback(); };
$('#fbOpenBattle').onclick = openFeedback;   // mid-fight feedback (the shop ⚙️ path already exists)
$('#fbOpenMenu').onclick = () => { $('#menuModal').hidden = true; openFeedback(); };
$('#fbClose').onclick = closeFeedback;
$('#fbSend').onclick = sendFeedback;
$('#settingsCodex').onclick = () => { closeSettings(); openCodex(); };
$('#codexBack').onclick = () => { show('title'); showBest(); };

// ===== LIVE DUEL (best-of-5 vs a friend on the LAN) =====
let duelMode = false, duel = null, duelPoll = null, duelLocalPhase = null, duelGame = null;
const DUEL_BASE_GOLD = 10, DUEL_GOLD_PER_ROUND = 1, DUEL_GOLD_CAP = 14;   // was 12+8/round, then 10+3 — still too much late (feedback). Now +1/round, hard-capped at 14 (still affords one buy-fuse: 3+10=13).

// Duel/feedback API base: SAME-ORIGIN when running locally or on the LAN server (localhost / a bare IP);
// the deployed Railway server when the static client is served from a real domain (e.g. GitHub Pages).
const DUEL_SERVER = 'https://trinklings-production.up.railway.app';
const SERVER_BASE = (/^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) ? '' : DUEL_SERVER;
const api = (path, body) => fetch(SERVER_BASE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());
function randomCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

let pendingDuelCoalition = null, pendingDuelDaily = false;
function enterDuelLobby(coalition, daily) { pendingDuelCoalition = daily ? null : coalition; pendingDuelDaily = !!daily; $('#duelCode').value = randomCode(); $('#duelName').value = ''; $('#duelStatus').textContent = ''; show('duel'); }
$('#duelBack').onclick = () => { duelStopPoll(); duel = null; duelMode = false; show('title'); showBest(); };

$('#duelJoin').onclick = async () => {
  const code = ($('#duelCode').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const name = (($('#duelName').value || '').slice(0, 12) || ('Player-' + randomCode()));   // QA: unique default so two blank-name players don't collide on reconnect-by-name
  if (code.length < 3) { $('#duelStatus').textContent = 'Enter a room code (at least 3 characters).'; return; }
  $('#duelStatus').textContent = 'Joining…';
  let r; try { r = await api('/duel/join', { code, name }); } catch { $('#duelStatus').textContent = 'Could not reach the server.'; return; }
  if (r.error === 'full') { $('#duelStatus').textContent = 'That room is full (2 players). Try another code.'; return; }
  if (r.error) { $('#duelStatus').textContent = 'Could not join — try again.'; return; }
  duel = { code, id: r.id, slot: r.slot, name, scores: r.scores, round: r.round, oppName: r.oppName, coalition: pendingDuelCoalition, daily: pendingDuelDaily };
  duelMode = true; duelLocalPhase = 'lobby'; duelGame = null;
  $('#duelStatus').innerHTML = r.players < 2 ? `In room <b>${code}</b> — waiting for a friend to join…` : 'Starting…';
  duelStartPoll();
};

let duelClock = null;
function duelStartPoll() { duelStopPoll(); duelPoll = setInterval(duelTick, 1200); duelClock = setInterval(duelClockTick, 500); duelTick(); }
function duelStopPoll() { if (duelPoll) clearInterval(duelPoll); duelPoll = null; if (duelClock) clearInterval(duelClock); duelClock = null; }
// 0.5s clock: show the shop-turn countdown and AUTO-READY the squad when it hits zero (so a turn can't stall).
function duelClockTick() {
  if (!duel || duelLocalPhase !== 'build' || !duel.deadline) return;
  const rem = Math.max(0, Math.ceil((duel.deadline - Date.now()) / 1000));
  const el = $('#duelTimer'); if (el) { el.textContent = `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`; el.classList.toggle('low', rem <= 10); }
  if (rem <= 0 && !duelReadySent) { duelReadySent = true; duelReady(); }
}
let duelReadySent = false;

async function duelTick() {
  if (!duel) return;
  let s; try { s = await api(`/duel/state?code=${duel.code}&id=${duel.id}`); } catch { return; }
  if (!s || s.error) return;
  duel.scores = s.scores; duel.round = s.round; duel.slot = s.slot; duel.oppName = s.oppName || duel.oppName; duel.deadline = s.deadline || duel.deadline;
  duel.oppReady = !!s.oppReady;
  if (duelMode && (duelLocalPhase === 'build' || duelLocalPhase === 'waiting')) renderDuelHeader();   // refresh the opponent-ready indicator
  if (duelLocalPhase === 'lobby') {
    if (s.players >= 2 && s.phase === 'build') duelBeginRound(s);
    // reconnected into a round that already resolved while we were away → play it out instead of deadlocking
    else if ((s.phase === 'result' || s.phase === 'over') && s.battle) { duelLocalPhase = 'battle'; duelPlay(s); }
    else $('#duelStatus').innerHTML = `In room <b>${duel.code}</b> — waiting for a friend…`;
  } else if (duelLocalPhase === 'waiting' || duelLocalPhase === 'build') {
    // 'build' too: if the server force-resolved the round past its deadline, don't hard-stick on the shop — play it out.
    if ((s.phase === 'result' || s.phase === 'over') && s.battle) { duelLocalPhase = 'battle'; duelPlay(s); }
  } else if (duelLocalPhase === 'result') {
    if (s.phase === 'build') duelBeginRound(s);
  }
}

function duelBeginRound(s) {
  duelLocalPhase = 'build';
  duel.round = s.round; duel.scores = s.scores; duel.hearts = s.hearts || duel.hearts; duel.oppName = s.oppName || duel.oppName;
  duel.deadline = s.deadline || duel.deadline; duelReadySent = false;   // fresh turn timer
  if (!duelGame) {
    // Daily Deck duel → date-seeded (both players share the opening shop, then diverge organically) with the all-factions pool
    const duelSeed = duel.daily ? dailySeed() : (((Date.now() >>> 0) ^ (duel.slot * 40503)) >>> 0);
    duelGame = new GameState(duelSeed, { coalition: duel.daily ? null : duel.coalition }); // one squad for the whole match
  } else {
    for (const c of duelGame.livingSquad()) duelGame.fireShop(c, 'onEndTurn'); // scalers grow between rounds
  }
  game = duelGame;
  const prevTurn = game.turn || 1;
  game.turn = s.round;                                            // tiers climb 2-per-round, exactly like single-player
  game.gold = Math.min(DUEL_GOLD_CAP, DUEL_BASE_GOLD + (s.round - 1) * DUEL_GOLD_PER_ROUND); // grows +1/round then plateaus at the cap — the SQUAD carries over
  for (const c of game.livingSquad()) game.fireShop(c, 'onStartTurn'); // economy Trinklings (e.g. Nib gold) fire each round, matching single-player startTurn
  game.rollShop(true);
  sel = null; selTarget = null;
  $('#game').classList.remove('waiting');   // unlock the board for the new build phase
  $('#endBtn').textContent = 'Ready ✓'; $('#endBtn').disabled = false;
  $('#battleResult').hidden = true; $('#duelScore').hidden = true;
  show('game'); render();
  maybeTierModal(prevTurn, game.turn);   // same tier-unlock modal as solo
  hint(s.round > 1 ? 'Your squad carried over! Spend your gold to upgrade, then Ready ✓' : 'Build your squad, then hit Ready ✓');
}

function renderDuelHeader() {
  const h = (duel && duel.hearts) || [CONFIG.duelHearts, CONFIG.duelHearts];
  const me = h[duel.slot] ?? CONFIG.duelHearts, op = h[1 - duel.slot] ?? CONFIG.duelHearts;
  $('#hudHearts').textContent = me;   // duel HUD mirrors solo: your lives in the top bar
  $('#coach').className = 'coach show';
  const oppRdy = duel.oppReady ? '<b class="opp-ready">✓ ready</b>' : '<span class="opp-wait">…building</span>';
  $('#coach').innerHTML = `${icon('sword')} Round ${duel.round || 1} · You ${icon('heart')}<b>${me}</b> – <b>${op}</b>${icon('heart')} ${duel.oppName || 'Rival'} ${oppRdy} · <span id="duelTimer" class="duel-timer"></span>`;
}

async function duelReady() {
  if (!duelGame || duelLocalPhase !== 'build') return;   // ignore a stray auto-ready outside the build phase
  const team = duelGame.squadForBattle();
  if (!team.length) { hint('Buy at least one Trinkling first!'); return; }
  duelLocalPhase = 'waiting';
  clearSel(); $('#game').classList.add('waiting');   // lock the board — the team is snapshot until you Unready
  $('#endBtn').textContent = 'Unready'; $('#endBtn').disabled = false;   // tap again to un-ready + edit (per feedback)
  hint('Ready! Waiting for your opponent… (tap Unready to change your team)');
  let s;
  try { s = await api('/duel/ready', { code: duel.code, id: duel.id, team }); }
  catch {   // request failed — roll back to build so the player can re-submit before the deadline
    duelLocalPhase = 'build'; $('#game').classList.remove('waiting');
    $('#endBtn').textContent = 'Ready ✓'; $('#endBtn').disabled = false;
    hint('Couldn’t reach the server — tap Ready again.'); return;
  }
  if (s && (s.phase === 'result' || s.phase === 'over')) { duelLocalPhase = 'battle'; duelPlay(s); }
}
// Un-ready: only valid while waiting (you readied, the round hasn't resolved) — unlock the board to edit again.
async function duelUnready() {
  if (duelLocalPhase !== 'waiting') return;
  duelLocalPhase = 'build'; $('#game').classList.remove('waiting');
  $('#endBtn').textContent = 'Ready ✓'; $('#endBtn').disabled = false;
  hint('Un-readied — tweak your team, then Ready ✓ again.');
  try { await api('/duel/unready', { code: duel.code, id: duel.id }); } catch {}
}

function duelPlay(s) { duelStopPoll(); document.querySelector('.vs-label').textContent = 'Fight!'; $('#enemyLabel').textContent = duel.oppName || 'Rival'; runPlayback(s.battle.log, duel.slot, () => duelShowResult(s)); }

function duelShowResult(s) {
  applyResultScreen(s.roundResult);
  duel.hearts = s.hearts || duel.hearts;
  const h = s.hearts || [CONFIG.duelHearts, CONFIG.duelHearts];
  const me = h[duel.slot], op = h[1 - duel.slot];
  const ds = $('#duelScore'); ds.hidden = false; ds.innerHTML = `<span class="me">You ${icon('heart')}${me}</span> – <span class="op">${icon('heart')}${op} ${duel.oppName || 'Rival'}</span>`;
  duelLocalPhase = 'result';
  if (s.matchOver) {
    const iWon = s.winnerSlot === duel.slot;
    $('#continueBtn').textContent = iWon ? 'You won the match! 🏆' : 'See result';
    $('#continueBtn').onclick = () => duelEnd(iWon);
  } else {
    $('#continueBtn').textContent = 'Next round ▶';
    $('#continueBtn').onclick = duelNextRound;
  }
  $('#battleResult').hidden = false;
}

async function duelNextRound() {
  $('#continueBtn').textContent = 'Waiting…';
  $('#resultBanner').textContent = 'Waiting for opponent…';
  try { await api('/duel/next', { code: duel.code, id: duel.id }); } catch {}
  duelStartPoll(); // tick starts the next round once both players advance
}

function duelEnd(iWon) {
  duelStopPoll(); duelMode = false; duel = null; duelGame = null;
  $('#duelScore').hidden = true; $('#game').classList.remove('duel', 'waiting');
  $('#continueBtn').textContent = 'Continue ▶'; $('#continueBtn').onclick = singleContinue;
  $('#goEmoji').innerHTML = iWon
    ? `<img src="assets/ui/trophy.png" alt="" style="width:104px;height:104px;object-fit:contain;filter:drop-shadow(0 6px 12px rgba(20,18,16,.28))">`
    : `<img src="assets/ui/trinkling-sad.png" alt="" style="width:172px;height:172px;object-fit:contain;filter:drop-shadow(0 8px 16px rgba(20,18,16,.34))">`;
  $('#gameover').classList.toggle('defeat', !iWon);   // adopt the warm 'defeat' card styling + clears a stale one on a win
  $('#goTitle').textContent = iWon ? 'You won the duel!' : 'Duel over';
  $('#goText').textContent = iWon ? 'Nicely played — you took the match! Fancy a rematch?' : 'Good game! Want a rematch?';
  $('#goTitleBtn').textContent = 'Main menu';
  show('gameover');
}

// ================= LOCAL P2P DUEL (WebRTC over same Wi-Fi; HOST is the battle authority) =================
// Two phones connect directly via a WebRTC data channel. A short code is exchanged through the signaling relay
// (/rtc/*), then the whole match runs peer-to-peer: each peer keeps its OWN GameState/shop; on both-ready the
// HOST runs simulateBattle and broadcasts the log, and both sides play it back from their own slot. Reuses the
// shared battle playback + result screens (runPlayback/applyResultScreen), just with a P2P transport.
let lMode = false, lHost = false, lSlot = 0, lPc = null, lDc = null, lGame = null;
let lCoalition = null, lDaily = false, lRound = 1, lHearts = [CONFIG.duelHearts || 6, CONFIG.duelHearts || 6];
let lName = 'You', lOppName = 'Rival', lMyTeam = null, lOppTeam = null, lReady = false, lPhase = 'lobby';
let lMyNext = false, lOppNext = false, lPollTimer = null;
const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const rtcApi = (path, body) => fetch(SERVER_BASE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());

function lReset() {
  if (lPollTimer) { clearInterval(lPollTimer); lPollTimer = null; }
  try { if (lDc) lDc.close(); } catch {} try { if (lPc) lPc.close(); } catch {}
  lPc = null; lDc = null; lMode = false; lGame = null; lReady = false; lRound = 1;
  lHearts = [CONFIG.duelHearts || 6, CONFIG.duelHearts || 6]; lMyTeam = lOppTeam = null; lMyNext = lOppNext = false; lPhase = 'lobby';
}
function enterLocalLobby(coalition, daily) {
  lReset(); lCoalition = daily ? null : coalition; lDaily = !!daily;
  $('#localCode').value = ''; $('#localStatus').textContent = ''; $('#localHostView').hidden = true; $('#localPick').hidden = false;
  show('local');
}
function waitIce(pc) {   // vanilla ICE: resolve once candidate gathering completes (or a short timeout)
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => { const t = setTimeout(res, 2600); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }); });
}
function lSend(m) { try { if (lDc && lDc.readyState === 'open') lDc.send(JSON.stringify(m)); } catch {} }
function wireLocalChannel() {
  lDc.onopen = () => { lMode = true; lSend({ t: 'hello', name: lName }); if (lHost) { lSend({ t: 'begin', round: 1 }); localBeginRound(1); } };
  lDc.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onLocalMsg(m); };
  lDc.onclose = () => { if (lMode && lPhase !== 'result') hint('Peer disconnected.'); };
}
async function localStartHost() {
  lName = ($('#localName').value || 'Host').slice(0, 12); lHost = true; lSlot = 0;
  const code = randomCode();
  $('#localStatus').textContent = 'Setting up…';
  try {
    lPc = new RTCPeerConnection(RTC_CFG);
    lDc = lPc.createDataChannel('game'); wireLocalChannel();
    await lPc.setLocalDescription(await lPc.createOffer()); await waitIce(lPc);
    await rtcApi('/rtc/offer', { code, sdp: JSON.stringify(lPc.localDescription) });
  } catch { $('#localStatus').textContent = 'Setup failed (need internet to exchange the code).'; return; }
  $('#localPick').hidden = true; $('#localHostView').hidden = false; $('#localCodeShow').textContent = code;
  try { drawQR($('#localQR'), location.origin + location.pathname + '?local=' + code); } catch {}
  $('#localStatus').textContent = 'Waiting for a friend to join…';
  lPollTimer = setInterval(async () => {
    let a; try { a = await rtcApi('/rtc/answer?code=' + code); } catch { return; }
    if (a && a.sdp) { clearInterval(lPollTimer); lPollTimer = null; try { await lPc.setRemoteDescription(JSON.parse(a.sdp)); $('#localStatus').textContent = 'Connecting…'; } catch { $('#localStatus').textContent = 'Connection failed.'; } }
  }, 1200);
}
async function localStartJoin(code) {
  code = (code || $('#localCode').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (!code) { $('#localStatus').textContent = 'Enter the host’s code.'; return; }
  lName = ($('#localName').value || 'Player').slice(0, 12); lHost = false; lSlot = 1;
  $('#localStatus').textContent = 'Connecting…';
  let o; try { o = await rtcApi('/rtc/offer?code=' + code); } catch { $('#localStatus').textContent = 'Could not reach the signaling relay.'; return; }
  if (!o || !o.sdp) { $('#localStatus').textContent = 'No host found for that code.'; return; }
  try {
    lPc = new RTCPeerConnection(RTC_CFG);
    lPc.addEventListener('datachannel', (ev) => { lDc = ev.channel; wireLocalChannel(); });
    await lPc.setRemoteDescription(JSON.parse(o.sdp));
    await lPc.setLocalDescription(await lPc.createAnswer()); await waitIce(lPc);
    await rtcApi('/rtc/answer', { code, sdp: JSON.stringify(lPc.localDescription) });
    $('#localStatus').textContent = 'Connecting to host…';
  } catch { $('#localStatus').textContent = 'Connection failed.'; }
}
function localHeader() {
  $('#hudHearts').textContent = lHearts[lSlot];
  $('#coach').className = 'coach show';
  $('#coach').innerHTML = `${icon('sword')} Round ${lRound} · You ${icon('heart')}<b>${lHearts[lSlot]}</b> – <b>${lHearts[1 - lSlot]}</b>${icon('heart')} ${lOppName}`;
}
function localBeginRound(round) {
  lRound = round; lPhase = 'build'; lReady = false; lOppTeam = null; lMyNext = lOppNext = false;
  if (!lGame) {
    const seed = lDaily ? dailySeed() : (((Date.now() >>> 0) ^ (lSlot * 40503 + 7)) >>> 0);
    lGame = new GameState(seed, { coalition: lDaily ? null : lCoalition });
  } else { for (const c of lGame.livingSquad()) lGame.fireShop(c, 'onEndTurn'); }
  game = lGame;
  const prevTurn = game.turn || 1;
  game.turn = round;
  game.gold = Math.min(DUEL_GOLD_CAP, DUEL_BASE_GOLD + (round - 1) * DUEL_GOLD_PER_ROUND);
  for (const c of game.livingSquad()) game.fireShop(c, 'onStartTurn');
  game.rollShop(true);
  sel = null; selTarget = null;
  $('#game').classList.add('duel'); $('#game').classList.remove('waiting');
  $('#endBtn').textContent = 'Ready ✓'; $('#endBtn').disabled = false;
  $('#battleResult').hidden = true; $('#duelScore').hidden = true;
  localHeader(); show('game'); render();
  maybeTierModal(prevTurn, game.turn);
  hint(round > 1 ? 'Your squad carried over! Upgrade, then Ready ✓' : 'Build your squad, then Ready ✓');
}
function localReady() {
  if (!lGame || lPhase !== 'build') return;
  const team = lGame.squadForBattle();
  if (!team.length) { hint('Buy at least one Trinkling first!'); return; }
  lMyTeam = team; lReady = true; lPhase = 'waiting';
  clearSel(); $('#game').classList.add('waiting');
  $('#endBtn').textContent = 'Unready'; $('#endBtn').disabled = false;
  hint('Ready! Waiting for your opponent… (tap Unready to change your team)');
  lSend({ t: 'ready', team }); localTryResolve();
}
function localUnready() {
  if (lPhase !== 'waiting') return;
  lReady = false; lPhase = 'build'; $('#game').classList.remove('waiting');
  $('#endBtn').textContent = 'Ready ✓'; $('#endBtn').disabled = false;
  hint('Un-readied — tweak your team, then Ready ✓ again.');
  lSend({ t: 'unready' });
}
function localTryResolve() {   // host-only: when host is ready AND has the joiner's team, resolve the round
  if (!lHost || !lReady || !lOppTeam) return;
  resetUid(1);
  const seed = ((lDaily ? dailySeed() : (Date.now() >>> 0)) ^ Math.imul(lRound, 2654435761)) >>> 0;
  const res = simulateBattle(lMyTeam, lOppTeam, seed, lRound);   // teamA = host (slot 0), teamB = joiner (slot 1)
  if (res.result === 'win') lHearts[1] -= 1; else if (res.result === 'lose') lHearts[0] -= 1;
  const matchOver = Math.min(lHearts[0], lHearts[1]) <= 0;
  const payload = { t: 'battle', log: res.log, hostResult: res.result, hearts: lHearts.slice(), round: lRound, matchOver, winnerSlot: matchOver ? (lHearts[0] > lHearts[1] ? 0 : 1) : null };
  lSend(payload); localPlay(payload);
}
function localPlay(p) {
  lPhase = 'battle'; lHearts = p.hearts;
  const myResult = lSlot === 0 ? p.hostResult : (p.hostResult === 'win' ? 'lose' : p.hostResult === 'lose' ? 'win' : 'draw');
  document.querySelector('.vs-label').textContent = 'Fight!'; $('#enemyLabel').textContent = lOppName;
  runPlayback(p.log, lSlot, () => localShowResult(myResult, p));
}
function localShowResult(myResult, p) {
  applyResultScreen(myResult);
  const me = lHearts[lSlot], op = lHearts[1 - lSlot];
  const ds = $('#duelScore'); if (ds) { ds.hidden = false; ds.innerHTML = `<span class="me">You ${icon('heart')}${me}</span> – <span class="op">${icon('heart')}${op} ${lOppName}</span>`; }
  lPhase = 'result'; $('#continueBtn').disabled = false;
  if (p.matchOver) { const iWon = p.winnerSlot === lSlot; $('#continueBtn').textContent = iWon ? 'You won the match! 🏆' : 'See result'; $('#continueBtn').onclick = () => localEnd(iWon); }
  else { $('#continueBtn').textContent = 'Next round ▶'; $('#continueBtn').onclick = localNext; }
}
function localNext() {
  lMyNext = true; $('#continueBtn').disabled = true; hint('Waiting for your opponent…');
  lSend({ t: 'next' }); localTryAdvance();
}
function localTryAdvance() { if (lHost && lMyNext && lOppNext) { const nr = lRound + 1; lSend({ t: 'begin', round: nr }); localBeginRound(nr); } }
function localEnd(iWon) {
  lReset(); game = null;
  $('#game').classList.remove('duel', 'waiting');
  $('#continueBtn').textContent = 'Continue ▶'; $('#continueBtn').onclick = singleContinue; $('#continueBtn').disabled = false;
  $('#goEmoji').innerHTML = iWon
    ? `<img src="assets/ui/trophy.png" alt="" style="width:104px;height:104px;object-fit:contain;filter:drop-shadow(0 6px 12px rgba(20,18,16,.28))">`
    : `<img src="assets/ui/trinkling-sad.png" alt="" style="width:172px;height:172px;object-fit:contain;filter:drop-shadow(0 8px 16px rgba(20,18,16,.34))">`;
  $('#gameover').classList.toggle('defeat', !iWon);
  $('#goTitle').textContent = iWon ? 'You won the duel!' : 'Duel over';
  $('#goText').textContent = iWon ? 'Nicely played — you took the local match!' : 'Good game! Want a rematch?';
  $('#goTitleBtn').textContent = 'Main menu';
  show('gameover');
}
function onLocalMsg(m) {
  if (m.t === 'hello') { lOppName = m.name || 'Rival'; if (lPhase !== 'lobby') localHeader(); }
  else if (m.t === 'ready') { lOppTeam = m.team; if (lHost) localTryResolve(); }
  else if (m.t === 'unready') { lOppTeam = null; }
  else if (m.t === 'battle') { localPlay(m); }        // joiner: play the host-resolved battle from slot 1
  else if (m.t === 'next') { lOppNext = true; if (lHost) localTryAdvance(); }
  else if (m.t === 'begin') { localBeginRound(m.round); }
}
$('#localHostBtn') && ($('#localHostBtn').onclick = localStartHost);
$('#localJoinBtn') && ($('#localJoinBtn').onclick = () => localStartJoin());
$('#localBack') && ($('#localBack').onclick = () => { lReset(); show('title'); showBest(); });
// Deep link: scanning the host's QR (or opening the shared URL) lands on ?local=CODE → open the Join lobby
// with the code pre-filled (all-factions deck by default; the joiner just taps Join).
(function () { try { const c = new URLSearchParams(location.search).get('local'); if (c) { enterLocalLobby(null, false); $('#localCode').value = c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); $('#localStatus').textContent = 'Tap Join to connect to the host.'; } } catch {} })();

// Compact byte-mode QR encoder — single-block ECC-L, versions 2–6, mask 0. Enough for a ~46-char join URL,
// self-contained (no external library, CSP-safe). Returns an n×n boolean matrix, or null if the text is too long.
function qrEncode(text) {
  const bytes = []; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c < 128) bytes.push(c); else { bytes.push(38); } }  // ASCII only (URL); non-ASCII → '&'
  // [version]: {size, dataCW, ecCW, align}. Single ECC-L block for v2–v6.
  const V = { 2: [25, 34, 10, 18], 3: [29, 55, 15, 22], 4: [33, 80, 20, 26], 5: [37, 108, 26, 30], 6: [41, 136, 18, 34] };
  let ver = 0; for (const v of [2, 3, 4, 5, 6]) { if (bytes.length + 2 <= V[v][1]) { ver = v; break; } }
  if (!ver) return null;
  const [size, dataCW, ecCW] = V[ver];
  // --- bit stream: mode 0100 + 8-bit length + data + terminator + pad to a byte, then EC/11 pad codewords ---
  const bits = []; const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  put(4, 4); put(bytes.length, 8); for (const b of bytes) put(b, 8); put(0, 4);
  while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }
  for (let pad = 0; data.length < dataCW; pad++) data.push(pad % 2 ? 0x11 : 0xEC);
  // --- GF(256) + Reed–Solomon EC codewords ---
  const EXP = new Array(512), LOG = new Array(256); { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
  const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  let gen = [1]; for (let i = 0; i < ecCW; i++) { const ng = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { ng[j] ^= mul(gen[j], EXP[i]); ng[j + 1] ^= gen[j]; } gen = ng; }
  const ec = new Array(ecCW).fill(0); for (const d of data) { const f = d ^ ec[0]; ec.shift(); ec.push(0); if (f) for (let j = 0; j < ecCW; j++) ec[j] ^= mul(gen[j], f); }
  const all = data.concat(ec);
  // --- matrix ---
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const y = r + i, x = c + j; if (y < 0 || x < 0 || y >= size || x >= size) continue; const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)); m[y][x] = on ? 1 : 0; } };
  fn(0, 0); fn(0, size - 7); fn(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { if (m[6][i] === null) m[6][i] = i % 2 === 0 ? 1 : 0; if (m[i][6] === null) m[i][6] = i % 2 === 0 ? 1 : 0; }
  const ap = V[ver][3]; for (const [r, c] of [[ap, ap]]) for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) m[r + i][c + j] = (Math.max(Math.abs(i), Math.abs(j)) !== 1) ? 1 : 0;
  m[size - 8][8] = 1;   // dark module
  // reserve format areas (set to 0 for now, filled after)
  for (let i = 0; i < 9; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; }
  for (let i = size - 8; i < size; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; }
  // --- place data (mask 0: (r+c)%2==0), zig-zag up/down from bottom-right ---
  let bi = 0; const bit = () => { const v = bi < all.length * 8 ? (all[bi >> 3] >> (7 - (bi & 7))) & 1 : 0; bi++; return v; };
  for (let col = size - 1; col > 0; col -= 2) { if (col === 6) col--; for (let t = 0; t < size; t++) { const up = ((size - 1 - col) & 2) === 0; const row = up ? size - 1 - t : t; for (let c2 = 0; c2 < 2; c2++) { const cc = col - c2; if (m[row][cc] !== null) continue; let d = bit(); if (((row + cc) % 2) === 0) d ^= 1; m[row][cc] = d; } } }
  // --- format info: ECC-L (01) + mask 0 (000) = 5 data bits → BCH → 15 bits, XOR 0x5412 ---
  let fmt = 0b01000; { let v = fmt << 10; const g = 0x537; for (let i = 4; i >= 0; i--) if ((v >> (10 + i)) & 1) v ^= g << i; fmt = ((fmt << 10) | v) ^ 0x5412; }
  const fbits = []; for (let i = 14; i >= 0; i--) fbits.push((fmt >> i) & 1);
  const fpos1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const fpos2 = [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]];
  for (let i = 0; i < 15; i++) { m[fpos1[i][0]][fpos1[i][1]] = fbits[i]; m[fpos2[i][0]][fpos2[i][1]] = fbits[i]; }
  return m;
}
// Minimal QR (byte mode, versions 2–6, ECC-L, mask 0) for the join URL — self-contained, no external lib.
function drawQR(canvas, text) {
  if (!canvas) return; const q = qrEncode(text); if (!q) return; const n = q.length;
  const ctx = canvas.getContext('2d'); const S = canvas.width, quiet = 4, mod = S / (n + quiet * 2);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S); ctx.fillStyle = '#101c2e';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q[y][x]) ctx.fillRect(Math.floor((x + quiet) * mod), Math.floor((y + quiet) * mod), Math.ceil(mod), Math.ceil(mod));
}

// ---- connect hint on title (shows the exact phone URL from the server) ----
(async function initTitle() {
  updateMuteLabels();
  showBest();
  // how-to prices read from CONFIG so they never drift from the real costs (items are now 2, not 3)
  const bc = $('#howBuyCost'); if (bc) bc.textContent = CONFIG.buyCost;
  const sc = $('#howSnackCost'); if (sc) sc.textContent = CONFIG.snackCost;
  const el = $('#connectHint');
  if (!el) return;   // connect hint was removed from the title
  const onPhone = !(location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  if (onPhone) { el.innerHTML = `📱 You're on <b>${location.host}</b> — bookmark it to play anytime.`; return; }
  let lan = null;
  // /whoami only exists on the local LAN server — skip it when the client is served from a real domain.
  if (SERVER_BASE === '') { try { lan = (await (await fetch('/whoami')).json()).lan; } catch {} }
  if (lan && !lan.includes('localhost')) {
    el.innerHTML = `📱 Play on your phone (same Wi-Fi): <b id="lanUrl">${lan}</b> <button class="btn small" id="copyLan">Copy</button>`;
    $('#copyLan').onclick = async () => { try { await navigator.clipboard.writeText(lan); $('#copyLan').textContent = 'Copied!'; } catch { $('#copyLan').textContent = lan; } };
  } else {
    el.innerHTML = `📱 To play on your phone, open this Mac’s LAN address (shown in the terminal) — same Wi-Fi.`;
  }
})();

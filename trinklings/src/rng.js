// Deterministic seeded PRNG (mulberry32). Same seed → same sequence, on Node and in the browser.
// Every random decision in Trinklings (shop rolls, tie-breaks, random-target abilities) draws
// from one of these so battles are reproducible and golden replays are stable (FB-R20).

export class RNG {
  constructor(seed = 1) {
    // Normalise seed to a 32-bit unsigned int. Accepts number or string.
    if (typeof seed === 'string') seed = hashString(seed);
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9; // avoid the degenerate 0 seed
  }

  // float in [0, 1)
  next() {
    let t = (this.state += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // integer in [0, n)
  int(n) {
    return Math.floor(this.next() * n);
  }

  // inclusive integer in [min, max]
  range(min, max) {
    return min + this.int(max - min + 1);
  }

  // true with probability p (0..1)
  chance(p) {
    return this.next() < p;
  }

  // pick one element (does not mutate)
  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[this.int(arr.length)];
  }

  // pick k distinct elements (returns a new array)
  sample(arr, k) {
    const copy = arr.slice();
    this.shuffle(copy);
    return copy.slice(0, k);
  }

  // Fisher–Yates shuffle in place
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Snapshot / restore for serializable game state
  clone() {
    const r = new RNG(1);
    r.state = this.state;
    return r;
  }
}

export function hashString(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

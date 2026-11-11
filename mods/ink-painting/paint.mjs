// The paintings, pure (no herdr imports) so node --test can run them.
//
// A sheet is { subject, seed }: compose() turns it into the same list of steps every time. A step
// is a stroke or a small group of strokes (a stalk segment and its node, a leaf, a ridge's wash, a
// blossom). The main subject comes first, then small extras (leaves, birds, buds, grass) up to a
// cap. Each step renders to a small SVG cropped to its own box (stepSvg), drawn as an alpha mask:
// the mod tints it with the theme's ink (foreground) or seal red (accent), so the files hold no color.
//
// Coordinates are a 720 x 1400 portrait sheet (W x H below); the mod scales it to its block.

export const W = 720;
export const H = 1400; // a tall sheet: about the shape of the panel beside the terminal
export const SUBJECTS = ["bamboo", "mountains", "plum"];

/** mulberry32: a small seeded generator in [0, 1). */
export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit hash of integers (FNV-1a with a final mix). */
export function hash(...ns) {
  let h = 2166136261;
  for (const n of ns) {
    h ^= n | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A quadratic bend from (x0, y0) to (x1, y1): bend > 0 bows to the left of travel.
const line = (x0, y0, x1, y1, bend = 0) => {
  const mx = (x0 + x1) / 2 - (y1 - y0) * bend, my = (y0 + y1) / 2 + (x1 - x0) * bend;
  return (t) => {
    const u = 1 - t;
    return [u * u * x0 + 2 * u * t * mx + t * t * x1, u * u * y0 + 2 * u * t * my + t * t * y1];
  };
};

// A path through points (Catmull-Rom), as a function of t.
const through = (pts) => (t) => {
  const n = pts.length - 1, f = clamp(t, 0, 1) * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  const c = (a, b, c2, d) => 0.5 * (2 * b + (-a + c2) * u + (2 * a - 5 * b + 4 * c2 - d) * u * u + (-a + 3 * b - 3 * c2 + d) * u * u * u);
  return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])];
};

// A bamboo leaf: pressed in at the base, widest a quarter along, then a long taper to a point.
const leafW = (fat) => (t) => fat * (t < 0.26 ? Math.pow(Math.sin((t / 0.26) * Math.PI / 2), 0.7) : Math.pow(1 - (t - 0.26) / 0.74, 1.15)) + 0.25;

// A slow wobble in 0..1 along a stroke, from a few sines.
const wobble = (R) => {
  const a = R() * 6.3, b = R() * 6.3, f = 5 + R() * 6;
  return (t) => 0.5 + 0.3 * Math.sin(t * f + a) + 0.2 * Math.sin(t * f * 2.3 + b);
};

const pathLength = (P) => {
  let L = 0, [px, py] = P(0);
  for (let i = 1; i <= 16; i++) {
    const [x, y] = P(i / 16);
    L += Math.hypot(x - px, y - py);
    px = x; py = y;
  }
  return L;
};

/**
 * A brush mark: a centerline sampled with a half-width at each point.
 * o: a ink load 0..1, dry 0..1 (how much it breaks up toward the end), n bristles,
 * edge 0..1 (edges darker than the middle), press 0..1 (a pooled start), rough (edge grain),
 * body 0..1 (how much of the load is a solid core under the bristles).
 */
function brush(P, wfn, o = {}) {
  const L = pathLength(P);
  const n = clamp(Math.round(L / 8), 6, 44);
  const p = [], w = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, [x, y] = P(t);
    p.push([x, y]);
    w.push(Math.max(0.3, wfn(t)));
  }
  return { k: "b", p, w, a: o.a ?? 0.8, dry: o.dry ?? 0.3, n: o.n ?? 8, edge: o.edge ?? 0, press: o.press ?? 0, rough: o.rough ?? 1, body: o.body ?? 0.5 };
}

/** A soft wash under a ridge line: d deep, fading down. */
const wash = (top, d, a, blur = 8) => ({ k: "w", top, d, a, blur });
/** A dot (a blossom petal, a moss dot, a bud, a leaf of a far tree). */
const dot = (x, y, r, a) => ({ k: "d", x, y, r, a });
/** A soft round blot (the moon's glow, mist). */
const blot = (x, y, r, a, blur) => ({ k: "c", x, y, r, a, blur });

// Kinds of extras in a shuffled order, each as many times as asked.
function plan(R, counts) {
  const list = [];
  for (const [kind, n] of Object.entries(counts)) for (let i = 0; i < n; i++) list.push(kind);
  for (let i = list.length - 1; i > 0; i--) {
    const j = (R() * (i + 1)) | 0;
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Grass or reeds: blades from one root leaning together, each curving the same way.
function blades(R, gx, gy, n, len, a, lean) {
  const m = [];
  for (let j = 0; j < n; j++) {
    const an = -Math.PI / 2 + lean + (j - (n - 1) / 2) * 0.16 + (R() - 0.5) * 0.15, L = len * (0.55 + R() * 0.6);
    const x0 = gx + (j - (n - 1) / 2) * 3;
    m.push(brush(line(x0, gy, x0 + Math.cos(an) * L, gy + Math.sin(an) * L, (lean > 0 ? -1 : 1) * (0.08 + R() * 0.12)),
      (t) => 1.9 * (1 - t) + 0.3, { a: a * (0.75 + R() * 0.35), n: 2, dry: 0.35, rough: 0.5, body: 0.6 }));
  }
  return m;
}

// ---------------------------------------------------------------- bamboo

function leaf(R, sx, sy, an, side, L, fat, a) {
  const ex = sx + side * Math.cos(an) * L, ey = sy + Math.sin(an) * L;
  return brush(line(sx, sy, ex, ey, side * (R() - 0.35) * 0.18), leafW(fat),
    { a: Math.min(1, a), n: 7, dry: 0.12 + R() * 0.22, press: 0.3, rough: 0.4, body: 0.72 });
}

function bamboo(R, out, ctx) {
  const stalks = 2 + ((R() * 2) | 0);
  const nodes = [], xs = [];
  ctx.twigs = [];
  for (let k = 0; k < stalks; k++) {
    const pale = k === 0 && stalks > 2;
    let x;
    for (let tries = 0; tries < 8; tries++) {
      x = W * (0.18 + R() * 0.64);
      if (xs.every((o) => Math.abs(o - x) > 80)) break;
    }
    xs.push(x);
    let y = H + 30, w = (pale ? 8 : 11) + R() * 5;
    let lean = (R() - 0.5) * 0.26;
    const drift = (R() - 0.5) * 0.05, a = pale ? 0.26 : 0.58 + R() * 0.15;
    for (let i = 0; i < 13 && y > -20; i++) {
      const len = 125 + R() * 70, x1 = x + lean * len + (R() - 0.5) * 4, y1 = y - len, ww = w, as = a * (0.88 + R() * 0.24);
      lean += drift;
      const seg = brush(line(x, y, x1, y1, (R() - 0.5) * 0.02),
        (t) => ww * (1 + 0.2 * Math.pow(Math.abs(t - 0.5) * 2, 6)),
        { a: as, n: 12, dry: 0.1 + R() * 0.18, edge: 1.3, press: 0.5, rough: 0.45, body: 0.3 });
      // The node: a short dark stroke across the gap, curving like a shallow cup.
      const node = brush(line(x1 - ww * 1.15, y1 - 2, x1 + ww * 1.15, y1 - 4, 0.12),
        (t) => 3 * Math.sin(Math.PI * t) + 0.6, { a: Math.min(1, as + 0.3), n: 3, dry: 0.15, rough: 0.5, body: 0.7 });
      out.push({ m: [seg, node] });
      if (!pale && i > 0 && y1 > 40) nodes.push([x1, y1, ww, Math.min(1, a + 0.28)]);
      x = x1; y = y1 - 8; w *= 0.94;
    }
  }
  ctx.nodes = nodes.slice();
  // Twigs and leaves from a few nodes, leaves in fans of 3 to 6.
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = (R() * (i + 1)) | 0;
    [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
  }
  for (const [x, y, w, a] of nodes.slice(0, 6 + ((R() * 3) | 0))) {
    const side = x < W * 0.35 ? 1 : x > W * 0.65 ? -1 : R() < 0.5 ? -1 : 1;
    const bx = x + side * (55 + R() * 85), by = y - (35 + R() * 70);
    const B = line(x + side * w * 0.8, y, bx, by, side * 0.12);
    out.push({ m: [brush(B, (t) => 2.4 * (1 - t * 0.6) + 0.4, { a: a * 0.95, n: 3, dry: 0.45, rough: 0.5 })] });
    ctx.twigs.push({ B, side, a });
    const leaves = 3 + ((R() * 4) | 0), base = R() * 0.6 - 0.1;
    for (let j = 0; j < leaves; j++) {
      const [sx, sy] = B(0.45 + R() * 0.55);
      const an = R() < 0.78 ? base + 0.25 + j * (0.28 + R() * 0.12) : -0.5 + R() * 0.5;
      out.push({ m: [leaf(R, sx, sy, an, side, 70 + R() * 85, 9 + R() * 6, a * (0.75 + R() * 0.3))] });
    }
  }
}

function bambooExtras(R, out, ctx) {
  for (const kind of plan(R, { leaf: 12, sprig: 5, grass: 3 })) {
    if (kind === "leaf" && ctx.twigs.length) {
      const { B, side, a } = ctx.twigs[(R() * ctx.twigs.length) | 0];
      const [sx, sy] = B(0.5 + R() * 0.5);
      out.push({ m: [leaf(R, sx, sy, 0.1 + R() * 1.3, side, 50 + R() * 60, 7 + R() * 5, a * (0.6 + R() * 0.3))] });
    } else if (kind === "sprig" && ctx.nodes.length) {
      const [x, y, w, a] = ctx.nodes[(R() * ctx.nodes.length) | 0], side = R() < 0.5 ? -1 : 1;
      const B = line(x + side * w * 0.8, y, x + side * (30 + R() * 40), y - (20 + R() * 40), side * 0.1);
      const m = [brush(B, (t) => 1.7 * (1 - t * 0.6) + 0.3, { a: a * 0.85, n: 2, dry: 0.4, rough: 0.5 })];
      for (let j = 0; j < 2; j++) {
        const [sx, sy] = B(0.7 + R() * 0.3);
        m.push(leaf(R, sx, sy, 0.3 + j * 0.5 + R() * 0.3, side, 34 + R() * 26, 5 + R() * 3, a * 0.7));
      }
      out.push({ m });
    } else if (kind === "far") {
      // A small pale cluster of distant leaves.
      const cx = W * (0.08 + R() * 0.84), cy = H * (0.05 + R() * 0.5), side = R() < 0.5 ? -1 : 1, m = [];
      const n = 2 + ((R() * 2) | 0);
      for (let j = 0; j < n; j++) m.push(leaf(R, cx, cy, 0.3 + j * 0.45 + (R() - 0.5) * 0.3, side, 30 + R() * 30, 4 + R() * 3, 0.2 + R() * 0.1));
      out.push({ m });
    } else {
      out.push({ m: blades(R, W * (0.06 + R() * 0.88), H - 6 - R() * 26, 3 + ((R() * 3) | 0), 40, 0.45, (R() - 0.5) * 0.8) });
    }
  }
}

// ---------------------------------------------------------------- mountains

// A ridge line: a sum of sines with one peak.
function ridgeOf(R, k) {
  const base = H * (0.4 + k * 0.15), amp = 60 - k * 10;
  const ph = [R() * 7, R() * 7, R() * 7], f = [0.004 + R() * 0.004, 0.011 + R() * 0.006, 0.03 + R() * 0.02];
  const px = W * (0.15 + R() * 0.7), pH = 120 + R() * 130 - k * 30, pw = 60 + R() * 70;
  return (x) => base - amp * (0.6 * Math.sin(x * f[0] + ph[0]) + 0.3 * Math.sin(x * f[1] + ph[1]) + 0.1 * Math.sin(x * f[2] + ph[2]))
    - pH * Math.exp(-(((x - px) / pw) ** 2));
}

// A grove: two to four trees close together, each a boneless upright dab of foliage on a short
// trunk, the way distant trees are laid in with one press of the brush.
function grove(R, x, y, hgt, a) {
  const m = [], n = 2 + ((R() * 3) | 0);
  for (let j = 0; j < n; j++) {
    const tx = x + (j - (n - 1) / 2) * hgt * (0.28 + R() * 0.12), h = hgt * (0.6 + R() * 0.5), lean = (R() - 0.5) * 0.12;
    const top = [tx + lean * h, y - h], fat = h * (0.15 + R() * 0.07);
    m.push(brush(line(tx, y + 2, tx + lean * h * 0.3, y - h * 0.3), (t) => 1.4 * (1 - t * 0.5) + 0.3, { a: a * 0.9, n: 2, dry: 0.3, rough: 0.5, body: 0.6 }));
    m.push(brush(line(tx + lean * h * 0.2, y - h * 0.18, top[0], top[1], (R() - 0.5) * 0.15),
      (t) => fat * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.05)), 0.7) * (1 - t * 0.25) + 0.4,
      { a: a * (0.75 + R() * 0.25), n: 8, dry: 0.3 + R() * 0.2, rough: 1.2, body: 0.55, press: 0.3 }));
  }
  return m;
}

// A moss dab: a tiny flat stroke, as dian moss is laid on a ridge.
const moss = (R, x, y, a) => {
  const L = 5 + R() * 6, tilt = (R() - 0.5) * 0.5;
  return brush(line(x - L / 2, y + tilt * L / 2, x + L / 2, y - tilt * L / 2, 0.1), (t) => 1.9 * Math.pow(Math.sin(Math.PI * t), 0.6) + 0.4, { a, n: 2, dry: 0.2, rough: 0.6, body: 0.7 });
};

function mountains(R, out, ctx) {
  if (R() < 0.65) {
    const mx = W * (0.2 + R() * 0.6), my = H * (0.09 + R() * 0.07), r = 36 + R() * 16;
    const ring = brush((t) => [mx + Math.cos(t * 6.45 - 1.6) * r, my + Math.sin(t * 6.45 - 1.6) * r], (t) => 1.8 + Math.sin(t * 9) * 0.5,
      { a: 0.38, n: 4, dry: 0.6, rough: 0.6 });
    out.push({ m: [ring, blot(mx, my, r * 0.9, 0.07, 5)] });
  }
  // A pale distant range behind everything.
  {
    const far = ridgeOf(R, -0.6), top = [];
    for (let x = -24; x <= W + 24; x += 12) top.push([x, far(x) + 10 + (R() - 0.5) * 3]);
    out.push({ m: [wash(top, 120, 0.07, 9)] });
  }
  const ridges = [];
  for (let k = 0; k < 3; k++) {
    const ridge = ridgeOf(R, k);
    ridges.push(ridge);
    const top = [];
    for (let x = -24; x <= W + 24; x += 12) top.push([x, ridge(x) + (R() - 0.5) * 3]);
    out.push({ m: [wash(top, [150, 165, 190][k], [0.11, 0.2, 0.3][k], [8, 7, 6][k])] });
    // The ridge line, dry, in runs with breaks; the far ridge has none, only its wash.
    if (k > 0) {
      const runs = [];
      let x0 = -10 + R() * 50;
      while (x0 < W) {
        const len = 140 + R() * 240, x1 = Math.min(W + 10, x0 + len), pts = [];
        for (let x = x0; x <= x1; x += 20) pts.push([x, ridge(x) + (R() - 0.5) * 2]);
        const wv = wobble(R);
        if (pts.length >= 3) runs.push(brush(through(pts), (t) => (k === 1 ? 1.8 : 3.2) * (0.3 + 1.0 * Math.sin(Math.PI * t) * wv(t)),
          { a: k === 1 ? 0.3 : 0.55, n: 6, dry: 0.7, rough: 1, body: 0.3 }));
        x0 = x1 + 25 + R() * 80;
      }
      out.push({ m: runs });
    }
    // Texture strokes (cun) down the slopes, and moss dots in a few clusters on the near ridges.
    const m = [];
    const nc = 2 + ((R() * 3) | 0) + k * 2;
    for (let j = 0; j < nc; j++) {
      const x = W * (0.05 + R() * 0.9), y = ridge(x) + 6 + R() * 24, dir = ridge(x + 6) < ridge(x - 6) ? 1 : -1;
      const L = 20 + R() * 34;
      m.push(brush(line(x, y, x - dir * L * 0.55, y + L, (R() - 0.5) * 0.3), (t) => (1.1 + k * 0.6) * (1 - t * 0.7) + 0.3,
        { a: [0.22, 0.38, 0.55][k], n: 3, dry: 0.6, rough: 0.8 }));
    }
    if (k === 2) {
      for (let c = 0; c < 2; c++) {
        const cx = W * (0.08 + R() * 0.84);
        for (let j = 0; j < 2 + ((R() * 2) | 0); j++) {
          const x = cx + (R() - 0.5) * 16;
          m.push(moss(R, x, ridge(x) + 1 + R() * 5, 0.4 + R() * 0.25));
        }
      }
    }
    out.push({ m });
  }
  ctx.ridges = ridges;
  // Trees on the near ridge: pines, and a few round dotted ones.
  const groves = 2 + ((R() * 3) | 0);
  for (let n = 0; n < groves; n++) {
    const x = W * (0.08 + R() * 0.84), y = ridges[2](x) + 5, hgt = 34 + R() * 30;
    out.push({ m: grove(R, x, y, hgt, 0.72) });
  }
}

function mountainsExtras(R, out, ctx) {
  const [far, mid, near] = ctx.ridges;
  for (const kind of plan(R, { flock: 2, reeds: 2, mist: 3, tree: 4, moss: 2, cun: 3, boat: R() < 0.5 ? 1 : 0 })) {
    if (kind === "flock") {
      // Two or three distant birds flying together.
      const fx = W * (0.15 + R() * 0.6), fy = H * (0.06 + R() * 0.18), m = [];
      const n = 2 + ((R() * 2) | 0);
      for (let j = 0; j < n; j++) {
        const x = fx + j * (16 + R() * 14), y = fy + (R() - 0.5) * 18, s = 5 + R() * 4;
        m.push(brush(line(x - s, y + s * 0.15, x, y + s * 0.35, -0.3), (t) => 1.2 * Math.sin(Math.PI * t) + 0.3, { a: 0.75, n: 2, dry: 0.2, rough: 0.4, body: 0.7 }));
        m.push(brush(line(x, y + s * 0.35, x + s * 1.1, y - s * 0.15, -0.3), (t) => 1.2 * Math.sin(Math.PI * t) + 0.3, { a: 0.75, n: 2, dry: 0.2, rough: 0.4, body: 0.7 }));
      }
      out.push({ m });
    } else if (kind === "reeds") {
      out.push({ m: blades(R, W * (0.05 + R() * 0.9), H - 8 - R() * 40, 3 + ((R() * 2) | 0), 48, 0.55, (R() - 0.5) * 0.6) });
    } else if (kind === "mist") {
      const x = W * (0.1 + R() * 0.8), ridge = R() < 0.5 ? mid : far;
      out.push({ m: [blot(x, ridge(x) + 40 + R() * 50, 26 + R() * 30, 0.06 + R() * 0.05, 10)] });
    } else if (kind === "tree") {
      const onNear = R() < 0.6, x = W * (0.05 + R() * 0.9), ridge = onNear ? near : mid;
      const hgt = onNear ? 22 + R() * 18 : 14 + R() * 10, a = onNear ? 0.72 : 0.45;
      out.push({ m: grove(R, x, ridge(x) + 4, hgt, a) });
    } else if (kind === "moss") {
      const ridge = R() < 0.5 ? mid : near, cx = W * (0.05 + R() * 0.9), m = [];
      for (let j = 0; j < 2 + ((R() * 2) | 0); j++) {
        const x = cx + (R() - 0.5) * 16;
        m.push(moss(R, x, ridge(x) + R() * 8, 0.4 + R() * 0.25));
      }
      out.push({ m });
    } else if (kind === "cun") {
      const ridge = R() < 0.5 ? mid : near, m = [];
      for (let j = 0; j < 2; j++) {
        const x = W * (0.05 + R() * 0.9), y = ridge(x) + 8 + R() * 30, dir = ridge(x + 6) < ridge(x - 6) ? 1 : -1, L = 18 + R() * 26;
        m.push(brush(line(x, y, x - dir * L * 0.55, y + L, (R() - 0.5) * 0.3), (t) => 1.6 * (1 - t * 0.7) + 0.3, { a: 0.4, n: 3, dry: 0.6, rough: 0.8 }));
      }
      out.push({ m });
    } else if (kind === "boat") {
      // A small boat on the water below the hills, with its one figure.
      const x = W * (0.2 + R() * 0.6), y = H * (0.9 + R() * 0.04);
      out.push({ m: [
        brush(line(x - 26, y - 4, x + 26, y - 6, -0.12), (t) => 2.6 * Math.sin(Math.PI * t) + 0.5, { a: 0.8, n: 4, dry: 0.3, rough: 0.6, body: 0.6 }),
        brush(line(x + 4, y - 9, x + 6, y - 22), (t) => 1.8 * (1 - t * 0.4) + 0.4, { a: 0.8, n: 2, dry: 0.2, rough: 0.4, body: 0.7 }),
        brush(line(x - 50, y + 8, x - 20, y + 8), (t) => 0.9 * Math.sin(Math.PI * t) + 0.2, { a: 0.3, n: 2, dry: 0.5, rough: 0.5 }),
        brush(line(x + 30, y + 4, x + 70, y + 5), (t) => 0.9 * Math.sin(Math.PI * t) + 0.2, { a: 0.3, n: 2, dry: 0.5, rough: 0.5 }),
      ] });
    }
  }
}

// ---------------------------------------------------------------- plum

function blossom(R, x, y, r) {
  const acc = [];
  const turn = R() * 6.28;
  for (let p = 0; p < 5; p++) {
    const an = turn + p * 1.2566 + (R() - 0.5) * 0.3;
    acc.push(dot(x + Math.cos(an) * r * 0.85, y + Math.sin(an) * r * 0.85, r * (0.6 + R() * 0.15), 0.3 + R() * 0.16));
  }
  const m = [];
  for (let p = 0; p < 4; p++) m.push(dot(x + (R() - 0.5) * r * 0.7, y + (R() - 0.5) * r * 0.7, 1.2 + R() * 0.6, 0.85));
  return { m, acc };
}

function plum(R, out, ctx) {
  const left = R() < 0.5, tips = [], twigs = [];
  const q = [{ x: left ? -14 : W + 14, y: H * (0.7 + R() * 0.22), a: left ? -(0.65 + R() * 0.45) : Math.PI + 0.65 + R() * 0.45, len: (250 + R() * 80) * (H / 1000), w: 14, d: 0, lead: true }];
  // The leader: one line of the branch keeps turning upward until it reaches the top of the sheet.
  const up = left ? -Math.PI / 2 : 1.5 * Math.PI;
  while (q.length) {
    const b = q.shift();
    // Gnarled: two kinks, the wood turning back and forth.
    const k1 = (R() - 0.5) * 0.9, k2 = -k1 * (0.5 + R() * 0.6);
    const p1 = [b.x + Math.cos(b.a + k1) * b.len * 0.34, b.y + Math.sin(b.a + k1) * b.len * 0.34];
    const p2 = [p1[0] + Math.cos(b.a + k2) * b.len * 0.33, p1[1] + Math.sin(b.a + k2) * b.len * 0.33];
    const ex = p2[0] + Math.cos(b.a + k1 * 0.3) * b.len * 0.33, ey = p2[1] + Math.sin(b.a + k1 * 0.3) * b.len * 0.33;
    const P = through([[b.x, b.y], p1, p2, [ex, ey]]);
    const wv = wobble(R), thick = b.w > 4;
    const m = [brush(P, (t) => b.w * (1 - 0.45 * t) * (0.78 + 0.4 * wv(t)) + 0.3,
      { a: b.d === 0 ? 0.92 : 0.86, n: Math.max(4, Math.round(b.w * 0.9)), dry: thick ? 0.6 + R() * 0.3 : 0.3 + R() * 0.2, edge: 0.7, press: 0.4, rough: thick ? 1.1 : 0.6, body: thick ? 0.3 : 0.6 })];
    // Moss dots and knots on the older wood.
    if (b.d < 2) for (let j = 0; j < 1 + ((R() * 2) | 0); j++) {
      const [dx, dy] = P(0.15 + R() * 0.7);
      m.push(dot(dx + (R() - 0.5) * b.w * 1.6, dy + (R() - 0.5) * b.w * 1.6, 2 + R() * 2, 0.55 + R() * 0.2));
    }
    out.push({ m });
    if (b.d >= 2) tips.push(P(0.3 + R() * 0.5));
    twigs.push({ P, w: b.w });
    const climbing = b.lead && ey > H * 0.06 && b.d < 10;
    if ((b.d < 4 && b.w > 1.6) || climbing) {
      const kids = b.d < 2 || climbing ? 2 : R() < 0.6 ? 2 : 1;
      for (let i = 0; i < kids; i++) {
        const [sx, sy] = i === 0 ? [ex, ey] : P(0.45 + R() * 0.4);
        if (climbing && i === 0) {
          q.push({ x: sx, y: sy, a: b.a + (up - b.a) * (0.35 + R() * 0.3) + (R() - 0.5) * 0.35, len: b.len * (0.78 + R() * 0.14), w: Math.max(2, b.w * 0.72), d: b.d + 1, lead: true });
        } else {
          q.push({ x: sx, y: sy, a: b.a + (i === 0 ? -1 : 1) * (0.3 + R() * 0.6), len: b.len * (0.55 + R() * 0.2), w: b.w * 0.58, d: b.d + 1 });
        }
      }
    } else tips.push([ex, ey]);
  }
  ctx.twigs = twigs;
  ctx.left = left;
  for (const [x, y] of tips) {
    if (R() < 0.22) continue;
    const r = 9.5 + R() * 6;
    if (R() < 0.72) out.push(blossom(R, x, y, r));
    else out.push({ m: [dot(x - r * 0.25, y + r * 0.35, 1.4, 0.85)], acc: [dot(x, y, r * 0.5, 0.45)] });
  }
}

function plumExtras(R, out, ctx) {
  const twigs = ctx.twigs.length ? ctx.twigs : [{ P: (t) => [W * t, H * 0.5], w: 2 }];
  const thin = twigs.filter((t) => t.w < 6), thick = twigs.filter((t) => t.w >= 4);
  const pick = (list) => (list.length ? list : twigs)[(R() * (list.length || twigs.length)) | 0];
  for (const kind of plan(R, { bud: 7, blossom: 5, petal: 3, moss: 3, shoot: 3 })) {
    if (kind === "bud") {
      const [x, y] = pick(thin).P(0.3 + R() * 0.7), r = 4 + R() * 2.5;
      out.push({ m: [dot(x - r * 0.3, y + r * 0.6, 1.4, 0.85)], acc: [dot(x, y, r, 0.42 + R() * 0.14)] });
    } else if (kind === "blossom") {
      const [x, y] = pick(thin).P(0.3 + R() * 0.7);
      out.push(blossom(R, x + (R() - 0.5) * 8, y + (R() - 0.5) * 8, 7 + R() * 4));
    } else if (kind === "petal") {
      const [x, y] = pick(thin).P(R());
      out.push({ acc: [dot(clamp(x + (R() - 0.5) * 120, 20, W - 20), clamp(y + 50 + R() * 220, 20, H - 20), 3 + R() * 2, 0.26 + R() * 0.12)] });
    } else if (kind === "moss") {
      const { P, w } = pick(thick), m = [];
      for (let j = 0; j < 2 + ((R() * 2) | 0); j++) {
        const [x, y] = P(0.1 + R() * 0.8);
        m.push(dot(x + (R() - 0.5) * w * 1.6, y + (R() - 0.5) * w * 1.6, 1.8 + R() * 1.8, 0.55 + R() * 0.2));
      }
      out.push({ m });
    } else {
      // A thin new shoot, straight up the way plum shoots grow.
      const [x, y] = pick(thin).P(0.2 + R() * 0.7), an = -Math.PI / 2 + (R() - 0.5) * 0.9, L = 30 + R() * 40;
      out.push({ m: [brush(line(x, y, x + Math.cos(an) * L, y + Math.sin(an) * L, (R() - 0.5) * 0.25), (t) => 1.7 * (1 - t * 0.8) + 0.25,
        { a: 0.55, n: 3, dry: 0.35, rough: 0.6, body: 0.55 })] });
    }
  }
}

/** The whole sheet for { subject, seed }: its steps in painting order, how many make the main
 *  subject, each step's box, and where the seal goes. Same input, same output. */
export function compose(subject, seed) {
  const R = rng(seed);
  const steps = [], ctx = {};
  if (subject === "mountains") mountains(R, steps, ctx);
  else if (subject === "plum") plum(R, steps, ctx);
  else bamboo(R, steps, ctx);
  const main = steps.length;
  if (subject === "mountains") mountainsExtras(R, steps, ctx);
  else if (subject === "plum") plumExtras(R, steps, ctx);
  else bambooExtras(R, steps, ctx);
  const boxes = steps.map(boxOf);
  return { subject, seed, steps, boxes, main, seal: sealSpot(boxes, subject, ctx) };
}

// ---------------------------------------------------------------- boxes and the seal

const PAD_BRUSH = 14;

const boxOf = (step) => marksBox([...(step.m ?? []), ...(step.acc ?? [])]);

function marksBox(marks) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, pad) => {
    x0 = Math.min(x0, x - pad); y0 = Math.min(y0, y - pad);
    x1 = Math.max(x1, x + pad); y1 = Math.max(y1, y + pad);
  };
  for (const m of marks) {
    if (m.k === "b") m.p.forEach(([x, y], i) => add(x, y, m.w[i] + PAD_BRUSH));
    else if (m.k === "w") {
      for (const [x, y] of m.top) {
        add(x, y, m.blur * 3);
        add(x, y + m.d, m.blur * 3);
      }
    } else if (m.k === "c") add(m.x, m.y, m.r + m.blur * 3 + 4);
    else if (m.k === "d") add(m.x, m.y, m.r + 8);
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  if (!(x1 > x0 && y1 > y0)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const SEAL = 46;

// The lower corner with less ink in it; plum leaves the corner its branch comes from.
function sealSpot(boxes, subject, ctx) {
  const spots = [{ x: W - 40 - SEAL, y: H - 44 - SEAL }, { x: 40, y: H - 44 - SEAL }];
  if (subject === "plum") return ctx.left ? spots[0] : spots[1];
  const inkIn = (s) => boxes.reduce((sum, b) => {
    const ox = Math.max(0, Math.min(b.x + b.w, s.x + SEAL + 30) - Math.max(b.x, s.x - 30));
    const oy = Math.max(0, Math.min(b.y + b.h, s.y + SEAL + 30) - Math.max(b.y, s.y - 30));
    return sum + ox * oy;
  }, 0);
  return inkIn(spots[1]) < inkIn(spots[0]) ? spots[1] : spots[0];
}

// ---------------------------------------------------------------- SVG

const f1 = (v) => Math.round(v * 10) / 10;
const pt = ([x, y]) => `${f1(x)} ${f1(y)}`;
const op = (a) => f1(clamp(a, 0, 1) * 100) / 100;

// A closed outline through points, smoothed through their midpoints.
function smooth(points) {
  const n = points.length;
  if (n < 3) return "";
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let d = `M${pt(mid(points[0], points[1]))}`;
  for (let i = 1; i <= n; i++) d += `Q${pt(points[i % n])} ${pt(mid(points[i % n], points[(i + 1) % n]))}`;
  return d + "Z";
}

function normals(p) {
  return p.map((_, i) => {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [-dy / L, dx / L];
  });
}

// A ribbon along the centerline from index s to e: offset off(i), half-width hw(i).
function ribbon(p, nr, s, e, off, hw) {
  const left = [], right = [];
  for (let i = s; i <= e; i++) {
    const o = off(i), h = hw(i);
    left.push([p[i][0] + nr[i][0] * (o + h), p[i][1] + nr[i][1] * (o + h)]);
    right.unshift([p[i][0] + nr[i][0] * (o - h), p[i][1] + nr[i][1] * (o - h)]);
  }
  return smooth(left.concat(right));
}

function brushSvg(m, R) {
  const { p, w } = m;
  const nr = normals(p), last = p.length - 1;
  const parts = [];
  // The body: the brush's wet core. A dry stroke's body runs out before the end.
  const bodyEnd = m.dry > 0.45 ? Math.max(2, Math.round(last * (1 - (m.dry - 0.3) * 0.75))) : last;
  const bodyW = (i) => w[i] * 0.84 * (bodyEnd < last && i > bodyEnd - 3 ? Math.max(0.1, (bodyEnd - i) / 3) : 1);
  parts.push(`<path d="${ribbon(p, nr, 0, bodyEnd, () => 0, bodyW)}" fill-opacity="${op(m.a * (m.body - m.dry * 0.2))}"/>`);
  // Bristles: each its own load of ink, wandering a little; on a dry brush they break up toward the end.
  const n = m.n;
  for (let j = 0; j < n; j++) {
    const base = (n === 1 ? 0 : (j / (n - 1)) * 2 - 1) * 0.82 + (R() - 0.5) * 0.14;
    const ph = R() * 6.3, wob = 0.04 + R() * 0.07;
    const load = 0.4 + R() * 0.6;
    const alpha = m.a * load * (0.4 + m.edge * Math.abs(base) * 0.5);
    const bw = (0.8 + R() * 0.8) / n;
    const breakAt = 1 - m.dry * (0.5 + R() * 0.7);
    let s = R() < 0.15 ? 1 : 0;
    while (s < last) {
      let e = s + 1;
      while (e < last && (e / last < breakAt || R() > m.dry * 0.5)) e++;
      const fade = Math.max(0.25, 1 - Math.max(0, s / last - breakAt) * 1.6);
      const off = (i) => (base + wob * Math.sin(i * 0.8 + ph)) * w[i];
      const hw = (i) => w[i] * bw * (0.7 + 0.6 * Math.sin(i * 1.3 + ph * 2) ** 2) * (i === e && e < last ? 0.35 : 1);
      parts.push(`<path d="${ribbon(p, nr, s, e, off, hw)}" fill-opacity="${op(alpha * fade)}"/>`);
      s = e + 1 + (R() < m.dry ? 1 + ((R() * 2) | 0) : 0);
    }
  }
  // A pooled start where the brush was pressed down.
  if (m.press > 0) {
    const [dx, dy] = [p[1][0] - p[0][0], p[1][1] - p[0][1]], an = (Math.atan2(dy, dx) * 180) / Math.PI;
    const cx = p[0][0] + dx * 0.4, cy = p[0][1] + dy * 0.4;
    parts.push(`<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(w[0] * 1.15)}" ry="${f1(w[0] * 0.95)}" transform="rotate(${f1(an)} ${f1(cx)} ${f1(cy)})" fill-opacity="${op(m.a * 0.35 * m.press)}"/>`);
  }
  return parts.join("");
}

function washSvg(m, id) {
  // Bands stacked down from the ridge, blurred together: dense at the ridge, fading into mist.
  const bands = 7, parts = [];
  for (let b = 0; b < bands; b++) {
    const deep = (m.d * (b + 1)) / bands;
    const bottom = m.top.slice().reverse().map(([x, y]) => [x, y + deep * (0.7 + 0.3 * Math.sin(x * 0.011 + b * 1.7))]);
    parts.push(`<path d="M${m.top.map(pt).join("L")}L${bottom.map(pt).join("L")}Z" fill-opacity="${op((m.a / bands) * 1.5)}"/>`);
  }
  return `<g filter="url(#${id})">${parts.join("")}</g>`;
}

const region = (box) => `filterUnits="userSpaceOnUse" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" color-interpolation-filters="sRGB"`;

// A brush's edges are grained by noise (rough paper) and softened, with a faint bleed halo.
function brushFilter(id, box, seed, rough, wmax) {
  const D = f1(clamp(wmax * 0.22, 1.1, 3.2) * rough);
  return `<filter id="${id}" ${region(box)}>`
    + `<feTurbulence type="fractalNoise" baseFrequency="0.21" numOctaves="1" seed="${seed % 1000}" result="n"/>`
    + `<feDisplacementMap in="SourceGraphic" in2="n" scale="${D}" xChannelSelector="R" yChannelSelector="G" result="d"/>`
    + `<feGaussianBlur in="d" stdDeviation="0.55" result="s"/>`
    + `<feGaussianBlur in="d" stdDeviation="2.6" result="b"/>`
    + `<feComponentTransfer in="b" result="h"><feFuncA type="linear" slope="0.2"/></feComponentTransfer>`
    + `<feMerge><feMergeNode in="h"/><feMergeNode in="s"/></feMerge></filter>`;
}

// A wash is blurred and gently mottled.
function washFilter(id, box, seed, blur) {
  return `<filter id="${id}" ${region(box)}>`
    + `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="b"/>`
    + `<feTurbulence type="fractalNoise" baseFrequency="0.025 0.06" numOctaves="2" seed="${seed % 1000}" result="n"/>`
    + `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.5 -0.2" result="m"/>`
    + `<feComposite in="b" in2="m" operator="arithmetic" k1="0.7" k2="0.55" k3="0" k4="0"/></filter>`;
}

function marksSvg(marks, stepBox, seed, prefix) {
  const defs = [], body = [], dots = [];
  marks.forEach((m, j) => {
    const R = rng(hash(seed, j, 7));
    // A filter works only over its own mark, not the whole step: the renderer's cost is per pixel.
    const box = marksBox([m]);
    if (m.k === "b") {
      const id = `${prefix}${j}`;
      defs.push(brushFilter(id, box, hash(seed, j), m.rough, Math.max(...m.w)));
      body.push(`<g filter="url(#${id})">${brushSvg(m, R)}</g>`);
    } else if (m.k === "w") {
      const id = `${prefix}w${j}`;
      defs.push(washFilter(id, box, hash(seed, j, 3), m.blur));
      body.push(washSvg(m, id));
    } else if (m.k === "c") {
      const id = `${prefix}c${j}`;
      defs.push(`<filter id="${id}" ${region(box)}><feGaussianBlur stdDeviation="${m.blur}"/></filter>`);
      body.push(`<circle cx="${f1(m.x)}" cy="${f1(m.y)}" r="${f1(m.r)}" fill-opacity="${op(m.a)}" filter="url(#${id})"/>`);
    } else if (m.k === "d") {
      dots.push(`<circle cx="${f1(m.x)}" cy="${f1(m.y)}" r="${f1(m.r)}" fill-opacity="${op(m.a)}"/>`);
    }
  });
  // Dots share one soft, rough filter.
  if (dots.length) {
    defs.push(brushFilter(`${prefix}d`, marksBox(marks.filter((m) => m.k === "d")), hash(seed, 99), 0.5, 3));
    body.push(`<g filter="url(#${prefix}d)">${dots.join("")}</g>`);
  }
  return { defs: defs.join(""), body: body.join("") };
}

function doc(box, defs, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" preserveAspectRatio="none">`
    + `<defs>${defs}</defs>${body}</svg>\n`;
}

/** Step i of a composed sheet as SVG: { ink, acc } (null where the step has none) and its box. */
export function stepSvg(sheet, i) {
  const step = sheet.steps[i], box = sheet.boxes[i], seed = hash(sheet.seed, i);
  const ink = step.m?.length ? marksSvg(step.m, box, seed, "f") : null;
  const acc = step.acc?.length ? marksSvg(step.acc, box, hash(seed, 1), "a") : null;
  return {
    box,
    ink: ink ? doc(box, ink.defs, ink.body) : null,
    acc: acc ? doc(box, acc.defs, acc.body) : null,
  };
}

/** The seal: a red square with a carved border and mark, stamped unevenly. Variant 0..5. */
export function sealSvg(variant) {
  const R = rng(hash(variant, 41));
  const glyphs = [
    "M30 34H70V40H30Z M47 34H53V72H47Z M32 52H68V58H32Z",
    "M30 30H70V36H30Z M30 64H70V70H30Z M47 30H53V70H47Z",
    "M32 30H38V70H32Z M62 30H68V70H62Z M32 47H68V53H32Z",
    "M30 32H70V38H30Z M44 38H50V72H44Z M56 46H64V70H56Z",
    "M30 30H70V36H30Z M30 47H70V53H30Z M30 64H70V70H30Z",
    "M47 28H53V72H47Z M30 40H70V46H30Z M34 60H66V66H34Z",
  ];
  const box = { x: -6, y: -6, w: 112, h: 112 };
  const defs = `<filter id="s" ${region(box)}>`
    + `<feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="${(R() * 900) | 0}" result="n"/>`
    + `<feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G" result="d"/>`
    + `<feTurbulence type="fractalNoise" baseFrequency="0.35" numOctaves="2" seed="${(R() * 900) | 0}" result="g"/>`
    + `<feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -3 2.3" result="k"/>`
    + `<feComposite in="d" in2="k" operator="in"/></filter>`;
  const body = `<g filter="url(#s)"><path fill-rule="evenodd" fill-opacity="0.92" d="M2 2H98V98H2Z M14 14H86V86H14Z M20 20V80H80V20Z ${glyphs[variant % glyphs.length]}"/></g>`;
  return doc(box, defs, body);
}

/** The lifted brush: an empty square drawn in four short strokes. */
export function waitSvg() {
  const box = { x: -6, y: -6, w: 112, h: 112 };
  const side = (x0, y0, x1, y1) => `<path d="M${x0} ${y0}L${x1} ${y1}" stroke-width="7" stroke-linecap="round" stroke-opacity="0.9" fill="none" stroke="#000"/>`;
  const defs = `<filter id="s" ${region(box)}>`
    + `<feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves="2" seed="7" result="n"/>`
    + `<feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G"/></filter>`;
  const body = `<g filter="url(#s)">${side(6, 7, 95, 5)}${side(95, 5, 94, 95)}${side(94, 95, 5, 94)}${side(5, 94, 6, 7)}</g>`;
  return doc(box, defs, body);
}

/** Faint paper fibers over the whole sheet. */
export function paperSvg() {
  const R = rng(20261110), parts = [];
  for (let i = 0; i < 260; i++) {
    const x = R() * W, y = R() * H, a = R() * 6.3, l = 6 + R() * 22;
    parts.push(`<path d="M${f1(x)} ${f1(y)}L${f1(x + Math.cos(a) * l)} ${f1(y + Math.sin(a) * l)}" stroke-opacity="${op(0.25 + R() * 0.45)}"/>`);
  }
  return doc({ x: 0, y: 0, w: W, h: H }, "", `<g stroke="#000" stroke-width="0.8" fill="none">${parts.join("")}</g>`);
}

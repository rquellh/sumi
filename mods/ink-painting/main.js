// Ink painting: a tall sheet beside the terminal (or in any block) that paints while an agent works.
//
// It shows the sheet of the agent in the tab being looked at (else the most recently active one,
// else empty paper). Each agent has its own sheet: a subject (bamboo, misty mountains or a plum
// branch, never the same twice running) and a seed, chosen when a task begins. While the agent
// works a stroke lands every 2.5-4 s; once the subject is done, finishing touches every 3-5 s up to a
// cap. Waiting on you: the brush lifts and an empty red square waits in the corner. A prompt
// ending only rests the brush: the same sheet carries on with the agent's next prompt. When its
// last stroke lands a red seal is stamped; fresh paper begins 20 s later if the agent is still
// working, else with its next prompt.
//
// Painting is in paint.mjs, a sheet's life in sheet.mjs (both pure, tested with node --test).
// Every stroke step is a small SVG alpha mask in <app home>/ink/strokes/<sheet>/, written once and
// never changed (herdr caches drawn files by path), tinted here with the theme's ink and seal red.
// Per-agent records are in ink/state.json, sealed sheets in ink/sheets.json (the last 50). Nothing
// is written under mods/: herdr reloads a mod whose own files change.

import { View, div, svg } from "gpui-kit";
import { agents, spaces, focused, theme, settings, appHome, readTextFile, writeTextFile, layout, props, run } from "herdr";
import * as fs from "fs/promises";
import { W, H, SEAL, compose, stepSvg, sealSvg, waitSvg, paperSvg } from "./paint.mjs";
import {
  HOLD_MS, stepTimes, countAt, workedAt, observe, checkpoint, chooseAgent, freshSheet,
  decodeState, encodeState, decodeArchive, appendArchive, encodeArchive, archiveEntry,
} from "./sheet.mjs";

const STYLE = "s11"; // bump when the drawing changes: files are cached by path
const SEALS = 6;
const REL = "ink";
const CHECKPOINT_MS = 60_000; // a working sheet's stroke count is saved this often
const PRUNE_MS = 10 * 60_000; // an agent gone this long loses its record (sealed sheets are archived already)

const abs = (rel) => `${appHome()}/${rel}`;
const keyOf = (rec) => `${STYLE}-${rec.subject}-${rec.seed}`;
const strokeDir = (key) => `${REL}/strokes/${key}`;
const markPath = (name) => `${REL}/marks/${STYLE}-${name}.svg`;

// A title without its status glyph ("✳ Fix login" -> "Fix login").
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

export default class InkPainting extends View {
  init(_props, cx) {
    this.state = { agents: {}, last: null };
    this.loaded = false;
    this.stateText = null; // state.json as last read or written
    this.dirty = false;
    this.archive = []; // sealed sheets waiting to be appended
    this.sheets = new Map(); // key -> { sheet, times }
    this.ready = new Map(); // key -> steps whose files exist
    this.queue = []; // keys whose files to write
    this.marks = false; // seal, wait and paper files written
    this.size = null;
    this.sig = null; // what the last render drew
    this.wake = null; // resolves the writer's wait
    this.kick = null; // resolves the ticker's wait
    this.lastCheckpoint = 0;
    this.liveAt = {}; // address -> when agents() last listed it (this run only)
    this.startedAt = Date.now();
    this.sweepSoon = false;
    // Folding: with "fold_for": "<node id>" in the block's props, this block hides while that node
    // shows (in sumi: the Files and Changes panel) and comes back when it hides. Checked on render
    // and, because a hidden block may not render, by a slow poll that redraws nothing.
    this.foldFor = (_props ?? props())?.fold_for ?? null;
    // "fade_left": <px> in the props: the painting thins out to bare paper over that many px at
    // the block's left edge, so it meets a terminal beside it without a hard line.
    this.fadeLeft = Number((_props ?? props())?.fade_left) || 0;
    if (this.foldFor) {
      cx.spawn(async (cx) => {
        for (;;) {
          this.fold();
          await cx.sleep(700);
        }
      });
    }

    cx.spawn(async (cx) => {
      await fs.mkdir(abs(`${REL}/strokes`), { recursive: true }).catch(() => {});
      await fs.mkdir(abs(`${REL}/marks`), { recursive: true }).catch(() => {});
      await this.writeMarks();
      try {
        this.stateText = await readTextFile(abs(`${REL}/state.json`));
      } catch {
        this.stateText = null;
      }
      this.state = decodeState(this.stateText);
      this.loaded = true;
      cx.notify();
      await this.sweep();
      // The writer: state, archive and stroke files, woken by render and the ticker.
      for (;;) {
        await this.flush(cx);
        if (!this.dirty && !this.archive.length && !this.queue.length) {
          await new Promise((resolve) => { this.wake = resolve; });
          this.wake = null;
        }
      }
    });

    // The ticker: wakes when the shown sheet's next stroke is due (or when render kicks it).
    cx.spawn(async (cx) => {
      for (;;) {
        const ms = this.delay(Date.now());
        await Promise.race([cx.sleep(ms), new Promise((resolve) => { this.kick = resolve; })]);
        this.kick = null;
        const now = Date.now();
        // Statuses are also read here, not only on render: a sheet sealed mid-task gives way to
        // fresh paper after HOLD_MS with nothing else changing on screen.
        if (this.loaded) this.track(agents(), now);
        if (this.loaded && now - this.lastCheckpoint >= CHECKPOINT_MS) this.checkpointAll(now);
        if (this.signature(this.view(now)) !== this.sig) cx.notify();
      }
    });
  }

  fold() {
    if (!this.foldFor) return;
    const find = (node, test) => {
      if (!node) return null;
      if (test(node)) return node;
      for (const child of node.children ?? []) {
        const found = find(child, test);
        if (found) return found;
      }
      return null;
    };
    const root = layout();
    const other = find(root, (n) => n.id === this.foldFor);
    const me = find(root, (n) => n.content?.mod === "ink-painting");
    if (!other || !me?.id) return;
    const hide = !other.hidden;
    if (Boolean(me.hidden) !== hide) run(hide ? "layout.hide" : "layout.show", { id: me.id });
  }

  // ------------------------------------------------------------ sheets

  sheetOf(rec) {
    const key = keyOf(rec);
    let entry = this.sheets.get(key);
    if (!entry) {
      const sheet = compose(rec.subject, rec.seed);
      entry = { key, sheet, times: stepTimes(rec.seed, sheet.main, sheet.steps.length) };
      this.sheets.set(key, entry);
      if (this.sheets.size > 16) this.sheets.delete(this.sheets.keys().next().value);
    }
    return entry;
  }

  ctx(a) {
    const tab = spaces().flatMap((s) => s.tabs).find((t) => t.id === a?.tab);
    return {
      times: (rec) => this.sheetOf(rec).times,
      fresh: (prev) => freshSheet(prev),
      workingSince: tab?.working_since ?? null,
    };
  }

  // Each render sees live statuses; a change updates that agent's record.
  track(list, now) {
    for (const a of list) {
      const before = this.state.agents[a.address];
      const res = observe(before, a.status, now, this.ctx(a));
      if (!res.changed) continue;
      const rec = { ...res.rec, name: a.space_name || null, title: clean(a.title) || a.tab_name || null, seenAt: now };
      this.state.agents[a.address] = rec;
      if (rec.subject && (res.fresh || res.sealed || before?.status !== a.status)) this.state.last = a.address;
      if (res.sealed) this.archive.push(archiveEntry(rec, { address: a.address, name: rec.name, title: rec.title }, now));
      if (res.fresh) {
        this.need(keyOf(rec));
        this.sweepSoon = true; // the sheet it replaced has no more use for its files
      }
      this.dirty = true;
      this.wake?.();
    }
  }

  checkpointAll(now) {
    this.lastCheckpoint = now;
    const live = new Set(agents().map((a) => a.address));
    for (const addr of live) this.liveAt[addr] = now;
    for (const [addr, rec] of Object.entries(this.state.agents)) {
      if (!live.has(addr)) {
        if (live.size && now - (this.liveAt[addr] ?? this.startedAt) > PRUNE_MS) {
          delete this.state.agents[addr];
          if (this.state.last === addr) this.state.last = null;
          this.dirty = true;
          this.sweepSoon = true;
        }
        continue;
      }
      if (rec.subject && rec.since != null) {
        this.state.agents[addr] = checkpoint(rec, now, this.sheetOf(rec).times);
        this.dirty = true;
      }
    }
    if (this.dirty) this.wake?.();
  }

  // What to draw now: the shown agent's sheet and how much of it is ready.
  view(now) {
    if (!this.loaded) return null;
    const addr = chooseAgent(agents(), focused(), this.state.agents, this.state.last);
    const rec = addr ? this.state.agents[addr] : null;
    if (!rec) return null;
    if (!rec.subject) return { needs: rec.needs };
    const { key, sheet, times } = this.sheetOf(rec);
    const want = Math.min(sheet.steps.length, rec.since != null ? countAt(times, workedAt(rec, now)) : rec.strokeCount);
    const ready = this.ready.get(key) ?? 0;
    // Complete is shown sealed at once; the record is sealed by the next track().
    const sealed = rec.sealed || want >= sheet.steps.length;
    return { key, sheet, times, rec, want, count: Math.min(want, ready), sealed, needs: rec.needs && !sealed };
  }

  signature(v) {
    if (!v) return "empty";
    return `${v.key ?? ""}|${v.count ?? 0}|${v.sealed ? 1 : 0}|${v.needs ? 1 : 0}|${this.marks ? 1 : 0}`;
  }

  // How long until the shown sheet's next stroke.
  delay(now) {
    const v = this.view(now);
    if (v?.rec?.sealed && v.rec.status === "working") return Math.max(300, Math.min(15_000, (v.rec.sealedAt ?? now) + HOLD_MS - now + 50));
    if (!v?.rec || v.rec.since == null) return 15_000;
    if (v.count < v.want) return 1_000; // files still being written
    const next = v.times[v.want];
    if (next === undefined) return 15_000;
    return Math.max(300, Math.min(15_000, next - workedAt(v.rec, now) + 50));
  }

  need(key) {
    if ((this.ready.get(key) ?? -1) >= (this.sheets.get(key)?.sheet.steps.length ?? Infinity)) return;
    if (this.queue.includes(key)) return;
    this.queue.push(key);
    this.wake?.();
  }

  // ------------------------------------------------------------ files

  async writeMarks() {
    try {
      for (let v = 0; v < SEALS; v++) {
        if (!(await fs.exists(abs(markPath(`seal-${v}`))))) await fs.writeFile(abs(markPath(`seal-${v}`)), sealSvg(v));
      }
      if (!(await fs.exists(abs(markPath("wait"))))) await fs.writeFile(abs(markPath("wait")), waitSvg());
      if (!(await fs.exists(abs(markPath("paper"))))) await fs.writeFile(abs(markPath("paper")), paperSvg());
      this.marks = true;
    } catch (e) {
      console.log(`ink-painting: marks: ${e}`);
    }
  }

  // Writes a sheet's step files in order (once: a marker says the folder is complete).
  async writeSheet(key, cx) {
    const entry = this.sheets.get(key);
    if (!entry) return;
    const dir = abs(strokeDir(key)), total = entry.sheet.steps.length;
    if (await fs.exists(`${dir}/complete`)) {
      this.ready.set(key, total);
      cx.notify();
      return;
    }
    await fs.mkdir(dir, { recursive: true });
    for (let i = this.ready.get(key) ?? 0; i < total; i++) {
      const f = stepSvg(entry.sheet, i);
      if (f.ink) await fs.writeFile(`${dir}/${i}.svg`, f.ink);
      if (f.acc) await fs.writeFile(`${dir}/${i}a.svg`, f.acc);
      this.ready.set(key, i + 1);
      if (i % 12 === 11) cx.notify();
    }
    await fs.writeFile(`${dir}/complete`, `${total}\n`);
    cx.notify();
  }

  async flush(cx) {
    while (this.queue.length) {
      const key = this.queue[0];
      try {
        await this.writeSheet(key, cx);
      } catch (e) {
        console.log(`ink-painting: ${key}: ${e}`);
      }
      this.queue.shift();
    }
    if (this.archive.length) await this.appendArchive();
    if (this.dirty) await this.saveState();
    if (this.sweepSoon) {
      this.sweepSoon = false;
      await this.sweep();
    }
  }

  async saveState() {
    this.dirty = false;
    const text = encodeState(this.state);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeTextFile(abs(`${REL}/state.json`), text, this.stateText);
        this.stateText = text;
        return;
      } catch {
        try {
          this.stateText = await readTextFile(abs(`${REL}/state.json`));
        } catch {
          this.stateText = null;
        }
      }
    }
    this.dirty = true; // try again on the next wake
  }

  async appendArchive() {
    const entries = this.archive;
    this.archive = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      let before = null;
      try {
        before = await readTextFile(abs(`${REL}/sheets.json`));
      } catch {
        before = null;
      }
      let list = decodeArchive(before);
      for (const e of entries) list = appendArchive(list, e);
      try {
        await writeTextFile(abs(`${REL}/sheets.json`), encodeArchive(list), before);
        return;
      } catch {
        // written in between: read again
      }
    }
    this.archive = entries.concat(this.archive);
  }

  // Removes stroke folders no agent's sheet uses any more, and marks from older styles.
  async sweep() {
    try {
      const keep = new Set(Object.values(this.state.agents).filter((r) => r.subject).map(keyOf));
      for (const name of await fs.readdir(abs(`${REL}/strokes`))) {
        if (keep.has(name)) continue;
        const dir = abs(`${REL}/strokes/${name}`);
        for (const f of await fs.readdir(dir)) await fs.unlink(`${dir}/${f}`);
        await fs.rmdir(dir);
      }
      for (const name of await fs.readdir(abs(`${REL}/marks`))) {
        if (!name.startsWith(`${STYLE}-`)) await fs.unlink(abs(`${REL}/marks/${name}`));
      }
    } catch (e) {
      console.log(`ink-painting: sweep: ${e}`);
    }
  }

  // ------------------------------------------------------------ drawing

  render() {
    const t = theme();
    const now = Date.now();
    if (this.loaded) this.track(agents(), now);
    this.fold();
    // on_size_change reports zoomed points; element sizes here are layout px.
    const zoom = Number(settings()?.zoom) || 1;
    const size = this.size ? { width: this.size.width / zoom, height: this.size.height / zoom } : { width: 268, height: 360 };
    const root = div().id("root").size_full().relative().overflow_hidden().bg(t.surface)
      .on_size_change((s, cx) => {
        if (!this.size || Math.abs(s.width - this.size.width) > 0.5 || Math.abs(s.height - this.size.height) > 0.5) {
          this.size = s;
          cx.notify();
        }
      });
    // A folded sidebar (the rail) or a squeezed block: no painting.
    if (size.width < 160 || size.height < 140) return root;

    const v = this.view(now);
    if (v?.key && v.count < v.want) this.need(v.key);
    const sig = this.signature(v);
    if (sig !== this.sig) {
      this.sig = sig;
      this.kick?.();
    }

    // The sheet has no edge of its own: it is the block's paper, as large as fits, standing on the bottom.
    const s = Math.min(size.width / W, size.height / H);
    const sw = W * s, sh = H * s;
    const sheet = div().absolute().left((size.width - sw) / 2).top(size.height - sh).w(sw).h(sh).overflow_hidden();
    const els = [], over = [];
    if (this.marks) els.push(svg(markPath("paper")).absolute().left(0).top(0).w(sw).h(sh).text_color(t.foreground).opacity(0.1));
    if (v?.key) {
      // While the brush moves, the next stroke is already drawn, unseen: when it is due its opacity
      // turns to 1 and GPUI fades it in natively (no timer, no extra renders).
      const dir = strokeDir(v.key);
      const next = v.rec?.since != null && v.count === v.want && v.count < v.sheet.steps.length && (this.ready.get(v.key) ?? 0) > v.count;
      const pending = next ? v.count + 1 : v.count;
      for (let i = 0; i < pending; i++) {
        const b = v.sheet.boxes[i], st = v.sheet.steps[i], shown = i < v.count ? 1 : 0;
        const at = (el, id) => el.id(id).absolute().left(b.x * s).top(b.y * s).w(b.w * s).h(b.h * s)
          .opacity(shown).transition("opacity", { duration: 1400, easing: "ease-out" });
        if (st.acc?.length) els.push(at(svg(`${dir}/${i}a.svg`), `${v.key}-${i}a`).text_color(t.accent));
        if (st.m?.length) els.push(at(svg(`${dir}/${i}.svg`), `${v.key}-${i}`).text_color(t.foreground));
      }
    }
    if (this.marks && (v?.sealed || v?.needs || v?.key)) {
      // The seal is stamped in (a short fade); the empty square for "needs you" just appears.
      const spot = v.sheet?.seal ?? { x: W - 40 - SEAL, y: H - 44 - SEAL };
      const m = SEAL * 1.12 * s;
      // Drawn over the left fade, in the block's own coordinates: the marks never thin out.
      const ox = (size.width - sw) / 2, oy = size.height - sh;
      const place = (el) => el.absolute().left(ox + (spot.x - SEAL * 0.06) * s).top(oy + (spot.y - SEAL * 0.06) * s).w(m).h(m).text_color(t.accent);
      if (v.key) {
        over.push(place(svg(markPath(`seal-${(v.rec?.seed ?? 0) % SEALS}`))).id(`${v.key}-seal`)
          .opacity(v.sealed ? 1 : 0).transition("opacity", { duration: 700, easing: "ease-out" }));
      }
      if (v.needs) over.push(place(svg(markPath("wait"))));
    }
    const fade = [];
    if (this.fadeLeft > 0) {
      const w = 4, n = Math.max(1, Math.round(this.fadeLeft / w)); // whole-px strips that never overlap: no banding
      for (let i = 0; i < n; i++) {
        const k = 1 - (i + 0.5) / n;
        fade.push(div().absolute().left(i * w).top(0).w(w).h(size.height).bg(t.surface).opacity(k * k * (3 - 2 * k)));
      }
    }
    return root.child(sheet.children(els)).children(fade).children(over);
  }
}

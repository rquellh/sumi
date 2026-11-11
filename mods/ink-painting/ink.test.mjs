// node --test mods/ink-painting/ink.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { rng, hash, compose, stepSvg, sealSvg, waitSvg, paperSvg, W, H, SUBJECTS } from "./paint.mjs";
import {
  stepTimes, countAt, workedAt, freshSheet, isFinish, observe, checkpoint, chooseAgent,
  decodeState, encodeState, decodeArchive, appendArchive, encodeArchive, archiveEntry, FAST_MS, SLOW_MS, ARCHIVE_MAX, HOLD_MS,
} from "./sheet.mjs";

// ---------------------------------------------------------------- the seeded painting

test("rng: the same seed gives the same sequence, another seed another", () => {
  const a = rng(42), b = rng(42), c = rng(43);
  const sa = Array.from({ length: 20 }, a), sb = Array.from({ length: 20 }, b), sc = Array.from({ length: 20 }, c);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  for (const v of sa) assert.ok(v >= 0 && v < 1);
  assert.equal(hash(1, 2, 3), hash(1, 2, 3));
  assert.notEqual(hash(1, 2, 3), hash(3, 2, 1));
});

test("compose: the same tuple gives the same strokes and the same SVG files", () => {
  for (const subject of SUBJECTS) {
    const a = compose(subject, 12345), b = compose(subject, 12345);
    assert.deepEqual(a, b);
    for (let i = 0; i < a.steps.length; i++) assert.deepEqual(stepSvg(a, i), stepSvg(b, i));
    assert.notDeepEqual(compose(subject, 12346).steps, a.steps, `${subject}: another seed paints another sheet`);
  }
});

test("compose: steps stay on the sheet, the subject comes before a bounded set of extras", () => {
  for (const subject of SUBJECTS) {
    for (const seed of [1, 7, 42, 99999, 2147483000]) {
      const s = compose(subject, seed);
      assert.ok(s.main >= 10, `${subject}/${seed}: a real subject (${s.main} steps)`);
      assert.ok(s.steps.length > s.main && s.steps.length <= 110, `${subject}/${seed}: extras are capped (${s.steps.length})`);
      assert.equal(s.boxes.length, s.steps.length);
      for (const b of s.boxes) {
        assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H && b.w > 0 && b.h > 0, `${subject}/${seed}: box ${JSON.stringify(b)}`);
      }
      assert.ok(s.seal.x > 0 && s.seal.y > H / 2 && s.seal.x < W && s.seal.y < H, "the seal sits in a lower corner");
      for (let i = 0; i < s.steps.length; i++) {
        const f = stepSvg(s, i);
        assert.ok(f.ink || f.acc, "every step draws something");
        for (const text of [f.ink, f.acc].filter(Boolean)) {
          assert.match(text, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
          assert.doesNotMatch(text, /NaN|undefined|Infinity/);
          assert.doesNotMatch(text, /fill="#|stroke="#[^0]/, "masks carry no color of their own");
        }
      }
    }
  }
});

test("marks: seal, waiting square and paper are fixed SVGs", () => {
  assert.equal(sealSvg(2), sealSvg(2));
  assert.notEqual(sealSvg(1), sealSvg(2));
  for (const text of [sealSvg(0), waitSvg(), paperSvg()]) assert.doesNotMatch(text, /NaN|undefined/);
});

// ---------------------------------------------------------------- time worked to strokes

test("stepTimes: the subject's steps and the finishing touches come at their set gaps", () => {
  const times = stepTimes(42, 30, 50);
  assert.equal(times.length, 50);
  assert.equal(times[0], 0);
  for (let i = 1; i < 30; i++) {
    const gap = times[i] - times[i - 1];
    assert.ok(gap >= FAST_MS[0] && gap <= FAST_MS[1], `main gap ${gap}`);
  }
  for (let i = 30; i < 50; i++) {
    const gap = times[i] - times[i - 1];
    assert.ok(gap >= SLOW_MS[0] && gap <= SLOW_MS[1], `extra gap ${gap}`);
  }
  assert.deepEqual(stepTimes(42, 30, 50), times);
});

test("countAt: the stroke count is a function of time worked, capped at the sheet", () => {
  const times = stepTimes(7, 10, 15);
  assert.equal(countAt(times, -1), 0);
  assert.equal(countAt(times, 0), 1, "the first stroke lands as work begins");
  for (let k = 0; k < times.length; k++) {
    assert.equal(countAt(times, times[k]), k + 1);
    if (times[k] > 0) assert.equal(countAt(times, times[k] - 1), k);
  }
  assert.equal(countAt(times, 10 * 3600_000), 15);
  assert.equal(countAt([], 5000), 0);
  // A stroke every 2.5-4 s for the first minute.
  const perMinute = countAt(stepTimes(1, 40, 60), 60_000);
  assert.ok(perMinute >= 15 && perMinute <= 25, `${perMinute} strokes in a minute`);
});

test("workedAt: banked time plus the running stretch", () => {
  assert.equal(workedAt({ workedMs: 5000, since: null }, 99_000), 5000);
  assert.equal(workedAt({ workedMs: 5000, since: 90_000 }, 99_000), 14_000);
  assert.equal(workedAt({ workedMs: 0, since: 100_000 }, 99_000), 0, "a clock that went back counts nothing");
  assert.equal(workedAt(null, 1), 0);
});

// ---------------------------------------------------------------- statuses

const times = () => stepTimes(1, 20, 40);
const ctxWith = (picks = [{ subject: "plum", seed: 11 }, { subject: "bamboo", seed: 22 }]) => {
  let i = 0;
  return { times, fresh: (prev) => ({ ...picks[i++ % picks.length], prev }) };
};

test("isFinish: a turn ending, as herdr reports it", () => {
  assert.equal(isFinish("working", "done"), true);
  assert.equal(isFinish("blocked", "done"), true);
  assert.equal(isFinish("idle", "done"), true);
  assert.equal(isFinish("working", "idle"), true, "a finish you watched is reported as idle");
  assert.equal(isFinish("done", "done"), false);
  assert.equal(isFinish("done", "idle"), false, "done turning idle is only being looked at");
  assert.equal(isFinish("blocked", "idle"), false);
  assert.equal(isFinish("idle", "idle"), false);
  assert.equal(isFinish(null, "done"), false, "a first sighting is a baseline");
  assert.equal(isFinish(undefined, "idle"), false);
});

test("observe: working paints, blocked lifts the brush, a prompt ending rests it, the last stroke seals", () => {
  const ctx = ctxWith();
  let r = observe(null, "working", 1000, ctx);
  assert.equal(r.fresh, true);
  assert.equal(r.rec.subject, "plum");
  assert.equal(r.rec.seed, 11);
  assert.equal(r.rec.since, 1000);
  assert.equal(r.rec.strokeCount, 1);

  r = observe(r.rec, "working", 2000, ctx);
  assert.equal(r.changed, false, "nothing to save while it keeps working");

  r = observe(r.rec, "blocked", 31_000, ctx);
  assert.equal(r.rec.needs, true);
  assert.equal(r.rec.since, null);
  assert.equal(r.rec.workedMs, 30_000);
  assert.equal(r.rec.strokeCount, countAt(times(), 30_000));
  const lifted = r.rec.strokeCount;

  r = observe(r.rec, "blocked", 300_000, ctx);
  assert.equal(r.rec.strokeCount, lifted, "no strokes while waiting on you");

  r = observe(r.rec, "working", 300_000, ctx);
  assert.equal(r.fresh, false, "the same sheet carries on");
  assert.equal(r.rec.needs, false);
  assert.equal(r.rec.since, 300_000);

  r = observe(r.rec, "idle", 320_000, ctx);
  assert.equal(r.sealed, false, "a prompt ending does not seal an unfinished sheet");
  assert.equal(r.rec.sealed, false);
  assert.equal(r.rec.workedMs, 50_000);
  assert.equal(r.rec.strokeCount, countAt(times(), 50_000));

  r = observe(r.rec, "working", 400_000, ctx);
  assert.equal(r.fresh, false, "the next prompt carries on with the same sheet");
  assert.equal(r.rec.subject, "plum");
  assert.equal(r.rec.workedMs, 50_000);

  // Work until past the last stroke: sealed while still working, and it stays.
  const rest = times().at(-1) - 50_000;
  r = observe(r.rec, "working", 400_000 + rest + 1000, ctx);
  assert.equal(r.sealed, true, "the last stroke seals the sheet");
  assert.equal(r.rec.sealed, true);
  assert.equal(r.rec.strokeCount, times().length);
  r = observe(r.rec, "working", 400_000 + rest + 1000 + HOLD_MS - 1000, ctx);
  assert.equal(r.fresh, false, "still the same task: the sealed sheet is shown for a while");
  assert.equal(r.sealed, false, "sealed once");

  // Still working once the hold is over: fresh paper, mid-task.
  const again = observe(r.rec, "working", 400_000 + rest + 1000 + HOLD_MS, ctx);
  assert.equal(again.fresh, true, "a finished sheet gives way to a new one while the agent keeps working");
  assert.equal(again.rec.subject, "bamboo");
  assert.equal(again.rec.sealed, false);
  assert.equal(again.rec.workedMs, 0);

  // The task ended during the hold instead: the sealed sheet stays until the next prompt.
  r = observe(r.rec, "idle", 400_000 + rest + 1000 + HOLD_MS - 500, ctx);
  assert.equal(r.sealed, false);
  assert.equal(r.rec.sealed, true, "the sealed sheet stays");

  r = observe(r.rec, "working", 400_000 + rest + 200_000, ctx);
  assert.equal(r.fresh, true, "working again starts fresh paper");
  assert.equal(r.rec.sealed, false);
  assert.equal(r.rec.workedMs, 0);
});

test("observe: done does not seal an unfinished sheet; a finished one seals when the agent stops", () => {
  const ctx = ctxWith();
  let r = observe(null, "working", 0, ctx);
  r = observe(r.rec, "done", 60_000, ctx);
  assert.equal(r.sealed, false);
  r = observe(r.rec, "idle", 70_000, ctx);
  assert.equal(r.rec.sealed, false);

  // Not seen between the last stroke and the end of the task: sealed when it stops.
  const all = times().at(-1) + 5000;
  let b = observe(null, "working", 0, ctx);
  b = observe(b.rec, "blocked", all, ctx);
  assert.equal(b.sealed, true);
  assert.equal(b.rec.strokeCount, times().length);
  assert.equal(b.rec.needs, false, "a sealed sheet shows the seal, not the empty square");
});

test("observe: blocked then idle rests the brush without sealing", () => {
  const ctx = ctxWith();
  let r = observe(null, "working", 0, ctx);
  r = observe(r.rec, "blocked", 10_000, ctx);
  r = observe(r.rec, "idle", 20_000, ctx);
  assert.equal(r.rec.sealed, false);
  assert.equal(r.rec.needs, false);
  r = observe(r.rec, "working", 30_000, ctx);
  assert.equal(r.fresh, false);
});

test("observe: an agent first seen idle or done has no sheet yet", () => {
  for (const status of ["idle", "done", "blocked"]) {
    const r = observe(null, status, 0, ctxWith());
    assert.equal(r.rec.subject, null);
    assert.equal(r.sealed, false);
    assert.equal(r.rec.needs, status === "blocked");
  }
});

test("observe: a first sighting mid-task is backdated to when herdr says work began", () => {
  const r = observe(null, "working", 100_000, { ...ctxWith(), workingSince: 40_000 });
  assert.equal(r.rec.since, 40_000);
  assert.equal(r.rec.strokeCount, countAt(times(), 60_000));
  const late = observe(null, "working", 100_000, { ...ctxWith(), workingSince: 200_000 });
  assert.equal(late.rec.since, 100_000, "a start in the future is ignored");
});

test("observe: over a restart, work counts only until the sheet was last seen", () => {
  const ctx = ctxWith();
  let r = observe(null, "working", 0, ctx).rec;
  r = checkpoint(r, 30_000, times());
  const loaded = decodeState(encodeState({ agents: { t1: r }, last: "t1" })).agents.t1;
  assert.equal(loaded.stale, true);
  const after = observe(loaded, "idle", 10 * 3600_000, ctx);
  assert.equal(after.sealed, false, "30 s of work is not a finished sheet, however long the app was closed");
  assert.equal(after.rec.workedMs, 30_000);
  assert.equal(after.rec.strokeCount, countAt(times(), 30_000));
  assert.equal(after.rec.stale, undefined);
  // Still working after the restart: the stretch simply continues.
  const still = observe(decodeState(encodeState({ agents: { t1: r } })).agents.t1, "working", 60_000, ctx);
  assert.equal(still.rec.since, 0);
  assert.equal(still.fresh, false);
});

test("freshSheet: never the subject just painted", () => {
  const R = rng(3);
  for (let i = 0; i < 300; i++) {
    for (const prev of [...SUBJECTS, null]) {
      const s = freshSheet(prev, R);
      assert.notEqual(s.subject, prev);
      assert.ok(SUBJECTS.includes(s.subject));
      assert.ok(Number.isInteger(s.seed) && s.seed > 0);
    }
  }
});

// ---------------------------------------------------------------- which agent

test("chooseAgent: the agent in the tab being looked at, else the most recent with a sheet", () => {
  const list = [
    { address: "t1", tab: "A", focused: false, seq: 5 },
    { address: "t2", tab: "A", focused: true, seq: 1 },
    { address: "t3", tab: "B", focused: false, seq: 9 },
    { address: "t4", tab: "C", focused: false, seq: 20 },
  ];
  const recs = { t1: { subject: "plum" }, t3: { subject: "bamboo" }, t4: { subject: null } };
  assert.equal(chooseAgent(list, { tab: "A" }, recs, null), "t2", "the focused pane's agent");
  assert.equal(chooseAgent(list, { tab: "B" }, recs, null), "t3", "the tab's agent while a shell has focus");
  assert.equal(chooseAgent(list, { tab: "Z" }, recs, null), "t3", "no agent in view: the most recent with a sheet");
  assert.equal(chooseAgent([], { tab: "Z" }, { t9: { subject: "plum" } }, "t9"), "t9", "else the last remembered");
  assert.equal(chooseAgent([], { tab: "Z" }, {}, "t9"), null, "else empty paper");
  assert.equal(chooseAgent([], null, {}, null), null);
});

// ---------------------------------------------------------------- files

test("state: round trip, and garbage reads as empty", () => {
  const st = { agents: { t1: { subject: "plum", seed: 5, strokeCount: 7, sealed: true, workedMs: 3000, since: null, needs: false, status: "idle" } }, last: "t1" };
  const back = decodeState(encodeState(st));
  assert.equal(back.last, "t1");
  assert.equal(back.agents.t1.subject, "plum");
  assert.equal(back.agents.t1.strokeCount, 7);
  assert.equal(back.agents.t1.sealed, true);
  assert.equal(back.agents.t1.stale, true);
  assert.doesNotMatch(encodeState(back), /stale/);
  assert.deepEqual(decodeState("not json"), { agents: {}, last: null });
  assert.deepEqual(decodeState(null), { agents: {}, last: null });
  assert.equal(decodeState(JSON.stringify({ agents: { t2: { subject: "dragon", seed: 1 } } })).agents.t2.subject, null);
});

test("archive: appends once per sheet and keeps the last 50", () => {
  let list = [];
  for (let i = 0; i < 70; i++) list = appendArchive(list, archiveEntry({ subject: SUBJECTS[i % 3], seed: i + 1, strokeCount: i }, { address: "t1", name: "repo", title: "task" }, 1_700_000_000_000 + i));
  assert.equal(list.length, ARCHIVE_MAX);
  assert.equal(list[0].seed, 21, "the oldest go first");
  assert.equal(list.at(-1).seed, 70);
  assert.equal(appendArchive(list, { ...list.at(-1) }), list, "the same sheet twice is kept once");
  const e = list.at(-1);
  assert.equal(e.sealed, true);
  assert.equal(e.agent.name, "repo");
  assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
  const back = decodeArchive(encodeArchive(list));
  assert.deepEqual(back, list);
  assert.deepEqual(decodeArchive("{"), []);
  assert.deepEqual(decodeArchive(JSON.stringify({ sheets: [{ subject: "x", seed: 1 }, null, { subject: "plum", seed: 2 }] })).length, 1);
  assert.equal(appendArchive([], { subject: "plum", seed: 1 }, 3).length, 1);
});

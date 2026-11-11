// A sheet's life, pure (no herdr imports) so node --test can run it.
//
// Per agent the mod keeps a record: the sheet tuple { subject, seed, strokeCount, sealed } plus the
// time worked on it (workedMs, and since: when the current working stretch began). The stroke count
// is a function of time worked (stepTimes/countAt), so a sheet for an agent nobody is looking at
// advances without a timer of its own: its count is computed when it is next shown or saved.
//
// Statuses, as herdr reports them. One sheet runs across as many prompts as it takes to finish:
// - working: the brush moves. Starting to work with a sealed sheet (or none) begins a fresh one.
// - blocked: the brush lifts; the sheet shows an empty red square.
// - idle or done: the brush rests; the unfinished sheet waits for the agent's next prompt.
// - the last stroke: the sheet is sealed (while working or after). If the agent is still working
//   it stays for HOLD_MS and then fresh paper begins; otherwise it stays until the agent next
//   starts working.

export const FAST_MS = [2500, 4000]; // per step of the main subject
export const SLOW_MS = [3000, 5000]; // per finishing touch once the subject is done
export const HOLD_MS = 20000; // a sheet sealed mid-task is shown this long before fresh paper
export const ARCHIVE_MAX = 50;
export const SUBJECTS = ["bamboo", "mountains", "plum"];

// A deterministic 0..1 from integers.
function unit(...ns) {
  let h = 2166136261;
  for (const n of ns) {
    h ^= n | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** When each step appears, in ms of work: step 0 at once, the main subject's steps 2.5-4 s apart,
 *  the finishing touches 3-5 s apart. */
export function stepTimes(seed, main, total) {
  const times = [];
  let at = 0;
  for (let i = 0; i < total; i++) {
    times.push(at);
    const [lo, hi] = i + 1 < main ? FAST_MS : SLOW_MS;
    at += Math.round(lo + (hi - lo) * unit(seed, i));
  }
  return times;
}

/** How many steps show after ms of work (at least one once work has begun). */
export function countAt(times, ms) {
  if (!times.length || !(ms >= 0)) return 0;
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Time worked on a record's sheet by now. */
export function workedAt(rec, now) {
  if (!rec) return 0;
  return (rec.workedMs ?? 0) + (rec.since != null ? Math.max(0, now - rec.since) : 0);
}

/** A new subject (never the one just painted) and seed, from a random source in [0, 1). */
export function freshSheet(prevSubject, random = Math.random) {
  const choices = SUBJECTS.filter((s) => s !== prevSubject);
  const subject = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
  const seed = 1 + Math.floor(random() * 2147483646);
  return { subject, seed };
}

export const blank = () => ({ subject: null, seed: 0, strokeCount: 0, sealed: false, workedMs: 0, since: null, needs: false, status: null });

/** True when going from prev to now is a finish. A first sighting (prev unknown) is not. */
export function isFinish(prev, now) {
  if (prev == null) return false;
  return (now === "done" && prev !== "done") || (now === "idle" && prev === "working");
}

/**
 * The record after the agent is seen with `status` at `now`.
 * ctx.times(rec): the sheet's step times; ctx.fresh(prevSubject): { subject, seed } for a new sheet;
 * ctx.workingSince (optional): when herdr says the agent started working, to backdate a first sighting.
 * Returns { rec, sealed (sealed just now), fresh (a new sheet began), changed }.
 * A sheet is sealed when its last stroke has landed, not when a prompt ends.
 */
export function observe(rec, status, now, ctx) {
  const prev = rec?.status ?? null;
  let r = rec ? { ...rec } : blank();
  let sealed = false, fresh = false;
  // A record carried over a restart counts work only until it was last seen, unless still working.
  const stopAt = r.stale && r.seenAt != null ? Math.min(now, r.seenAt) : now;
  const fold = (at) => {
    if (r.since != null) {
      r.workedMs = (r.workedMs ?? 0) + Math.max(0, at - r.since);
      r.since = null;
    }
    if (r.subject) r.strokeCount = countAt(ctx.times(r), r.workedMs);
  };
  const seal = () => {
    r.sealed = true;
    r.sealedAt = now;
    sealed = true;
  };
  if (status === "working") {
    if (!r.subject || (r.sealed && (prev !== "working" || now - (r.sealedAt ?? 0) >= HOLD_MS))) {
      const s = ctx.fresh(r.subject);
      const back = !rec && Number.isFinite(ctx.workingSince) && ctx.workingSince <= now && now - ctx.workingSince < 6 * 3600_000;
      r = { ...r, subject: s.subject, seed: s.seed, sealed: false, workedMs: 0, since: back ? ctx.workingSince : now, startedAt: now, sealedAt: null };
      r.strokeCount = countAt(ctx.times(r), workedAt(r, now));
      fresh = true;
    } else if (!r.sealed) {
      if (r.since == null) r.since = now;
      // The last stroke landed mid-task: sealed now; fresh paper follows after HOLD_MS of more work.
      if (countAt(ctx.times(r), workedAt(r, now)) >= ctx.times(r).length) {
        fold(now);
        seal();
      }
    }
    r.needs = false;
  } else {
    fold(stopAt);
    if (r.subject && !r.sealed && r.strokeCount >= ctx.times(r).length) seal();
    r.needs = status === "blocked" && !r.sealed;
  }
  r.status = status;
  delete r.stale;
  const changed = !rec || prev !== status || fresh || sealed || Boolean(rec.stale);
  return { rec: r, sealed, fresh, changed };
}

/** Brings a working record's stroke count up to now (for saving); others are unchanged. */
export function checkpoint(rec, now, times) {
  if (!rec?.subject || rec.since == null) return rec;
  return { ...rec, strokeCount: countAt(times, workedAt(rec, now)), seenAt: now };
}

/** The agent whose sheet to show: the one in the tab being looked at (its focused pane's agent
 *  first), else the most recently active agent with a sheet, else the last one remembered. */
export function chooseAgent(list, focused, records, last) {
  const tab = focused?.tab;
  const inTab = (list ?? []).filter((a) => a.tab === tab);
  if (inTab.length) {
    const pick = inTab.find((a) => a.focused) ?? inTab.slice().sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0];
    return pick.address;
  }
  const withSheet = (list ?? []).filter((a) => records?.[a.address]?.subject);
  if (withSheet.length) return withSheet.slice().sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0].address;
  return last && records?.[last]?.subject ? last : null;
}

// ---------------------------------------------------------------- files

/** state.json's text to { agents: { address: record }, last }. Every record is marked stale: its
 *  working stretch was last confirmed at seenAt. */
export function decodeState(text) {
  let raw;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    raw = null;
  }
  const agents = {};
  for (const [addr, r] of Object.entries(raw?.agents ?? {})) {
    if (!r || typeof r !== "object") continue;
    const subject = SUBJECTS.includes(r.subject) ? r.subject : null;
    agents[addr] = {
      ...blank(),
      ...r,
      subject,
      seed: Number.isFinite(r.seed) ? r.seed : 0,
      strokeCount: Number.isFinite(r.strokeCount) ? r.strokeCount : 0,
      workedMs: Number.isFinite(r.workedMs) ? r.workedMs : 0,
      since: Number.isFinite(r.since) ? r.since : null,
      sealed: Boolean(r.sealed),
      needs: Boolean(r.needs),
      stale: true,
    };
  }
  return { agents, last: typeof raw?.last === "string" ? raw.last : null };
}

export function encodeState(state, now = Date.now()) {
  const agents = {};
  for (const [addr, r] of Object.entries(state.agents)) {
    const { stale: _s, ...keep } = r;
    agents[addr] = keep;
  }
  return JSON.stringify({ version: 1, updated: now, last: state.last ?? null, agents }, null, 2) + "\n";
}

/** sheets.json's text to its list of archived sheets (oldest first). */
export function decodeArchive(text) {
  let raw;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    raw = null;
  }
  return (Array.isArray(raw?.sheets) ? raw.sheets : []).filter((s) => s && SUBJECTS.includes(s.subject) && Number.isFinite(s.seed));
}

/** The list with a sheet appended (once: the same subject and seed again is not added), keeping the last max. */
export function appendArchive(list, entry, max = ARCHIVE_MAX) {
  if (list.some((s) => s.subject === entry.subject && s.seed === entry.seed)) return list;
  const next = list.concat([entry]);
  return next.length > max ? next.slice(next.length - max) : next;
}

export function encodeArchive(list, now = Date.now()) {
  return JSON.stringify({ version: 1, updated: now, sheets: list }, null, 2) + "\n";
}

/** What the archive keeps of a sealed sheet. */
export function archiveEntry(rec, agent, now = Date.now()) {
  return {
    subject: rec.subject,
    seed: rec.seed,
    strokeCount: rec.strokeCount,
    sealed: true,
    at: new Date(now).toISOString(),
    agent: { address: agent?.address ?? null, name: agent?.name ?? null, title: agent?.title ?? null },
  };
}

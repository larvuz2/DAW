// What stands in for Max and Ableton Live around Tuple's engine.
//
// The engine was written for Max's [js] object: it answers messages, sends lists out of numbered outlets, defers work
// with Task and asks Live for things through LiveAPI. Here:
//   • outlets are collected as events (the adapter reads them after each call);
//   • Task runs on a VIRTUAL clock that the adapter drains after each call, so nothing depends on real timers: a strummed
//     chord comes back as notes that each say how many milliseconds late they sound, and the same call always gives
//     the same events (in Node, in a browser, in a test);
//   • LiveAPI answers the one question that matters outside Live (the tempo) and shrugs at the rest;
//   • Math.random is a seeded generator: the engine's humanize draws from it, so a seed repeats a take.

/** A small seeded generator (mulberry32) in [0, 1). */
export function seeded(seed = 0) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_TASKS_PER_CALL = 20000;

/**
 * The host of one engine: { outlet, post, Task, LiveAPI, …, events, drain(), now(), log, tempo }.
 * `events` fills with [outlet, at, ...atoms] — `at` is the virtual time in ms at which the engine sent it.
 */
export function createHost({ seed = 0, bpm = 120 } = {}) {
  const queue = [];
  const events = [];
  const log = [];
  let now = 0;
  let order = 0;
  const host = {
    events,
    log,
    tempo: bpm,
    now: () => now,
    outlet(n, ...atoms) {
      // (Max flattens a list given as one array: outlet(7, ["notes", 60, 64]))
      events.push([n, now, ...(atoms.length === 1 && Array.isArray(atoms[0]) ? atoms[0] : atoms)]);
    },
    post(...words) {
      // the engine's console: kept short, for errors that deserve a look (tests read it)
      if (log.length < 200) log.push(words.join(' ').trimEnd());
    },
    messnamed() {},
    max: { version: '8.6', message() {} },
    jsarguments: ['tuple_chord_engine.js'],
    Math: Object.assign(Object.create(Math), { random: seeded(seed) }),
    reseed(next) { host.Math.random = seeded(next); },
    /** Run everything the engine deferred, in the order of its due time; the clock returns to 0 for the next call. */
    drain() {
      let guard = 0;
      while (queue.length) {
        if (++guard > MAX_TASKS_PER_CALL) { queue.length = 0; throw new Error('chord-grid: the engine keeps deferring work (more than 20000 tasks in one call)'); }
        let best = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i].at < queue[best].at || (queue[i].at === queue[best].at && queue[i].order < queue[best].order)) best = i;
        const [job] = queue.splice(best, 1);
        now = job.at;
        job.task.pending = false;
        job.task.fn.call(job.task.obj);
      }
      now = 0;
    }
  };
  host.Task = function Task(fn, obj) {
    this.fn = fn;
    this.obj = obj;
    this.pending = false;
  };
  host.Task.prototype.schedule = function schedule(ms) {
    this.cancel();
    this.pending = true;
    queue.push({ at: now + Math.max(0, Number(ms) || 0), order: order++, task: this });
  };
  host.Task.prototype.cancel = function cancel() {
    if (!this.pending) return;
    this.pending = false;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].task === this) queue.splice(i, 1);
  };
  // Live is not there: no clip, no track, nothing selected, transport stopped — and the tempo the host was given.
  host.LiveAPI = function LiveAPI(callback, where) {
    this.callback = callback;
    this.path = String(where || '');
    this.id = 0;
    this.property = '';
  };
  Object.assign(host.LiveAPI.prototype, {
    get(what) { return what === 'tempo' ? [host.tempo] : [0]; },
    set() {},
    call() { return 0; },
    getcount() { return 0; },
    goto() {}
  });
  host.File = function File() { this.isopen = false; };
  Object.assign(host.File.prototype, { close() {}, writestring() {} });
  return host;
}

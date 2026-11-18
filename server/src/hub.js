// WebSocket hub: keeps every open browser tab of a user in sync with the server's project state,
// relays transport commands (play/stop) and "open project" requests from Claude, and runs "jobs"
// that need the browser's audio engine (offline mixdown render, analysis of non-WAV samples).
import { WebSocketServer } from 'ws';
import { uid } from '@ggs/core';
import { httpError } from './errors.js';
import { activeProjectId } from './backend.js';
import { MAX_FRAME_BYTES, MIN_FRAME_MS, claimAv } from './av.js';

const AV_BURST = 4; // frames a tab may send back to back before the average rate applies

export class Hub {
  /** av: the audio → visual bridge (server/src/av.js), which sends the playing tab's frames over OSC */
  constructor({ store, samples, users, sessions = null, av = null }) {
    this.av = av;
    this.store = store;
    this.samples = samples;
    this.users = users;
    this.sessions = sessions;
    this.clients = new Set();
    this.activity = new Map(); // userId -> recent activity entries
    this.seenOps = new Map(); // "userId:projectId:opId" -> rev (dedupe ops re-sent after a reconnect)
    this.jobs = new Map(); // jobId -> { userId, client, resolve, reject, timer, ... }
    this.ensuring = new Map(); // userId -> pending ensureProject()

    // a socket lives only as long as the credential it was opened with
    for (const evt of ['updated', 'removed', 'token-changed', 'password-changed']) {
      users.on(evt, (u) => this.revalidate(u.id));
    }
    users.on('removed', (u) => this.activity.delete(u.id));

    store.on('ops', (evt) => {
      const msg = { type: 'ops', ...evt };
      for (const c of this.clients) {
        if (c.projectId !== evt.projectId || c.userId !== evt.ownerId) continue;
        if (evt.clientId && c.clientId === evt.clientId) continue; // sender already applied optimistically
        send(c.ws, msg);
      }
      if (evt.source === 'mcp') this.pushActivity(evt.ownerId, { source: 'mcp', projectId: evt.projectId, text: evt.descriptions.join('; ') });
    });
    store.on('list-changed', (ownerId) => this.toUser(ownerId, { type: 'projects-changed' }));
    store.on('versions-changed', ({ projectId, ownerId, source, saved }) => {
      this.toUser(ownerId, { type: 'versions-changed', projectId });
      if (source === 'mcp' && saved) this.pushActivity(ownerId, { source: 'mcp', projectId, text: `Saved version "${saved.name}"` });
    });
    samples.on('changed', (ownerId) => this.toUser(ownerId, { type: 'samples-changed' }));
  }

  /** @param identify (req) => { user, sid } | null — authenticates the upgrade request */
  attach(server, { allowedHosts = null, originOk = null, identify } = {}) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: 16 * 1024 * 1024,
      verifyClient: ({ req }, cb) => {
        // browsers don't apply CORS to WebSockets, so reject cross-site pages explicitly
        if (originOk && !originOk(req)) return cb(false, 403, 'Forbidden');
        if (allowedHosts) {
          let host = null;
          try { host = new URL(`http://${req.headers.host}`).hostname; } catch { /* invalid */ }
          if (!allowedHosts.includes(host)) return cb(false, 403, 'Forbidden');
        }
        const a = identify?.(req, { allowQueryToken: true });
        if (!a?.user) return cb(false, 401, 'Unauthorized');
        req.gtdAuth = a;
        cb(true);
      }
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    const interval = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { c.ws.terminate(); continue; }
        if (!this.stillValid(c)) { c.ws.close(4401, 'Signed out'); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch { /* ignore */ }
      }
    }, 30000);
    interval.unref?.();
    this.wss.on('close', () => clearInterval(interval));
  }

  onConnection(ws, req) {
    const auth = req.gtdAuth;
    const client = {
      ws, clientId: null, projectId: null, userId: auth.user.id, sid: auth.sid || null, tokenHash: auth.tokenHash || null,
      alive: true, lastSeen: Date.now()
    };
    this.clients.add(client);
    // protocol errors (bad frames, invalid UTF-8…) are emitted here; without a listener they'd crash the process
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => {
      this.clients.delete(client);
      this.av?.gone(client);
      const slot = this.avSlots?.get(client.userId);
      if (slot?.owner === client) slot.owner = null;
      if (client.avListener) this.avListenersChanged(client.userId);
      for (const [jobId, job] of this.jobs) {
        if (job.client === client) this.finishJob(jobId, null, httpError(503, 'The browser tab running the job was closed. Keep the studio open and try again.'));
      }
    });
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
      if (msg.type === 'av' && data.length > MAX_FRAME_BYTES) return;
      client.lastSeen = Date.now();
      try {
        await this.onMessage(client, msg);
      } catch (e) {
        send(ws, { type: 'error', opId: msg.opId ?? null, message: e.message, status: e.status || 500, request: msg.type });
      }
    });
    this.ensureProject(client.userId).catch(() => null).then((id) => {
      send(ws, { type: 'welcome', activeProjectId: id, activity: (this.activity.get(client.userId) || []).slice(-30) });
    });
  }

  /**
   * The user's active project, falling back to their most recent one; creates a starter project when they have none.
   * One creation per user at a time, so tabs connecting together don't each make a project.
   */
  ensureProject(userId) {
    let pending = this.ensuring.get(userId);
    if (!pending) {
      pending = (async () => {
        const user = this.users.get(userId);
        let id = await activeProjectId(this.store, this.users, user);
        if (!id) {
          const p = await this.store.create({ ownerId: userId, template: 'default', name: 'My First Beat' });
          await this.users.update(userId, { activeProjectId: p.id });
          id = p.id;
        }
        return id;
      })().finally(() => this.ensuring.delete(userId));
      this.ensuring.set(userId, pending);
    }
    return pending;
  }

  /** Is the credential this socket was opened with (session or API token) still valid? */
  stillValid(c) {
    const u = this.users.get(c.userId);
    if (!u || u.disabled) return false;
    if (c.sid) {
      const s = this.sessions?.get(c.sid);
      if (this.sessions && (!s || s.userId !== c.userId)) return false;
    }
    if (c.tokenHash && u.apiToken?.hash !== c.tokenHash) return false;
    return true;
  }

  revalidate(userId) {
    for (const c of this.clients) if (c.userId === userId && !this.stillValid(c)) c.ws.close(4401, 'Signed out');
  }

  async onMessage(client, msg) {
    if (!this.stillValid(client)) {
      client.ws.close(4401, 'Signed out');
      return;
    }
    switch (msg.type) {
      case 'hello':
        client.clientId = String(msg.clientId || '').slice(0, 64);
        return;
      case 'subscribe': {
        const project = await this.store.getOwned(msg.projectId, client.userId);
        client.projectId = project.id;
        if (msg.makeActive !== false) await this.users.update(client.userId, { activeProjectId: project.id });
        send(client.ws, { type: 'project', project });
        return;
      }
      case 'ops': {
        if (!client.projectId || msg.projectId !== client.projectId) throw new Error('Not subscribed to this project');
        const key = msg.opId ? `${client.userId}:${client.projectId}:${String(msg.opId).slice(0, 100)}` : null;
        if (key && this.seenOps.has(key)) {
          send(client.ws, { type: 'ack', opId: msg.opId, rev: this.seenOps.get(key), duplicate: true });
          return;
        }
        try {
          const p = await this.store.applyOps(msg.projectId, msg.ops, { source: 'ui', clientId: client.clientId, userId: client.userId, coalesce: msg.coalesce });
          if (key) {
            this.seenOps.set(key, p.rev);
            if (this.seenOps.size > 20000) this.seenOps.delete(this.seenOps.keys().next().value);
          }
          send(client.ws, { type: 'ack', opId: msg.opId, rev: p.rev });
        } catch (e) {
          // reject + resync the client with the authoritative state
          const project = await this.store.getOwned(msg.projectId, client.userId).catch(() => null);
          send(client.ws, { type: 'reject', opId: msg.opId, message: e.message, project, gone: !project });
        }
        return;
      }
      case 'resync': {
        if (!client.projectId) return;
        const project = await this.store.getOwned(client.projectId, client.userId);
        send(client.ws, { type: 'project', project });
        return;
      }
      case 'job-error': {
        const job = this.jobs.get(msg.jobId);
        if (job && job.userId === client.userId) this.finishJob(msg.jobId, null, new Error(String(msg.message || 'Job failed in the browser')));
        return;
      }
      case 'job-progress': {
        const job = this.jobs.get(msg.jobId);
        // progress only moves forward (MCP progress notifications must increase)
        if (job && job.userId === client.userId && Number.isFinite(msg.progress) && msg.progress > job.progress) {
          job.progress = Math.min(1, msg.progress);
          try { job.onProgress?.(job.progress); } catch { /* listener errors don't matter */ }
        }
        return;
      }
      case 'ping':
        send(client.ws, { type: 'pong', t: msg.t });
        return;
      case 'av':
        this.avFrame(client, msg.frame);
        return;
      case 'subscribe-av':
        // a visual app on a WebSocket (with the account's API token): it gets the frames of this account's playing tab
        client.avListener = msg.on !== false;
        send(client.ws, { type: 'av-status', listening: client.avListener, osc: this.avOscFor(client.userId) });
        this.avListenersChanged(client.userId);
        return;
      default:
    }
  }

  /** Where OSC goes, for this account: only admins drive it, so only they are told the address. */
  avOscFor(userId) {
    return this.users.get(userId)?.role === 'admin' ? this.av?.oscTarget ?? null : null;
  }

  avListeners(userId) {
    let n = 0;
    for (const c of this.clients) if (c.userId === userId && c.avListener) n++;
    return n;
  }

  /** A listener came or went: the account's sending tabs hear it (one with nobody to send to slows down). */
  avListenersChanged(userId) {
    for (const c of this.clients) if (c.userId === userId && c.avState !== undefined) this.avStatus(c, c.avState, true);
  }

  avStatus(client, state, force = false) {
    const listeners = this.avListeners(client.userId);
    if (!force && state === client.avState && listeners === client.avCount) return;
    client.avState = state;
    client.avCount = listeners;
    send(client.ws, { type: 'av-status', state, osc: this.avOscFor(client.userId), oscForAdmins: !!this.av?.oscTarget, listeners });
  }

  /**
   * A frame of the audio → visual bridge from a tab: out over OSC (one tab at a time), and to this account's listeners
   * (one tab at a time too, by the same rule: a playing tab is heard over a stopped one).
   */
  avFrame(client, frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
    const now = Date.now();
    const final = frame.final === true;
    this.avSlots ??= new Map();
    let slot = this.avSlots.get(client.userId);
    if (!slot) this.avSlots.set(client.userId, (slot = { owner: null, at: 0, playing: false }));
    // at most ~120 frames a second from a tab on average, with room for a few close together (two timer callbacks
    // in a row, frames read together after a stall: dropping one would lose its notes and its changed values); the
    // last frame of the tab heard always goes, it says the music stopped
    const heard = this.av?.slot.owner === client || slot.owner === client;
    client.avTokens = Math.min(AV_BURST, (client.avTokens ?? AV_BURST) + (now - (client.avAt || now)) / MIN_FRAME_MS);
    client.avAt = now;
    if (client.avTokens < 1 && !(final && heard)) return;
    client.avTokens = Math.max(0, client.avTokens - 1);
    const r = this.av ? this.av.frame(client, this.users.get(client.userId), frame, now) : { osc: false, reason: 'off' };
    if (claimAv(slot, client, frame, now)) {
      let text = null;
      for (const c of this.clients) {
        // (a listener that can't keep up loses frames rather than growing the server's memory)
        if (c === client || c.userId !== client.userId || !c.avListener || c.ws.readyState !== 1 || c.ws.bufferedAmount > 1 << 20) continue;
        text ??= JSON.stringify({ type: 'av', frame });
        c.ws.send(text);
      }
      if (final) slot.owner = null;
    }
    // the tab shows where its frames go: told when that changes (not 60 times a second), and again after an off/on
    this.avStatus(client, r.osc ? 'osc' : r.reason);
    if (final) client.avState = undefined;
  }

  // ---------------------------------------------------------------- messaging

  toUser(userId, msg, filter = () => true) {
    let n = 0;
    for (const c of this.clients) {
      if (c.userId === userId && filter(c)) { send(c.ws, msg); n++; }
    }
    return n;
  }

  /** Every connected browser (server-wide changes, e.g. the admin turning plugins off). */
  toEveryone(msg) {
    for (const c of this.clients) send(c.ws, msg);
  }

  pushActivity(userId, item) {
    const entry = { ...item, time: new Date().toISOString() };
    const list = this.activity.get(userId) || [];
    list.push(entry);
    if (list.length > 200) list.shift();
    this.activity.set(userId, list);
    this.toUser(userId, { type: 'activity', ...entry });
  }

  /** Send a transport command (play / stop) to the user's browsers viewing the project. */
  transport(userId, projectId, command) {
    return this.toUser(userId, { type: 'transport', ...command }, (c) => c.projectId === projectId);
  }

  /** Ask the user's browsers to open a project. */
  openProject(userId, projectId) {
    return this.toUser(userId, { type: 'open', projectId });
  }

  disconnectUser(userId, { exceptSession = null } = {}) {
    for (const c of this.clients) {
      if (c.userId === userId && (!exceptSession || c.sid !== exceptSession)) c.ws.close(4401, 'Signed out');
    }
  }

  disconnectSession(sid) {
    for (const c of this.clients) if (c.sid && c.sid === sid) c.ws.close(4401, 'Signed out');
  }

  status(userId) {
    const mine = [...this.clients].filter((c) => c.userId === userId);
    return { browsers: mine.length, viewing: mine.map((c) => c.projectId).filter(Boolean) };
  }

  // ---------------------------------------------------------------- browser jobs

  /**
   * Run a job in one of the user's browser tabs (preferring one viewing `projectId`).
   * The browser posts the result to /api/jobs/:id/result (or reports job-error over the socket).
   */
  requestJob(userId, job, { projectId = null, timeoutMs = 120000, onProgress = null } = {}) {
    const candidates = [...this.clients].filter((c) => c.userId === userId && c.ws.readyState === 1)
      .sort((a, b) => (b.projectId === projectId) - (a.projectId === projectId) || b.lastSeen - a.lastSeen);
    if (!candidates.length) {
      return Promise.reject(httpError(409, 'No studio is open in a browser for this account. Open GGS in a browser (and click once to enable audio), then try again.'));
    }
    const jobId = uid('job');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finishJob(jobId, null, httpError(504, 'The browser did not finish the job in time')), timeoutMs);
      timer.unref?.();
      this.jobs.set(jobId, { userId, client: candidates[0], resolve, reject, timer, kind: job.kind, projectId, progress: 0, onProgress });
      send(candidates[0].ws, { type: 'job', jobId, job });
    });
  }

  /** Record a file a running job produced (export-stems uploads each stem as it is rendered). */
  jobFile(jobId, file) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    (job.files ||= []).push(file);
  }

  getJob(jobId, userId) {
    const job = this.jobs.get(jobId);
    return job && job.userId === userId ? job : null;
  }

  finishJob(jobId, result, error) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    this.jobs.delete(jobId);
    clearTimeout(job.timer);
    if (error) {
      job.reject(error);
    } else {
      if (job.kind === 'render' && result?.mix) {
        this.pushActivity(job.userId, { source: 'mcp', projectId: job.projectId, text: `Rendered & analysed the mix: ${result.mix.lufs} LUFS, peak ${result.mix.peakDb} dBFS` });
      }
      if (job.kind === 'export-stems') {
        this.pushActivity(job.userId, { source: 'mcp', projectId: job.projectId, text: `Exported ${job.files?.length || 0} stems` });
      }
      job.resolve(job.files ? { ...result, files: job.files } : result);
    }
    return true;
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

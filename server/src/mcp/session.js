// Tool calls that must not touch the project yet: a dry run, or the calls of a batch.
//
// Tools reach the studio through one backend object. While a call runs inside an EditSession, that backend reads
// the session's working copy and collects the ops instead of applying them; anything that is more than an edit of
// the project (files, playback, the browser, other projects) is refused. Nothing in a tool has to know: the
// session travels with the call through AsyncLocalStorage, so two calls at the same time cannot see each other's.
import { AsyncLocalStorage } from 'node:async_hooks';
import { prepareOps, applyOps } from '@ggs/core';

const current = new AsyncLocalStorage();

/** The store takes at most this many ops in one request: a batch is one request. */
const MAX_OPS = 5000;

/** Backend methods that only read: they work as usual inside a session. */
const READS = new Set([
  'listProjects', 'getActiveId', 'listSamples', 'getSample', 'sampleUsage', 'listSampleFolders', 'status', 'exportFormats',
  'listPlugins', 'listVersions', 'getVersion', 'describeSample', 'recentRenders'
]);

/** What a refused method would have done, for the error. */
const DOES = {
  createProject: 'creates a project', duplicateProject: 'copies a project', deleteProject: 'deletes a project',
  setActive: 'switches the open project', openProject: 'switches the open project', transport: 'controls playback',
  undo: 'changes the undo history', saveVersion: 'saves a version', restoreVersion: 'restores a version',
  requestJob: 'needs the browser, which only knows the project as it is saved', rememberRender: 'renders',
  exportMidi: 'writes a file', convertExport: 'writes a file', deleteExport: 'deletes a file',
  updateSample: 'changes the sample library', deleteSample: 'changes the sample library', deleteSamples: 'changes the sample library',
  moveSamples: 'changes the sample library', createSampleFolder: 'changes the sample library', renameSampleFolder: 'changes the sample library',
  deleteSampleFolder: 'changes the sample library'
};

export class EditSession {
  /** kind: 'dry run' | 'batch'. projectId: the project the session is for (a dry run learns it from its first edit). */
  constructor(real, { kind, projectId = null }) {
    this.real = real;
    this.kind = kind;
    this.projectId = projectId;
    this.tool = '';
    this.base = null; // the project before the first edit
    this.work = null; // … and after the edits so far
    this.ops = [];
  }

  async getProject(id) {
    return this.work && id === this.projectId ? this.work : this.real.getProject(id);
  }

  async getActiveId() {
    return this.projectId || this.real.getActiveId();
  }

  /** Apply ops to the working copy (they are validated exactly as the store would) and keep them for the commit. */
  async applyOps(id, ops) {
    if (!Array.isArray(ops) || !ops.length) throw new Error('ops must be a non-empty array');
    if (this.projectId && id !== this.projectId) throw new Error(`a ${this.kind} edits one project (${this.projectId}); "${this.tool}" tried to edit ${id}`);
    if (!this.work) {
      this.base = await this.real.getProject(id);
      this.work = this.base;
      this.projectId = id;
    }
    if (this.ops.length + ops.length > MAX_OPS) throw new Error(`that is more than ${MAX_OPS} single edits in one change: split the batch in two`);
    // ids are fixed here, so what the tools report (and what later calls of a batch refer to) is what gets committed
    const prepared = prepareOps(ops);
    const after = applyOps(this.work, prepared);
    this.work = { ...after, ownerId: this.base.ownerId, rev: this.base.rev, updatedAt: this.base.updatedAt };
    this.ops.push(...prepared);
    return this.work;
  }

  refuse(method) {
    throw new Error(`"${this.tool}" ${DOES[method] || `calls ${method}`}: that is more than an edit of the project, so it cannot ${this.kind === 'batch' ? 'run inside a batch' : 'be tried with dryRun'}. Call it on its own.`);
  }

  /** Apply everything that was collected as one change: one undo step, one update in the studio. */
  async commit() {
    if (!this.ops.length) return null;
    return this.real.applyOps(this.projectId, this.ops);
  }
}

/** Run fn with `session` as the session of every backend call it makes, however deep and however async. */
export const runInSession = (session, fn) => current.run(session, fn);

/** A backend that behaves like `real` — except inside a session, where it works on the session's copy. */
export function sessionBackend(real) {
  return new Proxy(real, {
    get(target, prop) {
      const value = target[prop];
      const session = current.getStore();
      if (!session || typeof value !== 'function') return value;
      if (prop === 'getProject') return (id) => session.getProject(id);
      if (prop === 'getActiveId') return () => session.getActiveId();
      if (prop === 'applyOps') return (id, ops) => session.applyOps(id, ops);
      if (READS.has(prop)) return value;
      return () => session.refuse(prop);
    }
  });
}

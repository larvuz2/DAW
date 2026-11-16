// MCP server definition: tools, prompts and resources that let Claude produce music.
// Works on top of a user-scoped "backend" (see ../backend.js), so the same tools serve both the
// Streamable HTTP endpoint (/mcp) and the stdio bridge.
// Every tool call comes through `call` below: arguments are checked there (validate.js), a tool that only edits
// the project can be tried without changing anything (dryRun), and `batch` runs several as one change.
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { summarizeProject, diffProjects, didYouMean, brief } from '@greanteadawy/core';
import { GUIDE, INSTRUCTIONS } from './guide.js';
import { z, ok, projectIdArg, annotations as A } from './util.js';
import { validateArgs } from './validate.js';
import { EditSession, runInSession, sessionBackend } from './session.js';
import { registerProjectTools } from './tools/projects.js';
import { registerSoundTools } from './tools/sounds.js';
import { registerNoteTools } from './tools/notes.js';
import { registerArrangeTools } from './tools/arrange.js';
import { registerMixTools } from './tools/mix.js';
import { registerSampleTools } from './tools/samples.js';
import { registerProductionTools } from './tools/production.js';
import { registerExportTools } from './tools/export.js';
import { registerSpatialTools } from './tools/spatial.js';
import { registerPluginTools } from './tools/plugins.js';
import { registerExpressionTools } from './tools/expression.js';
import { registerSynthTools } from './tools/synth.js';
import { registerPrompts } from './prompts.js';

export { GUIDE };

/** The server's version (from server/package.json, so a release only bumps package versions). */
export const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/**
 * Tools that are not read-only and do more than edit the project (files, playback, the browser, versions, the sample
 * library, other projects): they cannot be tried with dryRun or run inside a batch. Every other tool that changes
 * something does it through ops alone and gets both for free — and if one of them ever reached for more, the
 * session would refuse it (see session.js), so nothing is left to trust here.
 */
export const MORE_THAN_EDITS = new Set([
  'create_project', 'open_project', 'duplicate_project', 'delete_project', 'save_version', 'restore_version', 'undo',
  'play', 'stop', 'export_midi', 'export_audio', 'render_mix', 'export_stems', 'export_spatial', 'run_generator',
  'analyze_sample', 'rename_sample', 'sample_folders', 'move_samples', 'delete_sample', 'edit_sample'
]);

const dryRunArg = z.boolean().optional().describe('true = check the call and report what it would change, without changing anything');
const MAX_BATCH = 100;

const fail = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
const texts = (result) => (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text);
const indent = (text, by = '  ') => String(text).split('\n').map((l) => by + l).join('\n');

/** What a session's edits come to, as indented lines (or a sentence when they come to nothing). */
function changesOf(session) {
  if (!session.ops.length) return '  nothing — the call makes no edit';
  const d = diffProjects(session.base, session.work);
  return d.changed ? indent(d.lines.join('\n')) : '  nothing — the project already is that way';
}

/** Build the MCP server for one user. `backend` is a local or remote user-scoped backend. */
export function createMcpServer(realBackend) {
  const server = new McpServer(
    { name: 'greanteadawy', title: 'GreanTeaDawy', version: VERSION },
    { instructions: INSTRUCTIONS }
  );
  // what the tools see: the real thing, or — during a dry run or a batch — a working copy
  const backend = sessionBackend(realBackend);

  async function resolveProjectId(projectId) {
    if (projectId) return projectId;
    const id = await backend.getActiveId();
    if (!id) throw new Error('No active project. Use create_project or open_project first.');
    return id;
  }
  async function load(projectId) {
    return backend.getProject(await resolveProjectId(projectId));
  }

  const registry = new Map(); // name → { name, shape, handler, editable, readOnly }

  /**
   * Register a tool. Errors become isError results that say how to fix the call, never protocol errors. A tool
   * that changes the project through ops alone also takes `dryRun`.
   */
  function tool(name, config, handler) {
    const readOnly = !!config.annotations?.readOnlyHint;
    const editable = !readOnly && !MORE_THAN_EDITS.has(name);
    const shape = { ...(config.inputSchema || {}), ...(editable ? { dryRun: dryRunArg } : {}) };
    registry.set(name, { name, shape, handler, editable, readOnly });
    // (the strict object makes the published schema say what `call` enforces: no arguments beyond these)
    server.registerTool(name, { ...config, inputSchema: z.strictObject(shape) }, (args, extra) => call(name, args, extra));
  }

  /** Check the arguments of one call and run it: for real, or (dryRun) against a copy. */
  async function call(name, rawArgs, extra) {
    try {
      const t = registry.get(name);
      if (!t) throw new Error(`Tool "${brief(name)}" not found.${didYouMean(name, [...registry.keys()])}`);
      const given = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      if (!t.editable && !t.own && given.dryRun) {
        throw new Error(t.readOnly ? `${name} only reads: there is nothing to try. Call it without dryRun.` : `${name} does more than edit the project (files, playback, rendering, versions or the library), so it cannot be tried with dryRun.`);
      }
      // (dryRun: false on a tool that has no dry run is harmless: it is not an unknown argument)
      const { dryRun: asked, ...others } = given;
      const { dryRun = false, ...args } = validateArgs(name, t.shape, t.editable || t.own ? given : others);
      void asked;
      if (t.own) return await t.handler({ ...args, dryRun }, extra);
      if (!dryRun) return await t.handler(args, extra);
      const session = new EditSession(realBackend, { kind: 'dry run' });
      session.tool = name;
      const result = await runInSession(session, () => t.handler(args, extra));
      const [reply = '', ...data] = texts(result);
      return ok(`DRY RUN — nothing was changed. ${name} is valid; it would answer:\n${indent(reply)}\nIt would change:\n${changesOf(session)}`, data.length ? data.join('\n') : undefined);
    } catch (e) {
      return fail(e.message);
    }
  }

  /** Several calls as one change: all of them, or nothing. */
  async function batch({ projectId, calls, dryRun }, extra) {
    const id = await resolveProjectId(projectId);
    await realBackend.getProject(id); // (a project that is not there fails here, before any call is tried)
    const session = new EditSession(realBackend, { kind: 'batch', projectId: id });
    const replies = [];
    for (let i = 0; i < calls.length; i++) {
      const { tool: name, args: given = {} } = calls[i];
      try {
        const t = registry.get(name);
        if (!t) throw new Error(`Tool "${brief(name)}" not found.${didYouMean(name, [...registry.keys()])}`);
        if (t.own) throw new Error('a batch cannot contain a batch');
        if (given.dryRun) throw new Error('set dryRun on the batch itself: it tries all of its calls together');
        const { dryRun: _off, ...rest } = given;
        const args = validateArgs(name, t.shape, rest);
        delete args.dryRun;
        session.tool = name;
        const result = await runInSession(session, () => t.handler(args, extra));
        if (result?.isError) throw new Error(texts(result).join('\n').replace(/^Error: /, ''));
        replies.push(`${i + 1}. ${name}: ${texts(result)[0] ?? 'done'}`.replace(/\n/g, '\n   '));
      } catch (e) {
        const before = i ? `call${i > 1 ? `s 1–${i} were` : ' 1 was'} fine but ${i > 1 ? 'are' : 'is'} not applied` : '';
        const after = i < calls.length - 1 ? `call${calls.length - i - 1 > 1 ? `s ${i + 2}–${calls.length} were` : ` ${i + 2} was`} not tried` : '';
        throw new Error(`Call ${i + 1} of ${calls.length} (${name}) failed: ${e.message.replace(/\nNothing was changed\.$/, '')}\nThe batch changed nothing${before || after ? ` (${[before, after].filter(Boolean).join('; ')})` : ''}. Fix call ${i + 1} and send the batch again.`, { cause: e });
      }
    }
    const list = replies.join('\n');
    if (dryRun) return ok(`DRY RUN — nothing was changed. All ${calls.length} calls are valid; they would answer:\n${list}\nTogether they would change:\n${changesOf(session)}`);
    if (!session.ops.length) return ok(`None of the ${calls.length} calls edits the project, so there was nothing to apply:\n${list}`);
    try {
      await session.commit();
    } catch (e) {
      // every call was fine against the project as it was read: what failed is putting the result in place
      const why = /too large/i.test(e.message)
        ? 'it is too large to send as one change. Split it into two batches.'
        : 'the project was changed (or removed) by someone else while the batch was being prepared. Read it again (get_project) and send the batch again.';
      throw new Error(`The batch was not applied — nothing was changed: ${e.message.replace(/\.$/, '')}. All ${calls.length} calls were valid, but ${why}`, { cause: e });
    }
    return ok(`Applied ${calls.length} calls as ONE change (undo reverts all of it):\n${list}`);
  }

  const ctx = { server, backend, tool, load, resolveProjectId };
  registerProjectTools(ctx);
  registerSoundTools(ctx);
  registerNoteTools(ctx);
  registerArrangeTools(ctx);
  registerMixTools(ctx);
  registerSampleTools(ctx);
  registerProductionTools(ctx);
  registerExportTools(ctx);
  registerSpatialTools(ctx);
  registerPluginTools(ctx);
  registerExpressionTools(ctx);
  registerSynthTools(ctx);
  registerPrompts(ctx);

  const batchShape = {
    projectId: projectIdArg,
    calls: z.array(z.object({
      tool: z.string().describe('Name of the tool to call'),
      args: z.record(z.string(), z.any()).optional().describe("That tool's arguments, as you would send them on their own (projectId is not needed)")
    })).min(1).max(MAX_BATCH).describe('The calls, in order. Later calls see what earlier ones did: a pattern created by call 1 can be filled by call 2, by name.'),
    dryRun: dryRunArg
  };
  registry.set('batch', { name: 'batch', shape: batchShape, handler: batch, own: true });
  server.registerTool('batch', {
    title: 'Several edits as one change',
    description: `Run up to ${MAX_BATCH} editing tools as ONE change: either every call succeeds and the project gets a single update (one undo step, one refresh in the studio) — or, if any call fails, nothing is changed at all and the answer says which call to fix. Use it for edits that belong together: a new section (pattern + notes + clips), a sound with its effects and sends, a mix move over several inserts. It is also faster than separate calls. dryRun=true tries the whole batch and reports what it would change. Only tools that edit the project, and read-only tools, can be in a batch — not rendering, playback, exports, versions, undo, samples or creating/opening projects.`,
    inputSchema: z.strictObject(batchShape),
    annotations: A.edit
  }, (args, extra) => call('batch', args, extra));

  // our own handler for tool calls: the library's validates first, and answers a wrong call with the validator's
  // words; this one answers with what to send instead (see validate.js)
  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) => call(request.params.name, request.params.arguments, extra));

  server.registerResource('guide', 'greanteadawy://guide', {
    title: 'GreanTeaDawy guide', description: 'Concepts, time units and notation used by the tools', mimeType: 'text/markdown'
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }));

  server.registerResource('active-project', 'greanteadawy://project/active', {
    title: 'Active project', description: 'Summary of the project currently open', mimeType: 'text/plain'
  }, async (uri) => {
    const p = await load();
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: summarizeProject(p) }] };
  });

  return server;
}

// Studio status, projects, versions and undo.
import { TEMPLATES, summarizeProject, normalizeKey, diffProjects, didYouMean, requireScale, SCALE_INFO } from '@greanteadawy/core';
import { z, ok, projectIdArg, scaleArg, annotations as A } from '../util.js';

export function registerProjectTools({ tool, backend, load, resolveProjectId }) {
  tool('get_studio_status', {
    title: 'Studio status',
    description: 'Shows the connected account, connection mode, the active project and how many browser tabs are open (so you know if the user can hear playback and whether render_mix is available).',
    inputSchema: {},
    annotations: A.readOnly
  }, async () => {
    const status = await backend.status();
    const active = await backend.getActiveId();
    let activeName = null;
    if (active) { try { activeName = (await backend.getProject(active)).name; } catch { /* ignore */ } }
    return ok(`Active project: ${activeName ? `"${activeName}" [${active}]` : 'none'}`, status);
  });

  tool('list_projects', {
    title: 'List projects',
    description: "List the user's saved projects (id, name, bpm, last update). * marks the active one.",
    inputSchema: {},
    annotations: A.readOnly
  }, async () => {
    const list = await backend.listProjects();
    const active = await backend.getActiveId();
    return ok(list.map((p) => `${p.id === active ? '* ' : '  '}${p.name} [${p.id}] ${p.bpm} BPM, ${p.channels} channels, ${p.patterns} patterns, ${p.clips} clips, updated ${p.updatedAt}`).join('\n') || 'No projects.');
  });

  tool('create_project', {
    title: 'Create project',
    description: `Create a new project, make it active and open it in the browser. Templates: ${Object.entries(TEMPLATES).map(([k, v]) => `${k} (${v.label})`).join(', ')}. Use "empty" to start from scratch, "default" for the standard 4 drum channels (kick, clap, hat, snare).`,
    inputSchema: {
      name: z.string().min(1).max(100).describe('Project name'),
      bpm: z.number().min(20).max(400).optional(),
      template: z.enum(Object.keys(TEMPLATES)).optional().describe('Starter template (default "empty")'),
      key: z.string().optional().describe('Key root, e.g. "C", "F#" (used for roman-numeral chords and the piano roll scale highlight)'),
      scale: scaleArg.optional(),
      timeSignature: z.string().regex(/^\d+\/\d+$/).optional().describe('e.g. "4/4", "3/4", "6/8"')
    },
    annotations: A.edit
  }, async ({ name, bpm, template = 'empty', key, scale: scaleName, timeSignature }) => {
    // validate everything before creating anything (a failed call must not leave a half-made project behind)
    const scale = scaleName === undefined ? undefined : requireScale(scaleName);
    const k = key !== undefined ? normalizeKey(key) : null;
    if (key !== undefined && !k) throw new Error(`Invalid key "${key}": give the root only (C, F#, Bb) and the mode via scale (e.g. key "A", scale "minor")`);
    let timeSig = null;
    if (timeSignature) {
      timeSig = timeSignature.split('/').map(Number);
      if (!(timeSig[0] >= 1 && timeSig[0] <= 32 && [2, 4, 8, 16].includes(timeSig[1]))) throw new Error('Time signature must be N/2, N/4, N/8 or N/16 with N from 1 to 32');
    }
    const templated = !['empty', 'default'].includes(template);
    if (templated && timeSig && !(timeSig[0] === 4 && timeSig[1] === 4)) {
      throw new Error(`The "${template}" template is written in 4/4. Use template "empty" or "default" for ${timeSignature}, or create it in 4/4.`);
    }
    let p = await backend.createProject({ name, bpm, template, ...(k && templated ? { key: k } : {}) });
    const warnings = [];
    if (templated && scale && scale !== p.scale) {
      warnings.push(`Note: the "${template}" template is written in ${p.scale}${k ? `; its chords/melody were moved to ${k}` : ''} but keep their ${p.scale} colour — rewrite them for ${SCALE_INFO[scale].label}.`);
    }
    const patch = {};
    if (k) patch.key = k;
    if (scale) patch.scale = scale;
    if (timeSig) patch.timeSig = timeSig;
    if (Object.keys(patch).length) p = await backend.applyOps(p.id, [{ type: 'project/update', patch }]);
    await backend.setActive(p.id);
    const opened = await backend.openProject(p.id);
    return ok(`Created "${p.name}" [${p.id}] at ${p.bpm} BPM from template "${template}". ${opened ? 'Opened in the browser.' : 'No browser connected right now.'}${warnings.length ? `\n${warnings.join('\n')}` : ''}\n\n${summarizeProject(p, { maxNotes: 24 })}`);
  });

  tool('open_project', {
    title: 'Open project',
    description: 'Make a project active and open it in connected browsers.',
    inputSchema: { projectId: z.string() },
    annotations: A.edit
  }, async ({ projectId }) => {
    const p = await backend.getProject(projectId);
    await backend.setActive(p.id);
    await backend.openProject(p.id);
    return ok(`Opened "${p.name}" [${p.id}].`);
  });

  tool('duplicate_project', {
    title: 'Duplicate project',
    description: 'Save a copy of a project as a new project (e.g. to make an alternative version / remix).',
    inputSchema: { projectId: projectIdArg, name: z.string().optional() },
    annotations: A.edit
  }, async ({ projectId, name }) => {
    const id = await resolveProjectId(projectId);
    const p = await backend.duplicateProject(id, name);
    return ok(`Duplicated as "${p.name}" [${p.id}] (not opened; use open_project to switch).`);
  });

  tool('delete_project', {
    title: 'Delete project',
    description: 'Permanently delete a project and its versions. Only do this when the user explicitly asks.',
    inputSchema: { projectId: z.string() },
    annotations: A.destructive
  }, async ({ projectId }) => {
    await backend.deleteProject(projectId);
    return ok(`Deleted project ${projectId}.`);
  });

  tool('get_project', {
    title: 'Get project',
    description: 'Text overview of a project: tempo, key, channels, every pattern as step grids / note lists, playlist arrangement, mixer & effects, automation. Use this to "look" at the song before and after editing. format="json" returns the raw project.',
    inputSchema: {
      projectId: projectIdArg,
      includeNotes: z.boolean().optional().describe('Include pattern contents (default true)'),
      format: z.enum(['summary', 'json']).optional()
    },
    annotations: A.readOnly
  }, async ({ projectId, includeNotes = true, format = 'summary' }) => {
    const p = await load(projectId);
    if (format === 'json') {
      const { ownerId: _ownerId, ...data } = p;
      return ok(JSON.stringify(data));
    }
    return ok(summarizeProject(p, { notes: includeNotes }));
  });

  tool('update_project', {
    title: 'Update project settings',
    description: 'Change tempo, swing, time signature, name or key/scale.',
    inputSchema: {
      projectId: projectIdArg,
      name: z.string().min(1).max(100).optional(),
      bpm: z.number().min(20).max(400).optional(),
      swing: z.number().min(0).max(100).optional().describe('Swing 0–100: delays every 2nd 16th. MPC/Ableton swing % ≈ 50 + swing/4 (MPC 54% = 16, 58% = 32, 62% = 48, 66% ≈ triplet shuffle = 64; 100 = 75%, dotted). Typical: house 15–25, boom bap 40–55, lo-fi 50–65.'),
      timeSignature: z.string().regex(/^\d+\/\d+$/).optional().describe('e.g. "4/4", "3/4", "6/8"'),
      key: z.string().optional(),
      scale: scaleArg.optional()
    },
    annotations: A.edit
  }, async ({ projectId, name, bpm, swing, timeSignature, key, scale }) => {
    const id = await resolveProjectId(projectId);
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (bpm !== undefined) patch.bpm = bpm;
    if (swing !== undefined) patch.swing = swing / 100;
    if (timeSignature) patch.timeSig = timeSignature.split('/').map(Number);
    if (key) patch.key = key;
    if (scale) patch.scale = requireScale(scale);
    if (!Object.keys(patch).length) throw new Error('Nothing to change');
    const p = await backend.applyOps(id, [{ type: 'project/update', patch }]);
    return ok(`Project "${p.name}": ${p.bpm} BPM, ${p.timeSig.join('/')}, swing ${Math.round(p.swing * 100)}%, key ${p.key} ${p.scale}.`);
  });

  // ---------------------------------------------------------------- versions & undo
  tool('save_version', {
    title: 'Save version',
    description: 'Save a named snapshot of the project (like "Save as version" in a DAW). Do this before big or risky changes, or to keep alternatives (e.g. "before mixdown", "hook v2").',
    inputSchema: { projectId: projectIdArg, name: z.string().max(80).optional() },
    annotations: A.edit
  }, async ({ projectId, name }) => {
    const id = await resolveProjectId(projectId);
    const v = await backend.saveVersion(id, name);
    return ok(`Saved version "${v.name}" [${v.id}].`);
  });

  tool('list_versions', {
    title: 'List versions',
    description: 'List saved versions (snapshots) of a project, newest first.',
    inputSchema: { projectId: projectIdArg },
    annotations: A.readOnly
  }, async ({ projectId }) => {
    const id = await resolveProjectId(projectId);
    const list = await backend.listVersions(id);
    return ok(list.length ? list.map((v) => `${v.name} [${v.id}] ${v.createdAt} — ${v.bpm} BPM, ${v.channels} channels, ${v.patterns} patterns`).join('\n') : 'No versions saved yet (use save_version).');
  });

  /** A saved version by id or name (the newest when several share a name). */
  async function findVersion(id, ref) {
    const list = await backend.listVersions(id);
    if (!list.length) throw new Error('No versions are saved for this project yet (save_version makes one).');
    const wanted = String(ref).trim().toLowerCase();
    const found = list.find((v) => v.id === ref) || list.find((v) => v.name.toLowerCase() === wanted);
    if (!found) throw new Error(`Version "${ref}" not found.${didYouMean(ref, list.map((v) => v.name))} Versions, newest first: ${list.slice(0, 12).map((v) => `${v.name} [${v.id}]`).join(', ')}`);
    return found;
  }

  tool('diff_versions', {
    title: 'What changed between versions',
    description: 'Say what changed between two states of the project, in words: tempo and key, channels and their sound (parameter old → new), patterns and notes (added / removed / changed, as compact note text), clips, markers, automation, mixer and effects. By default: from the most recent saved version to the project as it is now — "what have I changed since I saved". Give `from` and/or `to` (version ids or names) to compare other states, e.g. two versions, or to see what restore_version would bring back (from: that version). Read-only.',
    inputSchema: {
      projectId: projectIdArg,
      from: z.string().optional().describe('Version id or name to start from (default: the most recent saved version)'),
      to: z.string().optional().describe('Version id or name to end at (default: the project as it is now)'),
      maxLines: z.number().int().min(5).max(400).optional().describe('How many lines of detail at most (default 80)')
    },
    annotations: A.readOnly
  }, async ({ projectId, from, to, maxLines = 80 }) => {
    const id = await resolveProjectId(projectId);
    const now = await backend.getProject(id);
    const a = from ? await findVersion(id, from) : (await backend.listVersions(id))[0];
    if (!a) throw new Error('No versions are saved for this project yet, so there is nothing to compare with. save_version makes one — do it before a round of changes, then diff_versions shows what the round did.');
    const b = to ? await findVersion(id, to) : null;
    const before = (await backend.getVersion(id, a.id)).project;
    const after = b ? (await backend.getVersion(id, b.id)).project : now;
    const d = diffProjects(before, after, { maxLines });
    const head = `From version "${a.name}" [${a.id}] (${a.createdAt}) to ${b ? `version "${b.name}" [${b.id}] (${b.createdAt})` : 'the project as it is now'}:`;
    return ok(d.changed ? `${head}\n${d.summary}\n${d.lines.join('\n')}` : `${head}\nNo difference — the two are the same music and the same mix.`);
  });

  tool('restore_version', {
    title: 'Restore version',
    description: 'Replace the current project state with a saved version (diff_versions from: that version shows what would come back and what would be lost). Tip: save_version first if the current state might be wanted later.',
    inputSchema: { projectId: projectIdArg, versionId: z.string() },
    annotations: A.destructive
  }, async ({ projectId, versionId }) => {
    const id = await resolveProjectId(projectId);
    const p = await backend.restoreVersion(id, versionId);
    return ok(`Restored version ${versionId}. "${p.name}" now has ${p.channels.length} channels and ${p.patterns.length} patterns.`);
  });

  tool('undo', {
    title: 'Undo last change',
    description: "Revert the most recent change you (Claude) made through these tools. Refuses if the user edited the project afterwards unless force=true (which also discards the user's later edits).",
    inputSchema: { projectId: projectIdArg, force: z.boolean().optional() },
    annotations: A.destructive
  }, async ({ projectId, force = false }) => {
    const id = await resolveProjectId(projectId);
    const r = await backend.undo(id, { force });
    return ok(`Undid: ${r.undone || 'last change'}.`);
  });
}

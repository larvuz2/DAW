// Tool input is checked here, not by the MCP library, so that a wrong call gets an answer that says how to fix it:
// which argument, what was sent, what is valid there, and the nearest valid value or name. Unknown arguments are
// reported too — the library drops them silently, and a mistyped "lenght" would quietly become the default length.
import { z } from 'zod';
import { didYouMean, nearestNumber, brief } from '@greanteadawy/core';

const MAX_PROBLEMS = 8;

const pathText = (path) => path.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${k}` : String(k)), '');
const show = (v) => {
  if (v === undefined) return 'nothing';
  const text = typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `a list of ${v.length}` : v && typeof v === 'object' ? 'an object' : String(v);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : typeof v === 'string' ? 'a string' : typeof v === 'boolean' ? 'true/false' : `a ${typeof v}`);
const TYPE_WORDS = { string: 'a string', number: 'a number', int: 'a whole number', boolean: 'true or false', array: 'a list', object: 'an object', record: 'an object' };

const defOf = (schema) => schema?._zod?.def;
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'nonoptional', 'readonly', 'catch']);
function unwrap(schema) {
  let s = schema;
  while (s && WRAPPERS.has(defOf(s)?.type)) s = defOf(s).innerType;
  return s;
}
/** What the tool's author wrote about a field (`.describe()`), wherever it sits around the wrappers. */
function describe(schema) {
  for (let s = schema; s; s = WRAPPERS.has(defOf(s)?.type) ? defOf(s).innerType : null) if (s.description) return s.description;
  return '';
}
/** The schema of the value at `path` inside `schema` (null when the path leaves what the schema spells out). */
function schemaAt(schema, path) {
  let s = schema;
  for (const key of path) {
    s = unwrap(s);
    const def = defOf(s);
    if (!def) return null;
    if (def.type === 'object') s = def.shape[key];
    else if (def.type === 'array') s = def.element;
    else if (def.type === 'record') s = def.valueType;
    else if (def.type === 'union') s = def.options.map((o) => schemaAt(o, [key])).find(Boolean) || null;
    else return null;
  }
  return s || null;
}
const valueAt = (value, path) => path.reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), value);

/** Fields a value has that its schema does not know, at any depth (the top level is the strict object's job). */
function unknownFields(schema, value, path, out) {
  const s = unwrap(schema);
  const def = defOf(s);
  if (!def || value === null || value === undefined || out.length >= MAX_PROBLEMS) return;
  const isObject = typeof value === 'object' && !Array.isArray(value);
  // (every loop stops when the list is full: a value with a million stray fields gets eight of them named)
  if (def.type === 'array' && Array.isArray(value)) {
    for (let i = 0; i < value.length && out.length < MAX_PROBLEMS; i++) unknownFields(def.element, value[i], [...path, i], out);
  } else if (def.type === 'record' && isObject) {
    for (const k of Object.keys(value)) {
      if (out.length >= MAX_PROBLEMS) break;
      unknownFields(def.valueType, value[k], [...path, k], out);
    }
  } else if (def.type === 'object' && isObject) {
    for (const [k, v] of Object.entries(value)) {
      if (out.length >= MAX_PROBLEMS) break;
      if (Object.hasOwn(def.shape, k)) unknownFields(def.shape[k], v, [...path, k], out);
      else if (!def.catchall && path.length) out.push({ path, key: k, keys: Object.keys(def.shape) });
    }
  } else if (def.type === 'union' && isObject) {
    // a value that can only be one of the union's object forms: check it against that one
    const objects = def.options.filter((o) => defOf(unwrap(o))?.type === 'object');
    if (objects.length === 1) unknownFields(objects[0], value, path, out);
  }
}

/** One zod issue in words: what is wrong, what is valid, the nearest valid value. */
function problem(issue, root, args) {
  const where = pathText(issue.path);
  const value = valueAt(args, issue.path);
  const schema = schemaAt(root, issue.path);
  const about = describe(schema);
  const hint = about ? ` (${about})` : '';
  const name = where || 'the arguments';
  switch (issue.code) {
    case 'invalid_type':
      if (value === undefined) return `${name} is required${hint}`;
      if (issue.expected === 'int') return `${name} must be a whole number, got ${show(value)}${Number.isFinite(value) ? ` — nearest: ${Math.round(value)}` : ''}${hint}`;
      return `${name} must be ${TYPE_WORDS[issue.expected] || issue.expected}, got ${typeOf(value)} (${show(value)})${hint}`;
    case 'too_big':
    case 'too_small': {
      const big = issue.code === 'too_big';
      const limit = big ? issue.maximum : issue.minimum;
      if (issue.origin === 'array' || issue.origin === 'set') return `${name} has ${value?.length ?? value?.size ?? '?'} items: ${big ? 'at most' : 'at least'} ${limit} ${limit === 1 ? 'is' : 'are'} ${big ? 'allowed' : 'needed'}${hint}`;
      if (issue.origin === 'string') return `${name} is ${value?.length ?? '?'} characters long: ${big ? 'at most' : 'at least'} ${limit} ${big ? 'allowed' : 'needed'}${hint}`;
      if (!issue.inclusive) return `${name} is ${show(value)}: it must be ${big ? 'less' : 'greater'} than ${limit}${hint}`;
      return `${name} is ${show(value)}: the ${big ? 'maximum' : 'minimum'} is ${limit} — nearest valid value: ${limit}${hint}`;
    }
    case 'invalid_value': {
      const options = issue.values || [];
      const near = typeof value === 'number' ? (nearestNumber(value, options) !== null ? ` Nearest: ${nearestNumber(value, options)}.` : '') : didYouMean(value, options);
      return `${name} is ${show(value)}: it must be ${options.length === 1 ? '' : 'one of '}${options.map((o) => JSON.stringify(o)).join(', ')}.${near}${hint}`;
    }
    case 'invalid_union': {
      const inner = (issue.errors || []).flat();
      // a choice between fixed values (16 | 24) reads as one list
      if (inner.length && inner.every((i) => i.code === 'invalid_value' && !i.path.length)) return problem({ ...issue, code: 'invalid_value', values: inner.flatMap((i) => i.values || []) }, root, args);
      const types = [...new Set(inner.filter((i) => i.code === 'invalid_type' && !i.path.length).map((i) => TYPE_WORDS[i.expected] || i.expected))];
      if (value === undefined) return `${name} is required${hint}`;
      // one form of the union fits except for something deeper inside it: say that
      const deeper = (issue.errors || []).filter((list) => list.length && list.every((i) => i.path.length)).sort((a, b) => a.length - b.length)[0];
      if (deeper) return problem({ ...deeper[0], path: [...issue.path, ...deeper[0].path] }, root, args);
      return `${name} must be ${types.length ? types.join(' or ') : 'in one of the accepted forms'}, got ${typeOf(value)} (${show(value)})${hint}`;
    }
    case 'unrecognized_keys': {
      const keys = issue.keys || [];
      const known = Object.keys(defOf(unwrap(schema))?.shape || {});
      const named = keys.slice(0, MAX_PROBLEMS).map((key) => `unknown argument "${brief(key)}"${where ? ` in ${where}` : ''}.${didYouMean(key, known)} ${where ? 'Its fields' : 'The arguments'} are: ${known.join(', ')}`);
      if (keys.length > named.length) named.push(`… and ${keys.length - named.length} more unknown arguments`);
      return named.join('\n- ');
    }
    case 'not_multiple_of':
      return `${name} is ${show(value)}: it must be a multiple of ${issue.divisor}${hint}`;
    default:
      return `${name}: ${issue.message}${value === undefined ? '' : ` (got ${show(value)})`}${hint}`;
  }
}

/**
 * Check `args` against a tool's input shape. Returns the parsed arguments, or throws an Error whose message lists
 * every problem (at most eight) in words.
 */
export function validateArgs(tool, shape, args, { prefix = '' } = {}) {
  const root = z.strictObject(shape);
  const given = args ?? {};
  const result = root.safeParse(given);
  const issues = result.success ? [] : result.error.issues;
  // a mistyped name comes first: it is usually why something else is "required"
  // (only the first problems are shown, so only they are put into words)
  const ordered = [...issues.filter((i) => i.code === 'unrecognized_keys'), ...issues.filter((i) => i.code !== 'unrecognized_keys')];
  const unknown = [];
  if (given && typeof given === 'object') unknownFields(root, given, [], unknown);
  const problems = [
    ...unknown.map((u) => `unknown field "${brief(u.key)}" in ${brief(pathText(u.path), 120)}.${didYouMean(u.key, u.keys)} Its fields are: ${u.keys.join(', ')}`),
    ...ordered.slice(0, MAX_PROBLEMS).map((issue) => problem(issue, root, given)),
    ...ordered.slice(MAX_PROBLEMS).map(() => null)
  ];
  if (!problems.length) return result.data;
  const shown = problems.slice(0, MAX_PROBLEMS).filter((x) => x !== null);
  const more = problems.length > shown.length ? `\n- … and ${problems.length - shown.length} more` : '';
  throw new Error(`${prefix}Invalid arguments for ${tool}:\n- ${shown.join('\n- ')}${more}\nNothing was changed.`);
}

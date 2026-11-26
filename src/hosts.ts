import type { Host } from './types';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED = ['local', 'import'];

export function isLocal(host?: string): boolean { return !host || host === 'local'; }

function fail(field: string, why: string): never { throw new Error(`host ${field}: ${why}`); }

function optStr(o: Record<string, unknown>, k: string, noDash = false): string | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') fail(k, 'must be a string');
  if (noDash && v.startsWith('-')) fail(k, 'must not start with -');
  return v;
}
function optBool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') fail(k, 'must be true or false');
  return v;
}
function optPort(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) fail(k, 'must be a port number');
  return v;
}

/** Check one host profile. Throw an Error that names the bad field. */
export function validateHost(h: unknown): Host {
  if (!h || typeof h !== 'object' || Array.isArray(h)) fail('host', 'must be an object');
  const o = h as Record<string, unknown>;
  for (const k of ['password', 'privateKey']) if (k in o) fail(k, 'is not allowed; use an identityFile path');
  // 'import' is taken by the route /api/hosts/import.
  if (typeof o.id !== 'string' || !ID_RE.test(o.id) || RESERVED.includes(o.id)) fail('id', 'must be a slug and not "local" or "import"');
  if (typeof o.name !== 'string' || !o.name.trim()) fail('name', 'must be a non-empty string');
  if (typeof o.ssh !== 'string' || !o.ssh.trim() || o.ssh.startsWith('-')) fail('ssh', 'must be non-empty and must not start with -');
  const roots = o.roots === undefined ? [] : o.roots;
  if (!Array.isArray(roots) || roots.some(r => typeof r !== 'string')) fail('roots', 'must be an array of strings');
  // A root goes to find on the host. A value such as "-delete" would be read as an option.
  if (roots.some(r => !r.startsWith('/') && !r.startsWith('~'))) fail('roots', 'each folder must start with / or ~');
  const labels = o.labels;
  if (labels !== undefined && (!Array.isArray(labels) || labels.some(l => typeof l !== 'string'))) fail('labels', 'must be an array of strings');
  const out: Host = { id: o.id, name: o.name, ssh: o.ssh, roots: roots as string[] };
  const set = <K extends keyof Host>(k: K, v: Host[K] | undefined) => { if (v !== undefined) out[k] = v; };
  set('group', optStr(o, 'group'));
  if (labels !== undefined) out.labels = labels as string[];
  const color = optStr(o, 'color');
  if (color !== undefined && !/^#[0-9a-fA-F]{3,8}$/.test(color) && !/^[a-zA-Z]{3,20}$/.test(color)) fail('color', 'must be a hex colour or a colour name');
  set('color', color);
  set('port', optPort(o, 'port'));
  set('identityFile', optStr(o, 'identityFile', true));
  set('jump', optStr(o, 'jump', true));
  set('tunnelPort', optPort(o, 'tunnelPort'));
  set('autoConnect', optBool(o, 'autoConnect'));
  set('reconnect', optBool(o, 'reconnect'));
  set('warnSleep', optBool(o, 'warnSleep'));
  set('notes', optStr(o, 'notes'));
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-');

/**
 * Read Host blocks from ~/.ssh/config text. Skip pattern hosts (* ? !).
 * HostName and User are not copied: ssh resolves the alias by itself.
 */
export function parseSshConfig(text: string): Partial<Host>[] {
  const out: Partial<Host>[] = [];
  let cur: Partial<Host>[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      cur = [];
      for (const a of val.split(/\s+/)) {
        if (/[*?!]/.test(a)) continue;
        const id = slug(a);
        // Skip an alias that validateHost would refuse, and a repeated id (the first wins).
        if (!ID_RE.test(id) || RESERVED.includes(id) || seen.has(id)) continue;
        seen.add(id);
        const e: Partial<Host> = { id, name: a, ssh: a, roots: [] };
        cur.push(e); out.push(e);
      }
    } else if (key === 'match') {
      cur = [];
    } else if (key === 'port') {
      const n = Number(val);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) for (const e of cur) e.port ??= n;
    } else if (key === 'identityfile') {
      for (const e of cur) e.identityFile ??= val;
    } else if (key === 'proxyjump') {
      for (const e of cur) e.jump ??= val;
    }
  }
  return out;
}

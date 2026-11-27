import type { Host } from '../src/types';
import type { LinkState } from '../src/ssh';
import { slugify } from '../src/slug';
import { checkClass, checkMark } from '../src/hostcheck';

/** The text of an open host card before any check ran. A connected host must not say "Not connected". */
export const noChecksText = (state: LinkState | string) => state === 'up' ? 'Connected. Use Run Doctor to check the host.'
  : state === 'connecting' ? 'Connecting…' : 'Not connected. Use Connect or Run Doctor.';

export type HostInfo = Host & { state: LinkState; latencyMs?: number; lastError?: string; workers?: number };
export interface HostRow { id: string; name: string; group: string; labels: string[]; server: string; state: LinkState; workers: number }
interface Check { id: string; ok: boolean; warn?: boolean; text: string }

/** Rows for the host manager. Search is case-insensitive over name, group, labels and server. */
export function hostRows(hosts: HostInfo[], query: string): HostRow[] {
  const q = query.trim().toLowerCase();
  const rows = hosts.map(h => ({ id: h.id, name: h.name, group: h.group ?? '', labels: h.labels ?? [], server: h.ssh, state: h.state, workers: h.workers ?? 0 }));
  return rows
    .filter(r => !q || [r.name, r.group, r.server, ...r.labels].some(s => s.toLowerCase().includes(q)))
    .sort((a, b) => (a.group === '' ? 1 : 0) - (b.group === '' ? 1 : 0) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

const list = (s: string, sep: RegExp) => s.split(sep).map(x => x.trim()).filter(Boolean);
const on = (s: string) => s === 'on' || s === 'true';

/** Turn the profile form fields into a Host. It never outputs a password or a private key. */
export function profileFromForm(f: Record<string, string>): Partial<Host> {
  const v = (k: string) => (f[k] ?? '').trim();
  const out: Record<string, unknown> = {};
  for (const k of ['name', 'group', 'color', 'ssh', 'identityFile', 'jump', 'notes']) if (v(k)) out[k] = v(k);
  out.id = v('id') || slugify(v('name'));
  const labels = list(f.labels ?? '', /,/); if (labels.length) out.labels = labels;
  const roots = list(f.roots ?? '', /[\n,]/); if (roots.length) out.roots = roots;
  for (const k of ['port', 'tunnelPort']) if (v(k) && Number.isFinite(Number(v(k)))) out[k] = Number(v(k));
  for (const k of ['autoConnect', 'reconnect', 'warnSleep']) if (k in f) out[k] = on(f[k]!);
  return out as Partial<Host>;
}

export interface HostsCtx {
  api: (path: string, body?: object) => Promise<Response>;
  esc: (s: unknown) => string;
  hostMap: Map<string, HostInfo>;
  hostColor: (h: HostInfo) => string;
  /** Reload the host list from the server and re-render. */
  reload: () => Promise<void>;
  feed: (text: string) => void;
}

export const SWATCHES = ['#9b51e0', '#3b6ef5', '#0f8f8a', '#d08a00'];
const STATE_CLASS: Record<LinkState, string> = { up: 's-done', connecting: 's-running', error: 's-needs-you', down: 's-stopped' };
const DIALOG = 'importDlg'; // shares the Import dialog's CSS, Escape key and click rules

/** Wire the Hosts sidebar section, the host manager and the profile dialog. Returns the render hook. */
export function initHosts(ctx: HostsCtx): { render: () => void } {
  const { esc } = ctx;
  const cards = document.getElementById('hostCards')!;
  const open = new Set<string>();          // expanded cards
  const checks = new Map<string, Check[] | 'loading'>();
  const all = () => [...ctx.hostMap.values()];
  const vp = document.getElementById('vp')!;

  const checkList = (cs: Check[] | 'loading' | undefined) => cs === 'loading' ? '<div class="hchk">Checking…</div>'
    : cs ? cs.map(c => `<div class="hchk ${checkClass(c)}">${checkMark(c)} ${esc(c.text)}</div>`).join('') : '';

  async function runCheck(id: string) {
    checks.set(id, 'loading'); render();
    const r = await fetch(`/api/hosts/${encodeURIComponent(id)}/check`).catch(() => null);
    checks.set(id, r?.ok ? await r.json() as Check[] : [{ id: 'check', ok: false, text: 'The check failed to run.' }]);
    render();
  }
  /** Open a plain shell box on a connected host. */
  let shellBusy = false;
  async function openShell(id: string, btn?: HTMLButtonElement | null) {
    if (shellBusy) return;
    shellBusy = true; if (btn) btn.disabled = true;
    const r = await ctx.api(`/api/hosts/${encodeURIComponent(id)}/shell`, {}).catch(() => null).finally(() => { shellBusy = false; if (btn) btn.disabled = false; });
    if (!r?.ok) ctx.feed(`Could not open a shell: ${((await r?.json().catch(() => null)) as { error?: string } | null)?.error ?? 'the request failed'}`);
  }
  async function toggleLink(id: string) {
    const h = ctx.hostMap.get(id); if (!h) return;
    await ctx.api(`/api/hosts/${encodeURIComponent(id)}/${h.state === 'up' || h.state === 'connecting' ? 'disconnect' : 'connect'}`, {});
    await ctx.reload();
  }

  function render() {
    cards.innerHTML = all().map(h => {
      const isOpen = open.has(h.id), up = h.state === 'up' || h.state === 'connecting';
      return `<div class="hcard" data-id="${esc(h.id)}" style="--hc:${esc(ctx.hostColor(h))}">
        <div class="hhead" data-toggle><span class="dot ${STATE_CLASS[h.state]}" title="${esc(h.state)}"></span>
          <div class="hmain"><b>${esc(h.name)}</b><div class="meta">${esc(h.ssh)}</div></div>
          <span class="hcount" title="Workers on this host">${h.workers ?? 0}</span></div>
        ${h.lastError && h.state === 'error' ? `<div class="hchk bad">${esc(h.lastError)}</div>` : ''}
        ${isOpen ? `<div class="hchecks">${checkList(checks.get(h.id)) || `<div class="hchk">${noChecksText(h.state)}</div>`}
          <div class="hacts">${h.state === 'up' ? '<button class="tb" data-shell>Open Shell</button>' : ''}<button class="tb" data-doctor>Run Doctor</button>
            <button class="tb" data-link>${up ? 'Disconnect' : 'Connect'}</button>
            <button class="tb" data-edit>Edit</button></div></div>` : ''}
      </div>`;
    }).join('');
    const mgr = document.getElementById(DIALOG);
    if (mgr?.dataset.kind === 'manager') fillManager(mgr);
  }

  cards.addEventListener('click', e => {
    const t = e.target as HTMLElement, card = t.closest<HTMLElement>('.hcard'); if (!card) return;
    const id = card.dataset.id!;
    if (t.closest('[data-shell]')) { void openShell(id, t.closest<HTMLButtonElement>('[data-shell]')); return; }
    if (t.closest('[data-doctor]')) { void runCheck(id); return; }
    if (t.closest('[data-link]')) { void toggleLink(id); return; }
    if (t.closest('[data-edit]')) { openProfile(ctx.hostMap.get(id)); return; }
    if (t.closest('[data-toggle]')) {
      if (open.has(id)) open.delete(id);
      else {
        open.add(id);
        if (ctx.hostMap.get(id)?.state === 'up' && !checks.has(id)) void runCheck(id);
      }
      render();
    }
  });
  document.getElementById('hAdd')!.onclick = () => openProfile();

  // ---------- host manager ----------
  function openManager() {
    document.getElementById(DIALOG)?.remove();
    const dlg = document.createElement('div'); dlg.id = DIALOG; dlg.dataset.kind = 'manager';
    dlg.innerHTML = `<h2>Hosts</h2>
      <div class="hm-bar"><input type="search" data-q placeholder="Search name, group, label or server" aria-label="Search hosts">
        <button class="tb" data-import>Import ~/.ssh/config</button><button class="tb" data-new>+ Add Host</button></div>
      <div data-imp></div><div data-tbl></div>
      <div class="imp-foot"><button class="tb" data-close>Close</button></div>`;
    vp.appendChild(dlg);
    fillManager(dlg);
    dlg.oninput = e => { if ((e.target as HTMLElement).matches('[data-q]')) fillTable(dlg); };
    dlg.ondblclick = e => {
      const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-id]'); if (!tr) return;
      const h = ctx.hostMap.get(tr.dataset.id!); if (h && h.state !== 'up' && h.state !== 'connecting') void toggleLink(h.id);
    };
    dlg.onclick = e => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-close]')) dlg.remove();
      else if (t.closest('[data-new]')) openProfile();
      else if (t.closest('[data-import]')) void runImport(dlg);
      else if (t.closest('[data-shell]')) void openShell(t.closest<HTMLElement>('tr')!.dataset.id!, t.closest<HTMLButtonElement>('[data-shell]'));
      else if (t.closest('[data-edit]')) openProfile(ctx.hostMap.get(t.closest<HTMLElement>('tr')!.dataset.id!));
    };
  }
  function fillManager(dlg: HTMLElement) { fillTable(dlg); }
  function fillTable(dlg: HTMLElement) {
    const q = (dlg.querySelector('[data-q]') as HTMLInputElement | null)?.value ?? '';
    const rows = hostRows(all(), q);
    dlg.querySelector('[data-tbl]')!.innerHTML = rows.length ? `<table class="hm"><thead><tr><th>Name</th><th>Group</th><th>Labels</th><th>Server</th><th>Status</th><th>Workers</th><th></th></tr></thead><tbody>${
      rows.map(r => `<tr data-id="${esc(r.id)}" title="Double-click to connect"><td><b>${esc(r.name)}</b></td><td>${esc(r.group)}</td>
        <td>${r.labels.map(l => `<span class="hlabel">${esc(l)}</span>`).join(' ')}</td><td>${esc(r.server)}</td>
        <td><span class="dot ${STATE_CLASS[r.state]}"></span> ${esc(r.state)}</td><td>${r.workers}</td><td>${r.state === 'up' ? '<button class="tb" data-shell>Open Shell</button> ' : ''}<button class="tb" data-edit>Edit</button></td></tr>`).join('')}</tbody></table>`
      : `<p class="empty">${all().length ? 'No host matches the search.' : 'No hosts yet. Add one, or import your ~/.ssh/config.'}</p>`;
  }
  async function runImport(dlg: HTMLElement) {
    const slot = dlg.querySelector('[data-imp]') as HTMLElement;
    const r = await fetch('/api/hosts/import').catch(() => null);
    const found = (r?.ok ? await r.json() : []) as Partial<Host>[];
    const fresh = found.filter(f => f.ssh && !all().some(h => h.ssh === f.ssh || h.id === slugify(f.name ?? f.ssh!)));
    slot.innerHTML = fresh.length ? `<p>Pick an entry to review it as a new host. Nothing is saved until you press Save.</p>${
      fresh.map((f, i) => `<div class="imp-row"><div><b>${esc(f.name ?? f.ssh)}</b><div class="meta">${esc(f.ssh)}${f.port ? `:${esc(f.port)}` : ''}</div></div>
        <div class="acts"><button data-pick="${i}">Add…</button></div></div>`).join('')}` : '<p class="empty">No new entries in ~/.ssh/config.</p>';
    slot.onclick = e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]'); if (b) openProfile(undefined, fresh[Number(b.dataset.pick)]);
    };
  }

  // ---------- profile dialog ----------
  function openProfile(existing?: HostInfo, seed?: Partial<Host>) {
    document.getElementById(DIALOG)?.remove();
    const h: Partial<Host> = existing ?? seed ?? {};
    const color = h.color && SWATCHES.includes(h.color) ? h.color : (existing || seed ? h.color ?? '' : SWATCHES[0]!);
    const dlg = document.createElement('div'); dlg.id = DIALOG; dlg.dataset.kind = 'profile';
    const f = (label: string, name: string, val: unknown, ph = '') =>
      `<label class="f">${label}<input name="${name}" value="${esc(val ?? '')}" placeholder="${esc(ph)}" autocomplete="off"></label>`;
    const cb = (label: string, name: string, v: boolean | undefined, def: boolean) =>
      `<label class="ck"><input type="checkbox" name="${name}" ${(v ?? def) ? 'checked' : ''}> ${label}</label>`;
    dlg.innerHTML = `<h2>${existing ? 'Edit Host' : 'Add Host'}</h2>
      <div class="seg hp-tabs"><button data-tab="basic" class="on">Basic</button><button data-tab="adv">Advanced</button><button data-tab="beh">Behaviour</button><button data-tab="notes">Notes</button></div>
      <form class="hp" autocomplete="off">
        <input type="hidden" name="id" value="${esc(existing?.id ?? '')}">
        <input type="hidden" name="color" value="${esc(color)}">
        <div data-pane="basic">
          ${f('Name', 'name', h.name, 'Mac mini')}${f('Group', 'group', h.group, 'Lab')}${f('Labels (comma separated)', 'labels', (h.labels ?? []).join(', '), 'mac, worker')}
          <div class="f">Colour<div class="sw">${SWATCHES.map(c => `<button type="button" class="swatch${c === color ? ' on' : ''}" data-color="${c}" style="background:${c}" title="${c}" aria-label="Colour ${c}"></button>`).join('')}</div></div>
          ${f('Server (SSH alias or user@host)', 'ssh', h.ssh, 'mini or me@10.0.0.5')}
        </div>
        <div data-pane="adv" hidden>
          ${f('Port', 'port', h.port, '22')}${f('Identity file (path, no password)', 'identityFile', h.identityFile, '~/.ssh/id_ed25519')}${f('Jump host (ProxyJump)', 'jump', h.jump)}
          <label class="f">Repo folders (one per line)<textarea name="roots" rows="3">${esc((h.roots ?? []).join('\n'))}</textarea></label>
          ${f('Tunnel port', 'tunnelPort', h.tunnelPort, 'same as the console port')}
        </div>
        <div data-pane="beh" hidden>
          ${cb('Connect when the console starts', 'autoConnect', h.autoConnect, false)}${cb('Reconnect after a lost link', 'reconnect', h.reconnect, true)}${cb('Warn when the host may sleep', 'warnSleep', h.warnSleep, false)}
        </div>
        <div data-pane="notes" hidden><label class="f">Notes<textarea name="notes" rows="5">${esc(h.notes ?? '')}</textarea></label></div>
      </form>
      <div class="hp-err" data-err hidden></div><div class="hp-checks" data-checks></div>
      <div class="imp-foot"><button class="tb" data-close>Cancel</button><button class="tb" data-test>Test Connection</button>
        <button class="tb" data-save>Save</button><button class="send" data-saveconnect>Save and Connect</button></div>`;
    vp.appendChild(dlg);
    const form = dlg.querySelector('form')!, err = dlg.querySelector('[data-err]') as HTMLElement;
    const showErr = (m: string) => { err.textContent = m; err.hidden = !m; };
    const fields = () => {
      const o: Record<string, string> = {};
      for (const el of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) o[el.name] = el.type === 'checkbox' ? ((el as HTMLInputElement).checked ? 'on' : '') : el.value;
      return o;
    };
    async function save(): Promise<string | null> {
      const p = profileFromForm(fields());
      const plain = (x: HostInfo): Partial<Host> => { const { state: _s, latencyMs: _l, lastError: _e, workers: _w, ...rest } = x; return rest; };
      if (!existing && all().some(x => x.id === p.id)) { showErr(`A host with the id "${p.id}" exists already.`); return null; }
      // Edit replaces by id and keeps the order. A new host goes last.
      const out = existing ? all().map(x => x.id === existing.id ? p : plain(x)) : [...all().map(plain), p];
      const r = await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hosts: out }) }).catch(() => null);
      if (!r?.ok) { showErr(((await r?.json().catch(() => ({}))) as { error?: string })?.error ?? 'The host could not be saved.'); return null; }
      showErr(''); await ctx.reload();
      return p.id!;
    }
    dlg.onclick = async e => {
      const t = e.target as HTMLElement;
      const tab = t.closest<HTMLElement>('[data-tab]');
      if (tab) {
        dlg.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b === tab));
        dlg.querySelectorAll<HTMLElement>('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== tab.dataset.tab; });
        return;
      }
      const sw = t.closest<HTMLElement>('[data-color]');
      if (sw) {
        (form.elements.namedItem('color') as HTMLInputElement).value = sw.dataset.color!;
        dlg.querySelectorAll('.swatch').forEach(b => b.classList.toggle('on', b === sw));
        return;
      }
      if (t.closest('[data-close]')) { dlg.remove(); return; }
      const btn = t.closest<HTMLButtonElement>('[data-save],[data-saveconnect],[data-test]'); if (!btn) return;
      btn.disabled = true;
      try {
        const id = await save(); if (!id) return;
        if (btn.hasAttribute('data-save')) { dlg.remove(); return; }
        const url = `/api/hosts/${encodeURIComponent(id)}`;
        await ctx.api(`${url}/connect`, {});
        await ctx.reload();
        if (btn.hasAttribute('data-saveconnect')) { dlg.remove(); return; }
        const box = dlg.querySelector('[data-checks]') as HTMLElement;
        box.innerHTML = '<div class="hchk">Checking…</div>';
        const r = await fetch(`${url}/check`).catch(() => null);
        box.innerHTML = r?.ok ? checkList(await r.json() as Check[]) : '<div class="hchk bad">The check failed to run.</div>';
      } finally { btn.disabled = false; }
    };
  }

  document.getElementById('bHosts')!.onclick = openManager;
  render();
  return { render };
}

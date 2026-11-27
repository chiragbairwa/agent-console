import type { SendOpts } from '../src/sendtohost';
import { checkClass, checkMark } from '../src/hostcheck';

export interface Preview {
  ahead: number; dirtyFiles: number; dirtyLines: number; repoFound: boolean;
  checks: { id: string; ok: boolean; warn?: boolean; text: string }[];
  repo?: string; host?: string; roots?: string[]; agent?: string;
}

/** Checks that stop a send when they fail, with the check of the worker's own agent binary. Others (login, sleep, roots) only warn: the worker can still start. */
const BLOCKING = ['ssh', 'tmux', 'tunnel'];

/** The reasons the send cannot start. An empty list means the Send button is on. */
export function sendBlockers(p: Preview): string[] {
  const out: string[] = [];
  if (!p.repoFound) {
    const repo = p.repo ?? 'The repo', host = p.host ?? 'the host';
    out.push(p.roots && !p.roots.length ? `${repo} is not on ${host}: the host has no repo folders. Add one in the host profile (Edit).`
      : p.roots ? `${repo} is not on ${host} under ${p.roots.join(', ')}.` : `${repo} is not on ${host}.`);
  }
  for (const c of p.checks) {
    if (!c.ok && !c.warn && (BLOCKING.includes(c.id) || c.id === p.agent)) out.push(c.text);
  }
  return out;
}
export interface SendForm { to: string; branch: boolean; patch: boolean; briefOn: boolean; brief: string; folderOn: boolean; folder: string; stopSource: boolean }
type Body = Omit<SendOpts, 'id'>;

const n = (c: number, one: string, many = one + 's') => `${c} ${c === 1 ? one : many}`;

/** The summary lines of a send preview. */
export function previewLines(p: Preview): string[] {
  return [
    `${n(p.ahead, 'commit')} ahead`,
    p.dirtyFiles > 0 ? `${n(p.dirtyFiles, 'file')} · ${n(p.dirtyLines, 'line')} changed` : 'No uncommitted changes',
    p.repoFound ? 'Repo found' : 'Repo not found',
  ];
}

/** The POST body of a send. Brief and folder are trimmed and left out when off or empty. */
export function sendBody(f: SendForm): Body {
  const body: Body = { to: f.to, branch: f.branch, patch: f.patch, stopSource: f.stopSource };
  const brief = f.briefOn ? f.brief.trim() : '', folder = f.folderOn ? f.folder.trim() : '';
  if (brief) body.brief = brief;
  if (folder) body.folder = folder;
  return body;
}

// ---------- the dialog ----------
export interface SendCtx {
  workerId: string;
  workerName: string;
  hosts: { id: string; name: string; state: string; latencyMs?: number }[];
  hostColor: (id: string) => string;
  api: (path: string, body?: object) => Promise<Response>;
  esc: (s: unknown) => string;
}

const DIALOG = 'importDlg'; // shares the Import dialog's CSS, Escape key and click rules

/** Open the Send to Host dialog for one worker. */
export function openSendDialog(ctx: SendCtx): void {
  const { esc } = ctx;
  document.getElementById(DIALOG)?.remove();
  const f: SendForm = { to: '', branch: true, patch: false, briefOn: false, brief: '', folderOn: false, folder: '', stopSource: true };
  let preview: Preview | 'loading' | 'failed' | null = null;
  let running = false;
  let steps: { ok: boolean; text: string }[] | null = null;
  const hostName = () => ctx.hosts.find(h => h.id === f.to)?.name ?? f.to;

  const dlg = document.createElement('div'); dlg.id = DIALOG; dlg.className = 'sendDlg';
  document.getElementById('vp')!.appendChild(dlg);

  const checkRows = (p: Preview) => p.checks.map(c => `<div class="hchk ${checkClass(c)}">${checkMark(c)} ${esc(c.text)}</div>`).join('');

  function render() {
    if (!dlg.isConnected) return;
    dlg.dataset.busy = running ? '1' : ''; // app.ts ignores Escape while a send runs
    const p = preview && typeof preview === 'object' ? preview : null;
    const locked = running || !!steps;
    const hostCards = ctx.hosts.map(h => {
      const up = h.state === 'up';
      return `<button type="button" class="sd-host${h.id === f.to ? ' on' : ''}" data-host="${esc(h.id)}"${up && !locked ? '' : ' disabled'} style="--hc:${esc(ctx.hostColor(h.id))}">
        <b>${esc(h.name)}</b><br><span class="meta">${up ? `● online${h.latencyMs !== undefined ? ` · ${esc(h.latencyMs)} ms` : ''}` : esc(h.state === 'down' ? 'offline' : h.state)}</span></button>`;
    }).join('');
    const lines = p ? previewLines(p) : [];
    const blockers = p ? sendBlockers(p) : [];
    const sendOk = !!f.to && !!p && !blockers.length && !running && !steps;
    const why = !f.to ? 'Pick a host.' : !p ? '' : blockers.length ? `Cannot send: ${blockers.join(' ')}` : '';
    dlg.innerHTML = `<h2>Send ${esc(ctx.workerName)} to another host</h2>
      <section><h3 class="cap">Host</h3><div class="sd-hosts">${hostCards}</div></section>
      ${f.to ? `<section><h3 class="cap">What to send</h3>
        ${preview === 'loading' ? '<p class="empty">Checking…</p>' : preview === 'failed' ? '<p class="hchk bad">The preview failed to load.</p>' : ''}
        <label class="opt"><input type="checkbox" data-k="branch"${f.branch ? ' checked' : ''}${locked ? ' disabled' : ''}> <span><b>Branch</b> as a git bundle<br><span class="meta">${p ? esc(lines[0]) : ''}</span></span></label>
        <label class="opt"><input type="checkbox" data-k="patch"${f.patch ? ' checked' : ''}${locked ? ' disabled' : ''}> <span><b>Uncommitted changes</b> as a patch<br><span class="meta">${p ? esc(lines[1]) : ''}</span><br><span class="meta">Untracked files are not sent.</span></span></label>
        <label class="opt"><input type="checkbox" data-k="briefOn"${f.briefOn ? ' checked' : ''}${locked ? ' disabled' : ''}> <span><b>Handover brief</b><br><span class="meta">The first prompt of the new worker</span></span></label>
        ${f.briefOn ? `<textarea data-k="brief" rows="4" aria-label="Handover brief"${locked ? ' disabled' : ''}>${esc(f.brief)}</textarea>` : ''}
        <label class="opt"><input type="checkbox" data-k="folderOn"${f.folderOn ? ' checked' : ''}${locked ? ' disabled' : ''}> <span><b>Extra folder</b><br><span class="meta">Copied with rsync</span></span></label>
        ${f.folderOn ? `<input type="text" data-k="folder" placeholder="folder inside the worker folder" aria-label="Extra folder" value="${esc(f.folder)}"${locked ? ' disabled' : ''}>` : ''}
      </section>
      <section><h3 class="cap">After the copy</h3>
        <label class="row"><input type="radio" name="after" data-k="stop" value="1"${f.stopSource ? ' checked' : ''}${locked ? ' disabled' : ''}> Start a new worker on ${esc(hostName())} and stop this one</label>
        <label class="row"><input type="radio" name="after" data-k="stop" value="0"${f.stopSource ? '' : ' checked'}${locked ? ' disabled' : ''}> Start a new worker on ${esc(hostName())} and keep this one</label>
      </section>
      ${p ? `<section class="sd-checks"><h3 class="cap">Checks on ${esc(hostName())}</h3>
        <div class="hchk ${p.repoFound ? 'ok' : 'bad'}">${p.repoFound ? '✓' : '✗'} ${esc(lines[2])}</div>${checkRows(p)}</section>` : ''}` : ''}
      ${steps ? `<section><h3 class="cap">Result</h3>${steps.map(s => `<div class="hchk ${s.ok ? 'ok' : 'bad'}">${s.ok ? '✓' : '✗'} ${esc(s.text)}</div>`).join('')}</section>` : ''}
      ${why && !steps && !running ? `<p class="hchk bad sd-why" role="status">${esc(why)}</p>` : ''}
      <div class="imp-foot">${steps ? '<button class="tb" data-close>Close</button>'
        : `<button class="tb" data-close${running ? ' disabled' : ''}>Cancel</button><button class="send" data-go${sendOk ? '' : ` disabled title="${esc(why || 'Wait for the checks.')}"`}>${running ? 'Sending…' : `Send and Start on ${esc(hostName() || 'Host')}`}</button>`}</div>`;
  }

  async function pick(id: string) {
    f.to = id; preview = 'loading'; render();
    const r = await ctx.api(`/api/workers/${encodeURIComponent(ctx.workerId)}/send-preview?to=${encodeURIComponent(id)}`).catch(() => null);
    if (f.to !== id) return; // the user picked another host meanwhile
    preview = r?.ok ? await r.json() as Preview : 'failed';
    if (typeof preview === 'object') f.patch = preview.dirtyFiles > 0;
    render();
  }

  async function send() {
    running = true; render();
    let out: { name: string; ok: boolean; text: string }[];
    try {
      const r = await ctx.api(`/api/workers/${encodeURIComponent(ctx.workerId)}/send`, sendBody(f));
      const j = await r.json().catch(() => ({})) as { steps?: { name: string; ok: boolean; text: string }[]; error?: string };
      out = j.steps ?? [{ name: 'check', ok: false, text: j.error ?? `The send failed (${r.status}).` }];
    } catch (e) { out = [{ name: 'check', ok: false, text: e instanceof Error ? e.message : 'The send failed.' }]; }
    running = false;
    steps = out.map(s => ({ ok: s.ok, text: `${s.name}: ${s.text}` }));
    render();
  }

  dlg.onclick = e => {
    const t = e.target as HTMLElement;
    const host = t.closest<HTMLElement>('[data-host]');
    if (host && !host.hasAttribute('disabled')) { void pick(host.dataset.host!); return; }
    if (t.closest('[data-close]')) { if (!running) dlg.remove(); return; }
    if (t.closest('[data-go]') && !t.closest('[disabled]')) void send();
  };
  dlg.onchange = e => {
    const t = e.target as HTMLInputElement; const k = t.dataset.k as string | undefined; if (!k) return;
    if (k === 'stop') f.stopSource = t.value === '1';
    else if (k === 'branch' || k === 'patch' || k === 'briefOn' || k === 'folderOn') f[k] = t.checked;
    render();
  };
  dlg.oninput = e => {
    const t = e.target as HTMLInputElement; const k = t.dataset.k;
    if (k === 'brief' || k === 'folder') f[k] = t.value;
  };
  render();
}

import { ICON_SVG, MANIFEST } from './appwindow';
import { handleMcpHttp, type ToolReply } from './mcp';
import { existsSync } from 'node:fs';
import { ADAPTERS, validateAgent } from './agents';
import { listDirs } from './dirs';
import { listBranches } from './branches';
import { listRepos } from './repos';
import { lastMessages, transcriptPath } from './external';
import { timingSafeEqual } from 'node:crypto';
import type { Server, ServerWebSocket } from 'bun';
import page from '../web/index.html';
import { handleHook } from './hookserver';
import { handleTool as defaultHandleTool } from './tools';
import { PtyHub } from './pty';
import { resolveName } from './slug';
import { HostPool, TmuxPool } from './hostpool';
import { sendPreview, sendToHost } from './sendtohost';
import { listRemoteBranches, listRemoteDirs, listRemoteRepos } from './remotefs';
import type { HostLink } from './ssh';
import { isLocal, parseSshConfig, validateHost } from './hosts';
import { checkHost } from './hostcheck';
import { saveHosts } from './store';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Tmux } from './tmux';
import type { Config, Host, StateEvent } from './types';
import { sessionName, type Registry } from './workers';

type WsData = { kind: 'state' } | { kind: 'term'; id: string };
type ToolHandler = (reg: Registry, tmux: Tmux, body: any) => Promise<unknown>;

export interface ServerOpts {
  reg: Registry; cfg: Config; token: string; port: number; tmux: Tmux;
  /** Tmux for each host. Default: the local tmux only. */
  pool?: TmuxPool; hosts?: HostPool;
  handleTool?: ToolHandler; hostname?: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const forbidden = () => new Response('Forbidden', { status: 403 });

function sameToken(a: string | null | undefined, b: string) {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookieToken(req: Request) {
  const m = (req.headers.get('cookie') ?? '').match(/(?:^|;\s*)ac_token=([0-9a-f]+)/);
  return m?.[1];
}

export function startServer(o: ServerOpts): Server<WsData> {
  const { reg, cfg, token, tmux } = o;
  const hosts = o.hosts ?? new HostPool([], { consolePort: o.port, sockDir: '' });
  const pool = o.pool ?? new TmuxPool(tmux, hosts);
  const hub = new PtyHub(id => pool.of(reg.get(id)?.host).attachArgs(sessionName(id)), id => pool.of(reg.get(id)?.host));
  const toolHandler: ToolHandler = o.handleTool ?? (defaultHandleTool as ToolHandler);
  let port = o.port;

  const hostOk = (req: Request) => {
    const host = req.headers.get('host') ?? '';
    const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    // A remote console reaches this server through its reverse tunnel, on the tunnel port.
    for (const l of hosts.all()) if (l.tunnelPort() !== port) okHosts.push(`127.0.0.1:${l.tunnelPort()}`);
    if (!okHosts.includes(host)) return false;
    const origin = req.headers.get('origin');
    return !origin || okHosts.some(h => origin === `http://${h}`);
  };
  const authed = (req: Request, url: URL) =>
    hostOk(req) && (sameToken(req.headers.get('x-ac-token'), token)
      || sameToken(url.searchParams.get('token'), token) || sameToken(cookieToken(req), token));

  /** The link for ?host=<id>. Undefined for this machine. A Response for an unknown or a down host. */
  function remoteOf(url: URL): HostLink | Response | undefined {
    const id = url.searchParams.get('host');
    return isLocal(id ?? undefined) ? undefined : upLink(id!);
  }
  /** The link of a remote host when it is up. A Response for an unknown or a down host. */
  function upLink(id: string): HostLink | Response {
    let link: HostLink;
    try { link = hosts.link(id); } catch { return json({ error: 'unknown host' }, 404); }
    return link.state === 'up' ? link : json({ error: `${link.host.name} is not connected` }, 409);
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) as any : {};
    const route = `${req.method} /${parts.slice(0, 2).join('/')}`;
    switch (route) {
      case 'GET /api/health': return json({ ok: true });
      case 'GET /api/state': return json(reg.snapshot());
      case 'GET /api/dirs': {
        const rl = remoteOf(url);
        if (rl instanceof Response) return rl;
        if (rl) return json(await listRemoteDirs(rl, url.searchParams.get('path') ?? undefined, { hidden: url.searchParams.get('hidden') === '1' }));
        return json(listDirs(url.searchParams.get('path') ?? undefined, { hidden: url.searchParams.get('hidden') === '1', roots: cfg.roots }));
      }
      case 'GET /api/branches': {
        const rl = remoteOf(url);
        if (rl instanceof Response) return rl;
        const repo = url.searchParams.get('path') ?? '';
        if (rl && !repo) return json({ error: 'no such folder' }, 404);
        if (rl) return json(await listRemoteBranches(rl, repo));
        if (!repo || !existsSync(repo)) return json({ error: 'no such folder' }, 404);
        return json(await listBranches(repo));
      }
      case 'GET /api/agents': return json(Object.values(ADAPTERS).map(a => ({ id: a.id, label: a.label, icon: a.icon, color: a.color, caps: a.caps, options: a.options })));
      case 'GET /api/repos': {
        const rl = remoteOf(url);
        if (rl instanceof Response) return rl;
        const templates = cfg.templates.map(t => t.name);
        if (rl) return json({ repos: await listRemoteRepos(rl, rl.host.roots), templates });
        return json({ repos: listRepos(cfg.roots), templates });
      }
      case 'GET /api/hosts': {
        if (parts[2] === 'import') {
          let text = '';
          try { text = readFileSync(join(process.env.HOME || homedir(), '.ssh', 'config'), 'utf8'); } catch { /* no file: nothing to import */ }
          return json(parseSshConfig(text));
        }
        if (parts[3] === 'check') {
          let link: HostLink;
          try { link = hosts.link(parts[2] ?? ''); } catch { return json({ error: 'unknown host' }, 404); }
          return json(await checkHost(link, port));
        }
        if (parts.length > 2) return json({ error: 'not found' }, 404);
        return json({ hosts: hosts.all().map(l => ({
          ...l.host, state: l.state, latencyMs: l.latencyMs, lastError: l.lastError,
          workers: reg.workers().filter(w => w.host === l.host.id).length,
        })) });
      }
      case 'POST /api/hosts': {
        if (parts.length === 2) {
          const list = (body as { hosts?: unknown }).hosts;
          if (!Array.isArray(list)) return json({ error: 'hosts must be an array' }, 400);
          const out: Host[] = [];
          try {
            for (const h of list) {
              const v = validateHost(h);
              if (out.some(x => x.id === v.id)) throw new Error(`duplicate host id ${v.id}`);
              out.push(v);
            }
          } catch (e) { return json({ error: (e as Error).message }, 400); }
          saveHosts(out);
          cfg.hosts = out;
          // A replaced link that was up connects again in the background.
          void hosts.set(out);
          return json({ ok: true });
        }
        let link: HostLink;
        try { link = hosts.link(parts[2]!); } catch { return json({ error: 'unknown host' }, 404); }
        if (parts[3] === 'shell') {
          try { return json(await reg.openShell(parts[2]!)); } catch (e) { return json({ error: (e as Error).message }, 409); }
        }
        if (parts[3] === 'connect') await link.connect();
        else if (parts[3] === 'disconnect') await link.disconnect();
        else return json({ error: 'unknown action' }, 404);
        return json({ ok: true, state: link.state, lastError: link.lastError });
      }
      case 'POST /api/hook': return json(await handleHook(reg, cfg, body));
      case 'POST /api/tool': return json(await toolHandler(reg, tmux, body));
      case 'POST /api/send': {
        const targets = (body.targets ?? []).map((t: string) => resolveName(t, reg.workers()));
        if (!targets.length || targets.some((t: unknown) => !t)) return json({ error: 'unknown target' }, 404);
        const linked = targets.find((t: { kind?: string }) => t.kind === 'linked');
        if (linked) return json({ error: `${linked.name} is linked: type in its own tab, or Move into Console` }, 409);
        const text = String(body.text ?? '');
        const results: Record<string, string> = {};
        for (const w of targets) results[w.id] = await reg.deliver('you', w.id, text);
        reg.activity(`You → ${targets.map((w: { name: string }) => w.name).join(', ')}: ${text.slice(0, 80)}`);
        return json({ results });
      }
      case 'POST /api/links': {
        if (!reg.get(body.a) || !reg.get(body.b)) return json({ error: 'unknown worker' }, 404);
        if (body.op === 'cut') reg.cut(body.a, body.b);
        else if (!reg.connect(body.a, body.b, 'you') && (reg.get(body.a)?.role === 'reviewer' || reg.get(body.b)?.role === 'reviewer'))
          return json({ error: 'the reviewer links only to the advisor' }, 409);
        return json({ ok: true });
      }
      case 'POST /api/needs': {
        const ok = reg.resolveNeed(parts[2] ?? '', body.decision, body.text);
        return json({ ok }, ok ? 200 : 404);
      }
      case 'POST /api/advisor': {
        if (!reg.get('advisor')) return json({ error: 'no advisor' }, 404);
        if (typeof body.agent !== 'string') return json({ error: 'agent must be a string' }, 400);
        try { return json(await reg.swapAdvisor(body.agent)); } catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      case 'POST /api/reviewer': {
        const action = parts[2];
        if (action === undefined) {
          if (!reg.get('advisor')) return json({ error: 'no advisor' }, 404);
          if (typeof body.agent !== 'string') return json({ error: 'agent must be a string' }, 400);
          try { return json(await reg.addReviewer(body.agent)); } catch (e) { return json({ error: (e as Error).message }, 400); }
        }
        if (action !== 'remove' && action !== 'swap-roles') return json({ error: 'not found' }, 404);
        if (!reg.reviewer()) return json({ error: 'no reviewer' }, 404);
        try {
          if (action === 'remove') { await reg.removeReviewer(); return json({ ok: true }); }
          return json(await reg.swapRoles());
        } catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      case 'GET /api/external': return json({ sessions: reg.externalSessions() });
      case 'POST /api/external': {
        const ext = reg.externalSessions().find(e => e.pid === Number(parts[2]));
        if (!ext) return json({ error: 'no such running session' }, 404);
        try {
          return json(body.mode === 'adopt' ? await reg.adopt(ext) : reg.link(ext));
        } catch (e) { return json({ error: (e as Error).message }, 409); }
      }
      case 'GET /api/workers': {
        const w = reg.get(parts[2] ?? '');
        if (w && parts[3] === 'send-preview') {
          const to = url.searchParams.get('to') ?? '';
          try { hosts.link(to); } catch { return json({ error: 'unknown host' }, 404); }
          try { return json(await sendPreview(reg, hosts, w.id, to)); } catch (e) { return json({ error: (e as Error).message }, 500); }
        }
        if (!w || parts[3] !== 'transcript') return json({ error: 'not found' }, 404);
        const messages = w.sessionId ? lastMessages(transcriptPath(w.cwd, w.sessionId), 20) : [];
        return json({ messages });
      }
      case 'POST /api/workers': {
        if (parts.length === 2) {
          // A remote repo path lives on the host. Only a local path can be checked here.
          const remote = !isLocal(body.host);
          if (!body.name || !body.repo || (!remote && !existsSync(body.repo))) return json({ error: 'name and an existing repo path are needed' }, 400);
          if (remote) {
            if (typeof body.repo !== 'string') return json({ error: 'name and an existing repo path are needed' }, 400);
            const rl = upLink(String(body.host));
            if (rl instanceof Response) return rl;
          }
          if (body.prompt !== undefined && typeof body.prompt !== 'string') return json({ error: 'prompt must be a string' }, 400);
          if (body.worktree && (typeof body.worktree.branch !== 'string' || (body.worktree.base !== undefined && typeof body.worktree.base !== 'string')))
            return json({ error: 'worktree needs a branch name' }, 400);
          if (body.agent !== undefined && typeof body.agent !== 'string') return json({ error: 'agent must be a string' }, 400);
          let v: ReturnType<typeof validateAgent>;
          try { v = validateAgent(body.agent ?? cfg.defaultWorkerAgent, body.options); }
          catch (e) { return json({ error: (e as Error).message }, 400); }
          // Workers only. A seat comes from ensureAdvisor or addReviewer, never from this route.
          try { return json(await reg.spawn({
            // An allow-list: fields such as beforeStart never come from a client.
            name: body.name, repo: body.repo, role: 'worker', worktree: body.worktree, template: body.template,
            resume: body.resume, agent: v.agent, options: v.options, host: body.host, prompt: body.prompt,
          })); } catch (e) { return json({ error: (e as Error).message }, 500); }
        }
        const id = parts[2]!; const action = parts[3];
        const w = reg.get(id);
        if (!w) return json({ error: 'unknown worker' }, 404);
        switch (action) {
          case 'move': reg.move(id, Number(body.x) || 0, Number(body.y) || 0); break;
          case 'resize': {
            if (body.reset === true) { reg.resize(id); break; }
            if (!Number.isFinite(body.w) || !Number.isFinite(body.h)) return json({ error: 'w and h must be numbers' }, 400);
            reg.resize(id, body.w, body.h); break;
          }
          case 'interrupt': await reg.interrupt(id); break;
          case 'stop': try { await reg.stop(id); } catch (e) { return json({ error: (e as Error).message }, 409); } break;
          case 'restart': try { await reg.restart(id, body.resume !== false); } catch (e) { return json({ error: (e as Error).message }, 409); } break;
          case 'remove':
            if (w.kind === 'linked') reg.unlink(id);
            else { try { await reg.remove(id); } catch (e) { return json({ error: (e as Error).message }, 409); } }
            break;
          case 'send': {
            if (typeof body.to !== 'string' || !body.to) return json({ error: 'to must be a host id' }, 400);
            if (body.brief !== undefined && typeof body.brief !== 'string') return json({ error: 'brief must be a string' }, 400);
            if (body.folder !== undefined && typeof body.folder !== 'string') return json({ error: 'folder must be a string' }, 400);
            try { hosts.link(body.to); } catch { return json({ error: 'unknown host' }, 404); }
            const r = await sendToHost(reg, hosts, {
              id, to: body.to, branch: body.branch !== false, patch: body.patch === true,
              brief: body.brief || undefined, folder: body.folder || undefined, stopSource: body.stopSource === true,
            });
            return json(r);
          }
          case 'open-editor': Bun.spawn(['code', w.cwd], { stdout: 'ignore', stderr: 'ignore' }); break;
          default: return json({ error: 'unknown action' }, 404);
        }
        return json({ ok: true });
      }
      default: return json({ error: 'not found' }, 404);
    }
  }

  const server = Bun.serve<WsData>({
    hostname: o.hostname ?? '127.0.0.1',
    port: o.port,
    routes: { '/app': page },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/') {
        if (!hostOk(req) || !sameToken(url.searchParams.get('token'), token)) return forbidden();
        return new Response(null, {
          status: 302,
          headers: { location: '/app', 'set-cookie': `ac_token=${token}; HttpOnly; SameSite=Strict; Path=/` },
        });
      }
      // Public: the window name and icon. Chrome fetches the manifest without cookies.
      if (url.pathname === '/manifest.webmanifest' && hostOk(req)) return Response.json(MANIFEST, { headers: { 'content-type': 'application/manifest+json' } });
      if (url.pathname === '/icon.svg' && hostOk(req)) return new Response(ICON_SVG, { headers: { 'content-type': 'image/svg+xml' } });
      if (!authed(req, url)) return forbidden();
      if (url.pathname === '/ws/state') return srv.upgrade(req, { data: { kind: 'state' } }) ? undefined : forbidden();
      const term = url.pathname.match(/^\/ws\/term\/([a-z0-9-]+)$/);
      if (term) {
        if (!reg.get(term[1]!)) return json({ error: 'unknown worker' }, 404);
        return srv.upgrade(req, { data: { kind: 'term', id: term[1]! } }) ? undefined : forbidden();
      }
      if (url.pathname.startsWith('/api/')) return api(req, url);
      const hook = url.pathname.match(/^\/hook\/([A-Za-z]+)$/);
      if (hook && req.method === 'POST') {
        if (hook[1] === 'PreToolUse') srv.timeout(req, 0); // a guarded command waits for Allow or Deny
        const payload = await req.json().catch(() => ({}));
        const r = await handleHook(reg, cfg, { event: hook[1]!, id: req.headers.get('x-ac-id') ?? '', payload });
        return json(r.output ?? {});
      }
      if (url.pathname === '/mcp') {
        srv.timeout(req, 0); // ask_user may wait up to 30 minutes for the user
        const id = req.headers.get('x-ac-id') ?? '';
        const role = reg.get(id)?.role;
        return handleMcpHttp(req, role, (tool, args) => toolHandler(reg, tmux, { caller: id, tool, args }) as Promise<ToolReply>);
      }
      return json({ error: 'not found' }, 404);
    },
    websocket: {
      async open(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === 'state') { ws.send(JSON.stringify(reg.snapshot())); ws.subscribe('state'); return; }
        await hub.subscribe(ws.data.id, ws);
      },
      message(ws: ServerWebSocket<WsData>, msg) {
        if (ws.data.kind !== 'term') return;
        const id = ws.data.id;
        if (typeof msg === 'string' && msg.startsWith('{"resize"')) {
          try { const [c, r] = JSON.parse(msg).resize; hub.resize(id, c, r); } catch { /* ignore */ }
          return;
        }
        // Only real keystrokes (reported by the page) hold back queued messages;
        // automatic terminal replies also arrive as input bytes and must not.
        if (msg === '{"typing":1}') { reg.noteUserInput(id); return; }
        hub.input(id, msg);
      },
      close(ws: ServerWebSocket<WsData>) { if (ws.data.kind === 'term') hub.unsubscribe(ws); },
    },
  });
  port = server.port ?? o.port;
  reg.addEventListener('event', e => server.publish('state', JSON.stringify((e as CustomEvent<StateEvent>).detail)));
  hosts.addEventListener('state', e => {
    const id = (e as CustomEvent<{ id: string }>).detail.id;
    let l: HostLink;
    try { l = hosts.link(id); } catch { return; }
    const ev: StateEvent = { t: 'host', id, state: l.state, ...(l.latencyMs !== undefined ? { latencyMs: l.latencyMs } : {}), ...(l.lastError ? { lastError: l.lastError } : {}) };
    server.publish('state', JSON.stringify(ev));
  });
  const stop = server.stop.bind(server);
  server.stop = ((force?: boolean) => { hub.closeAll(); return stop(force); }) as typeof server.stop;
  return server;
}

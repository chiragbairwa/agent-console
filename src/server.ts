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
import type { Tmux } from './tmux';
import type { Config, StateEvent } from './types';
import type { Registry } from './workers';

type WsData = { kind: 'state' } | { kind: 'term'; id: string };
type ToolHandler = (reg: Registry, tmux: Tmux, body: any) => Promise<unknown>;

export interface ServerOpts {
  reg: Registry; cfg: Config; token: string; port: number; tmux: Tmux;
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
  const hub = new PtyHub(tmux);
  const toolHandler: ToolHandler = o.handleTool ?? (defaultHandleTool as ToolHandler);
  let port = o.port;

  const hostOk = (req: Request) => {
    const host = req.headers.get('host') ?? '';
    const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!okHosts.includes(host)) return false;
    const origin = req.headers.get('origin');
    return !origin || okHosts.some(h => origin === `http://${h}`);
  };
  const authed = (req: Request, url: URL) =>
    hostOk(req) && (sameToken(req.headers.get('x-ac-token'), token)
      || sameToken(url.searchParams.get('token'), token) || sameToken(cookieToken(req), token));

  async function api(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) as any : {};
    const route = `${req.method} /${parts.slice(0, 2).join('/')}`;
    switch (route) {
      case 'GET /api/health': return json({ ok: true });
      case 'GET /api/state': return json(reg.snapshot());
      case 'GET /api/dirs': return json(listDirs(url.searchParams.get('path') ?? undefined, { hidden: url.searchParams.get('hidden') === '1', roots: cfg.roots }));
      case 'GET /api/branches': {
        const repo = url.searchParams.get('path') ?? '';
        if (!repo || !existsSync(repo)) return json({ error: 'no such folder' }, 404);
        return json(await listBranches(repo));
      }
      case 'GET /api/agents': return json(Object.values(ADAPTERS).map(a => ({ id: a.id, label: a.label, icon: a.icon, color: a.color, caps: a.caps, options: a.options })));
      case 'GET /api/repos': return json({ repos: listRepos(cfg.roots), templates: cfg.templates.map(t => t.name) });
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
        if (body.op === 'cut') reg.cut(body.a, body.b); else reg.connect(body.a, body.b, 'you');
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
        if (!w || parts[3] !== 'transcript') return json({ error: 'not found' }, 404);
        const messages = w.sessionId ? lastMessages(transcriptPath(w.cwd, w.sessionId), 20) : [];
        return json({ messages });
      }
      case 'POST /api/workers': {
        if (parts.length === 2) {
          if (!body.name || !body.repo || !existsSync(body.repo)) return json({ error: 'name and an existing repo path are needed' }, 400);
          if (body.worktree && (typeof body.worktree.branch !== 'string' || (body.worktree.base !== undefined && typeof body.worktree.base !== 'string')))
            return json({ error: 'worktree needs a branch name' }, 400);
          if (body.agent !== undefined && typeof body.agent !== 'string') return json({ error: 'agent must be a string' }, 400);
          let v: ReturnType<typeof validateAgent>;
          try { v = validateAgent(body.agent ?? cfg.defaultWorkerAgent, body.options); }
          catch (e) { return json({ error: (e as Error).message }, 400); }
          try { return json(await reg.spawn({ ...body, agent: v.agent, options: v.options })); } catch (e) { return json({ error: (e as Error).message }, 500); }
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
          case 'stop': await reg.stop(id); break;
          case 'restart': await reg.restart(id, body.resume !== false); break;
          case 'remove': if (w.kind === 'linked') reg.unlink(id); else await reg.remove(id); break;
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
        return handleMcpHttp(req, reg.get(id)?.role, (tool, args) => toolHandler(reg, tmux, { caller: id, tool, args }) as Promise<ToolReply>);
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
  const stop = server.stop.bind(server);
  server.stop = ((force?: boolean) => { hub.closeAll(); return stop(force); }) as typeof server.stop;
  return server;
}

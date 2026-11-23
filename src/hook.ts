import { isGuarded } from './guard';
import { loadConfig } from './store';

const QUICK_MS = 2000;

/** The user's extra guard patterns, so the client treats them like the server does (review C1). */
function configGuards(): string[] {
  try { return loadConfig().guardPatterns; } catch { return []; }
}

const ask = (reason: string) => JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
});

/** Client side of a Claude Code hook. Never blocks Claude when the server is gone. */
export async function runHook(
  event: string, stdin: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!env.AC_URL) return '';
  let payload: any = {};
  try { payload = JSON.parse(stdin); } catch { /* empty payload */ }
  const guarded = event === 'PreToolUse' && payload?.tool_name === 'Bash'
    && isGuarded(String(payload?.tool_input?.command ?? ''), configGuards());
  try {
    const res = await fetchImpl(`${env.AC_URL}/api/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ac-token': env.AC_TOKEN ?? '' },
      body: JSON.stringify({ event, id: env.AC_ID ?? '', payload }),
      // A guarded call may wait for the user; anything else must be quick.
      signal: guarded ? undefined : AbortSignal.timeout(QUICK_MS),
    });
    if (!res.ok) return guarded ? ask(`Agent Console answered ${res.status}`) : '';
    const body = await res.json().catch(() => ({})) as { output?: object };
    return body.output ? JSON.stringify(body.output) : '';
  } catch {
    return guarded ? ask('Agent Console is not running') : '';
  }
}

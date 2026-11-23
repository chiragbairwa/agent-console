/** Light guard: a regex on the Bash command text only (spec §8, user choice 2026-11-19). */
export const DEFAULT_GUARDS = [
  String.raw`\bgit\s+push\b`,
  String.raw`\baz\s+pipelines\b.*\brun\b`,
  String.raw`\bterraform\s+apply\b`,
  String.raw`\baz\s+pipelines\s+runs?\s+.*approv`,
];

export function isGuarded(command: string, extra: string[]): boolean {
  for (const p of [...DEFAULT_GUARDS, ...extra]) {
    let re: RegExp;
    try { re = new RegExp(p); } catch { continue; }
    if (re.test(command)) return true;
  }
  return false;
}

/** A file that is dropped on a terminal gives its path, as in a real terminal. The file content is never read or uploaded. */

export interface DropData {
  /** The `text/uri-list` value. */
  uriList?: string;
  /** The `text/plain` value. */
  text?: string;
  /** The dropped files. Some webviews add a `path` property. */
  files?: { name: string; path?: string }[];
}

function fileUriPath(u: string): string | null {
  if (!u.startsWith('file://')) return null;
  try { return decodeURIComponent(new URL(u).pathname) || null; } catch { return null; }
}

/** A control character (ESC, CR, LF and others) in a pasted path could end the bracketed paste and run text. */
const CONTROL = /[\x00-\x1f\x7f]/;

/** The local paths of a drop. The order: text/uri-list, then File objects with a path, then a text/plain path. */
export function pathsFromDrop(data: DropData): string[] {
  return rawPaths(data).filter(p => !CONTROL.test(p));
}

function rawPaths(data: DropData): string[] {
  const fromUris = (data.uriList ?? '').split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !l.startsWith('#')).map(fileUriPath).filter((p): p is string => !!p);
  if (fromUris.length) return fromUris;
  const fromFiles = (data.files ?? []).map(f => f.path).filter((p): p is string => typeof p === 'string' && p.startsWith('/'));
  if (fromFiles.length) return fromFiles;
  // Each line must be a path. A newline in the paste would run the line in a shell.
  const lines = (data.text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const fromText = lines.map(l => l.startsWith('/') ? l : fileUriPath(l));
  return fromText.length && fromText.every(Boolean) ? fromText as string[] : [];
}

/** A path that the shell reads as one word. A plain path stays as it is. Else it gets single quotes. */
export function quoteForShell(p: string): string {
  if (/^[A-Za-z0-9_\/.~@%+=:,-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** The text to paste for the dropped paths. The space at the end lets the user type on. */
export const pasteText = (paths: string[]): string => paths.map(quoteForShell).join(' ') + ' ';

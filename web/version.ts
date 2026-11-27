/** The header label of the app version. The page and the server can differ when the window still shows an old page. */
export function versionLabel(page: string, server: string | undefined): { text: string; stale: boolean; title: string } {
  if (!server || server === page) return { text: `v${page}`, stale: false, title: `Agent Console v${page}` };
  return { text: `v${page} · reload for v${server}`, stale: true, title: `This page is v${page}. The server is v${server}. Click to reload.` };
}

/**
 * Open a source in the user's browser.
 *
 * Inside the desktop app a plain `<a href>` would navigate the WEBVIEW — the
 * app would replace itself with the page it cited, with no way back. The
 * opener plugin hands the URL to the OS instead; outside Tauri the dynamic
 * import fails and `window.open` is the correct behaviour anyway.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

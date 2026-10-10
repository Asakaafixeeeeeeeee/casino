/**
 * Keeps the free-plan services awake.
 *
 * On Render's free plan a web service sleeps after ~15 minutes with no inbound traffic, then takes 15–50 seconds to
 * wake on the next request — which players feel as a slow first load, login or deposit. While this service is running
 * it pings its own public URL (and the accounts service) every 10 minutes; each ping is inbound traffic that resets
 * Render's idle timer, so neither service sleeps. The 20-second balance poll from anyone actually on the site keeps
 * things warm during use; this covers the quiet gaps between visitors.
 *
 * A paid plan removes cold starts entirely and is the proper fix; this is the free mitigation. It does nothing
 * locally (RENDER_EXTERNAL_URL is only set on Render).
 */
export function startKeepWarm(): void {
  const self = process.env.RENDER_EXTERNAL_URL;
  if (!self) return;
  const trim = (u: string) => u.replace(/\/$/, "");
  const targets = [trim(self) + "/_health"];
  if (process.env.ACCOUNTS_API_URL) targets.push(trim(process.env.ACCOUNTS_API_URL) + "/health");
  const ping = async () => {
    for (const url of targets) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(20000) });
      } catch (e) {
        console.error("[keep-warm] %s: %s", url, (e as Error).message);
      }
    }
  };
  setInterval(ping, 10 * 60 * 1000).unref();
  void ping();
}

/* WIN B Casino service worker: shows support-reply push notifications and opens the chat when one is tapped. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* plain text */ }
  const title = data.title || "WIN B Casino 🔔";
  const options = {
    body: data.body || "You have received a new message from WIN B Support. Tap to view your conversation.",
    icon: "/assets/img/winb-mark.svg",
    badge: "/assets/img/winb-mark.svg",
    tag: data.tag || "support-reply",
    renotify: true,
    data: { url: data.url || "/support.html?chat=1" },
  };
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = wins.filter((c) => c.visibilityState === "visible");
    if (visible.length) {
      /* they're on the site: the page shows its own in-site notification */
      visible.forEach((c) => c.postMessage({ type: "support-reply" }));
      return;
    }
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/support.html?chat=1";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      if ("focus" in c) {
        await c.focus();
        if ("navigate" in c) await c.navigate(url).catch(() => undefined);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

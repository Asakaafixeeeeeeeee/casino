/* Every page at phone, tablet and desktop widths: nothing wider than the screen, and no uncaught errors. */
import { expect, test } from "@playwright/test";
import { settle } from "./helpers";

const VIEWPORTS = [
  { name: "phone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1366, height: 860 },
];
const PAGES = [
  "index.html", "games.html", "promotions.html", "support.html", "register.html", "terms.html", "privacy.html",
  "game.html?id=hi-lo", "wallet.html", "withdraw.html", "transactions.html", "me.html", "partners.html", "regional.html",
  "bottle.html", "coin.html", "crash.html", "crossing.html", "evenodd.html", "fruits.html", "goal.html", "hilo.html",
  "knockout.html", "magicball.html", "mines.html", "olympus.html", "redblack.html", "roulette.html", "wings.html", "aviator.html",
];

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} ${vp.width}×${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    for (const path of PAGES) {
      test(path, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/" + path);
        await settle(page);
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(() => {
          const width = document.documentElement.clientWidth;
          const wide = [...document.querySelectorAll("body *")]
            .filter((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.right > width + 1 && s.position !== "fixed" && !el.closest("[style*='overflow'], .cat-scroll, .strip, .chips, .mg-chips, .fr-quick, .hist, .cards, .rail, .row-scroll"); })
            .slice(0, 3).map((el) => (el.id ? "#" + el.id : el.className ? "." + String(el.className).split(" ")[0] : el.tagName.toLowerCase()) + " → " + Math.round(el.getBoundingClientRect().right) + "px");
          return { scroll: document.documentElement.scrollWidth - width, wide };
        });
        expect(overflow.scroll, `page scrolls sideways by ${overflow.scroll}px: ${overflow.wide.join(", ")}`).toBeLessThanOrEqual(1);
        expect(errors, "no uncaught errors").toEqual([]);
      });
    }
  });
}

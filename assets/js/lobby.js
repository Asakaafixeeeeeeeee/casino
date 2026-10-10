/* Lobby: category tabs, search, volatility filter, sorting, URL state */
(function () {
  "use strict";
  const { games, categories } = window.VB;
  const U = window.VBUtil;

  /* only volatilities some game has; with fewer than two there's nothing to filter, so that filter is hidden */
  const VOLATILITY = ["Low", "Medium", "High"].filter((v) => games.some((g) => g.volatility === v));
  const TAGS = ["hot", "new"];

  const results = document.getElementById("results");
  const countEl = document.getElementById("count");
  const titleEl = document.getElementById("lobbyTitle");
  const searchEl = document.getElementById("search");
  const sortEl = document.getElementById("sort");
  const filtersBtn = document.getElementById("filtersBtn");
  const filterPanel = document.getElementById("filters");
  const filterCount = document.getElementById("filterCount");
  const SORTS = Array.from(sortEl.options, (o) => o.value);

  /* the "tab" (category, tag or My Games) plus the secondary filters inside the panel */
  const state = { category: null, tag: null, favOnly: false, volatility: null, q: "", sort: "popular" };

  /* values are matched case-insensitively; unknown ones are dropped rather than emptying the lobby */
  const known = (list, v) => list.find((x) => x.toLowerCase() === String(v || "").toLowerCase()) || null;

  function readTab(params) {
    /* crash games are listed under Live Casino; old ?category=Crash links still land there */
    state.category = known(categories, String(params.get("category") || "").replace(/^crash$/i, "Live Casino"));
    state.tag = known(TAGS, params.get("tag"));
    state.favOnly = params.get("fav") === "1";
  }

  /* seed state from the query string, e.g. games.html?category=Slots&volatility=High */
  const params = new URLSearchParams(location.search);
  readTab(params);
  state.volatility = known(VOLATILITY, params.get("volatility"));
  state.q = (params.get("q") || "").trim();
  state.sort = known(SORTS, params.get("sort")) || "popular";

  /* category tabs switch in place instead of reloading the page */
  document.querySelector(".cat-bar").addEventListener("click", (e) => {
    const link = e.target.closest("a.cat-tab");
    if (!link) return;
    const url = new URL(link.href);
    if (url.pathname !== location.pathname) return;
    e.preventDefault();
    readTab(url.searchParams);
    render();
  });

  /* ---- filter chips ---- */
  function buildChips(host, values, key) {
    [{ value: "", label: "All" }].concat(values).forEach((v) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.dataset.value = v.value;
      b.textContent = v.label;
      host.appendChild(b);
    });
    host.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      state[key] = chip.dataset.value || null;
      render();
    });
  }
  buildChips(document.getElementById("fVolatility"), VOLATILITY.map((v) => ({ value: v, label: v })), "volatility");
  document.getElementById("fVolatility").parentElement.hidden = VOLATILITY.length < 2;

  function syncChips() {
    [["fVolatility", "volatility"]].forEach(([hostId, key]) => {
      const current = state[key] || "";
      document.getElementById(hostId).querySelectorAll(".chip").forEach((c) => {
        const on = c.dataset.value === current;
        c.classList.toggle("on", on);
        c.setAttribute("aria-pressed", String(on));
      });
    });
    const active = state.volatility ? 1 : 0;
    filterCount.hidden = !active;
    filterCount.textContent = active;
  }

  const setPanel = (open) => {
    filterPanel.hidden = !open;
    filtersBtn.setAttribute("aria-expanded", String(open));
  };
  filtersBtn.addEventListener("click", () => setPanel(filterPanel.hidden));
  setPanel(!!state.volatility); /* open when a link arrives with filters set */

  /* ---- search + sort ---- */
  searchEl.value = state.q;
  searchEl.addEventListener("input", () => {
    state.q = searchEl.value.trim();
    render();
  });
  sortEl.value = state.sort;
  sortEl.addEventListener("change", () => {
    state.sort = sortEl.value;
    render();
  });

  /* clears the secondary filters; the selected tab stays */
  function resetFilters() {
    state.volatility = null;
    state.q = "";
    state.sort = "popular";
    searchEl.value = "";
    sortEl.value = "popular";
    render();
  }
  document.getElementById("reset").addEventListener("click", resetFilters);

  /* un-hearting a game while viewing My Games should drop it from the list */
  document.addEventListener("vb:favourites", () => {
    if (state.favOnly) render();
  });

  /* ---- filtering pipeline ---- */
  function filtered() {
    let list = games.slice();

    if (state.q) {
      const q = state.q.toLowerCase();
      list = list.filter(
        (g) => g.name.toLowerCase().includes(q) || g.category.toLowerCase().includes(q)
      );
    }
    if (state.category) list = list.filter((g) => g.category === state.category);
    if (state.tag) list = list.filter((g) => g.tags.includes(state.tag.toUpperCase()));
    if (state.favOnly) list = list.filter((g) => U.favs.has(g.id));
    if (state.volatility) list = list.filter((g) => g.volatility === state.volatility);

    const byRtp = (dir) => (a, b) => (a.rtp - b.rtp) * dir;
    const byName = (dir) => (a, b) => a.name.localeCompare(b.name) * dir;
    switch (state.sort) {
      case "players": list.sort((a, b) => b.players - a.players); break;
      case "az": list.sort(byName(1)); break;
      case "za": list.sort(byName(-1)); break;
      case "rtp-desc": list.sort(byRtp(-1)); break;
      case "rtp-asc": list.sort(byRtp(1)); break;
      default: list.sort((a, b) => b.tags.length - a.tags.length || b.rtp - a.rtp);
    }
    return list;
  }

  /* heading for the current tab: [label, icon, tone] */
  function heading() {
    if (state.favOnly) return ["My Games", "heart", "tone-red"];
    if (state.tag === "hot") return ["Hot", "flame", "tone-orange"];
    if (state.tag === "new") return ["New", "sparkle", "tone-yellow"];
    if (state.category) return [state.category, U.categoryIcon(state.category), "tone-yellow"];
    return ["All games", "grid", "tone-yellow"];
  }

  /* ---- render ---- */
  function render() {
    const list = filtered();
    const [label, icon, tone] = heading();
    titleEl.innerHTML = U.icon(icon, tone) + label;
    document.title = label + " — RendoWin";

    const narrowed = state.volatility || state.q;
    countEl.textContent =
      list.length + (list.length === 1 ? " game" : " games") + (narrowed ? " match your filters" : "");

    results.innerHTML = "";
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.style.gridColumn = "1 / -1";
      if (state.favOnly && !narrowed) {
        e.innerHTML = U.icon("heart") + "<p>No favourites yet. Tap the heart on any game to keep it here.</p>" +
          '<a class="btn btn-primary btn-sm" href="games.html">Browse all games</a>';
      } else {
        e.innerHTML = U.icon("search") + "<p>No games match those filters.</p>" +
          '<button class="btn btn-ghost btn-sm" type="button">Reset filters</button>';
        e.querySelector("button").addEventListener("click", resetFilters);
      }
      results.appendChild(e);
    } else {
      list.forEach((g) => results.appendChild(U.gameCard(g)));
    }

    syncChips();
    updateUrl();
  }

  function updateUrl() {
    const p = new URLSearchParams();
    if (state.category) p.set("category", state.category);
    if (state.tag) p.set("tag", state.tag);
    if (state.favOnly) p.set("fav", "1");
    if (state.volatility) p.set("volatility", state.volatility);
    if (state.q) p.set("q", state.q);
    if (state.sort !== "popular") p.set("sort", state.sort);
    const qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
    U.markActiveNav();
  }

  render();
})();

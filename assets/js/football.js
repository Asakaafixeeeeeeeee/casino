(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);
  const state = { view: "today", search: "", country: "", league: "", data: null, open: null };
  const bannerSlides = [...document.querySelectorAll(".fb-banner-slide")];
  const bannerDots = [...document.querySelectorAll(".fb-banner-dot")];
  const esc = U.esc;
  const teamLogo = (source, name) => {
    let url = "";
    if (typeof source === "string" && source.startsWith("/api/football/teams/")) {
      url = U.paymentBase + source;
    } else if (typeof source === "string") {
      try {
        const parsed = new URL(source);
        if (parsed.protocol === "https:" && parsed.hostname === "crests.football-data.org") url = parsed.href;
      } catch (_) { /* Ignore logos that do not come from the approved feed host. */ }
    }
    return url
      ? '<img class="fb-team-logo" src="' + esc(url) + '" alt="" loading="lazy">'
      : '<span class="fb-team-logo-fallback" aria-hidden="true">' + esc((name || "?").trim().charAt(0).toUpperCase()) + "</span>";
  };
  function showBanner(index) {
    const active = ((index % bannerSlides.length) + bannerSlides.length) % bannerSlides.length;
    bannerSlides.forEach((slide, i) => {
      const selected = i === active;
      slide.classList.toggle("active", selected);
      slide.setAttribute("aria-hidden", String(!selected));
      slide.inert = !selected;
    });
    bannerDots.forEach((dot, i) => {
      const selected = i === active;
      dot.classList.toggle("active", selected);
      dot.setAttribute("aria-current", String(selected));
    });
  }
  const dateKey = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };
  const time = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "Time unavailable" : d.toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Accra" }) + " GMT";
  };
  const matchStatus = (status) => {
    if (["IN_PLAY", "LIVE"].includes(status)) return "LIVE";
    if (["PAUSED", "HALF_TIME"].includes(status)) return "HALF-TIME";
    if (status === "FINISHED") return "FINISHED";
    if (status === "POSTPONED") return "POSTPONED";
    if (status === "CANCELLED") return "CANCELLED";
    return "SCHEDULED";
  };
  function currentMatches() {
    const d = state.data;
    if (!d || !d.enabled) return [];
    const now = new Date();
    const today = dateKey(now);
    const tomorrow = dateKey(new Date(now.getTime() + 86400000));
    const query = state.search.toLocaleLowerCase();
    return (d.fixtures || []).filter((m) => {
      const kickoff = dateKey(m.starts_at || m.utcDate);
      const status = matchStatus(m.status);
      if (state.view === "live" && status !== "LIVE" && status !== "HALF-TIME") return false;
      if (state.view === "today" && (kickoff !== today || ["FINISHED", "CANCELLED", "POSTPONED"].includes(status))) return false;
      if (state.view === "tomorrow" && kickoff !== tomorrow) return false;
      if (state.view === "upcoming" && (new Date(m.starts_at || m.utcDate) < now || ["FINISHED", "CANCELLED", "POSTPONED"].includes(status))) return false;
      if (state.view === "results" && status !== "FINISHED") return false;
      const country = (m.country || "").toLocaleLowerCase();
      const league = (m.league || "").toLocaleLowerCase();
      const home = (m.home_team || "").toLocaleLowerCase();
      const away = (m.away_team || "").toLocaleLowerCase();
      return (!state.country || country === state.country) &&
        (!state.league || league === state.league) &&
        (!query || [country, league, home, away].some((x) => x.includes(query)));
    });
  }
  function drawLeagues() {
    const d = state.data;
    const matches = (d && d.fixtures) || [];
    const leagues = [...new Set(matches.map((m) => m.league).filter(Boolean))].sort();
    $("fbLeagueList").innerHTML = leagues.length
      ? '<button class="fb-league-button' + (!state.league ? " active" : "") + '" data-league="">All competitions</button>' +
        leagues.map((name) => '<button class="fb-league-button' + (state.league === name ? " active" : "") + '" data-league="' + esc(name) + '">' + esc(name) + "</button>").join("")
      : '<p class="fb-muted">Competitions appear when an approved data feed is connected.</p>';
    const countries = [...new Set(matches.map((m) => m.country).filter(Boolean))].sort();
    $("fbCountry").innerHTML = '<option value="">All countries</option>' +
      countries.map((name) => '<option value="' + esc(name.toLocaleLowerCase()) + '">' + esc(name) + "</option>").join("");
    $("fbCountry").value = state.country;
  }
  function draw() {
    drawLeagues();
    const host = $("fbMatches");
    const data = state.data;
    if (!data) {
      host.innerHTML = '<div class="fb-empty"><strong>Football data unavailable</strong>Could not load the football service. Try refreshing in a moment.</div>';
      return;
    }
    if (!data.enabled) {
      host.innerHTML = '<div class="fb-empty"><strong>Football is not enabled yet</strong>The administrator can enable the football section after configuring the data rights and feed.</div>';
      return;
    }
    const matches = currentMatches();
    if (!matches.length) {
      const customExists = (data.fixtures || []).length > 0;
      const message = data.provider && data.provider.status !== "connected"
        ? data.provider.message
        : customExists ? "No matches in this view. Try another date, competition or search." : "No verified fixtures are available for this view yet.";
      host.innerHTML = '<div class="fb-empty"><strong>No fixtures to show</strong>' + esc(message || "No verified fixtures are available.") + "</div>";
      return;
    }
    const buckets = new Map();
    matches.forEach((m) => {
      const key = (m.country ? m.country + " · " : "") + (m.league || "Football");
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(m);
    });
    host.innerHTML = [...buckets.entries()].map(([league, fixtures]) =>
      '<section class="fb-group"><h2>' + esc(league) + "</h2>" +
        fixtures.map((m) => {
          const id = m.id || m.provider_id;
          const status = matchStatus(m.status);
          const score = m.home_score !== null && m.home_score !== undefined && m.away_score !== null && m.away_score !== undefined
            ? Number(m.home_score) + " – " + Number(m.away_score) : "";
          const detail = state.open === String(id)
            ? '<div class="fb-detail"><b>' + esc(status) + "</b> · Kickoff " + esc(time(m.starts_at || m.utcDate)) +
              (m.description ? "<br>" + esc(m.description) : "") +
              "<br>Team crests, match timeline, statistics and odds are shown only when supplied under an approved provider agreement. " +
              (m.source === "custom" ? "This is a custom event, not an official provider fixture." : "No market prices are currently connected.") + "</div>" : "";
          return '<article class="fb-match" data-match="' + esc(String(id)) + '" tabindex="0" role="button" aria-expanded="' + (state.open === String(id)) + '">' +
            '<div class="fb-match-main"><div class="fb-meta"><span>' + esc(time(m.starts_at || m.utcDate)) + "</span><span>·</span><span>" + esc(status) + "</span>" +
              (m.source === "custom" ? '<span class="fb-source">CUSTOM EVENT</span>' : '<span>Verified feed</span>') + "</div>" +
              '<div class="fb-teams"><span class="fb-team-row">' + teamLogo(m.home_team_logo, m.home_team) + "<span>" +
                esc(m.home_team || "Home team") + "</span></span><span class=\"fb-team-row\">" +
                teamLogo(m.away_team_logo, m.away_team) + "<span>" + esc(m.away_team || "Away team") + "</span></span></div></div>" +
            '<div class="fb-score">' + esc(score || "—") + "</div>" + detail + "</article>";
        }).join("") + "</section>"
    ).join("");
  }
  async function refresh() {
    $("fbStatus").textContent = "Updating football information…";
    const r = await U.paymentApi("/api/football");
    if (!r.ok || !r.data) {
      $("fbStatus").dataset.tone = "warn";
      $("fbStatus").textContent = "Football service unavailable. " + ((r.data && r.data.message) || "Please try again.");
      return;
    }
    state.data = r.data;
    const provider = r.data.provider || {};
    $("fbStatus").dataset.tone = provider.status === "connected" ? "" : "warn";
    $("fbStatus").textContent = provider.status === "connected"
      ? "Verified football feed connected · refreshed " + new Date().toLocaleTimeString("en-GH", { timeZone: "Africa/Accra" }) + " GMT · betting disabled"
      : (provider.message || "No approved live data feed is available.") + " · betting disabled";
    draw();
  }
  document.querySelector(".fb-tabs").addEventListener("click", (e) => {
    const button = e.target.closest("[data-view]");
    if (!button) return;
    state.view = button.dataset.view;
    document.querySelectorAll(".fb-tabs [data-view]").forEach((el) => el.classList.toggle("active", el === button));
    draw();
  });
  $("fbLeagueList").addEventListener("click", (e) => {
    const button = e.target.closest("[data-league]");
    if (!button) return;
    state.league = button.dataset.league;
    draw();
  });
  $("fbCountry").addEventListener("change", (e) => { state.country = e.target.value; draw(); });
  $("fbSearch").addEventListener("input", (e) => { state.search = e.target.value.trim(); draw(); });
  $("fbRefresh").addEventListener("click", refresh);
  document.querySelector(".fb-banner-controls").addEventListener("click", (e) => {
    const dot = e.target.closest("[data-banner-to]");
    if (dot) showBanner(Number(dot.dataset.bannerTo));
    else if (e.target.closest(".fb-banner-next")) {
      const active = bannerSlides.findIndex((slide) => slide.classList.contains("active"));
      showBanner(active + 1);
    }
  });
  $("fbMatches").addEventListener("click", (e) => {
    const card = e.target.closest("[data-match]");
    if (!card) return;
    state.open = state.open === card.dataset.match ? null : card.dataset.match;
    draw();
  });
  $("fbMatches").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest("[data-match]");
    if (!card) return;
    e.preventDefault();
    state.open = state.open === card.dataset.match ? null : card.dataset.match;
    draw();
  });
  refresh();
  setInterval(refresh, 60_000);
})();

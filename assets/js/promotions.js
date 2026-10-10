/* Promotions page: one card per offer. Offers that haven't launched say so and have no claim button. */
(function () {
  "use strict";
  const { promos } = window.VB;
  const U = window.VBUtil;
  const list = document.getElementById("promoList");

  promos.forEach((p) => {
    const card = document.createElement("article");
    card.className = "promo-card";
    card.id = p.id;
    card.innerHTML =
      '<div class="slide slide-' + p.theme + '">' +
      '<span class="slide-copy"><span class="slide-kicker">' + p.kicker + "</span>" +
      '<strong class="slide-title">' + p.title.replace(p.highlight, "<span>" + p.highlight + "</span>") + "</strong>" +
      '<span class="slide-sub">' + p.sub + "</span></span>" +
      '<span class="slide-art" aria-hidden="true">' + p.art + "</span></div>" +
      '<div class="promo-body">' +
      (p.soon ? '<span class="promo-soon">Coming soon</span>' : "") +
      '<div class="panel-title" style="margin:0">' + (p.soon ? "What's planned" : "How it works") + "</div>" +
      "<ul>" + p.terms.map((t) => "<li>" + U.esc(t) + "</li>").join("") + "</ul>" +
      (p.soon ? "" : '<a class="btn btn-primary" href="' + p.href + '">' + p.cta + "</a>") +
      "</div>";
    list.appendChild(card);
  });

  /* the cards are built after the browser's own #fragment jump, so redo it */
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target) target.scrollIntoView();
})();

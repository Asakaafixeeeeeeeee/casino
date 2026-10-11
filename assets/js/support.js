/* WIN B casino — Customer care page: live chat, the numbers to call and the email (from data.js → VB.contact). */
(function () {
  "use strict";
  const { contact, telHref, icon, esc } = window.VBUtil;

  const row = (ico, label, value, href, extra) =>
    (href ? '<a class="care-row" href="' + href + '"' + (extra || "") + '>' : '<button class="care-row" type="button" data-open-chat>') +
    '<span class="care-icon">' + icon(ico) + '</span><span class="care-text"><small>' + label + '</small><b>' + value + '</b></span>' +
    icon("chevronRight") + (href ? '</a>' : '</button>');

  const rows = [row("chat", "Live chat", "Chat with us on the site")];
  contact.phones.forEach((p) => rows.push(row("handset", p.label || "Call us", esc(p.number), telHref(p.number))));
  if (contact.whatsapp) rows.push(row("chat", "WhatsApp", esc(contact.whatsapp), "https://wa.me/" + esc(contact.whatsapp.replace(/\D/g, "")), ' target="_blank" rel="noopener"'));
  if (contact.email) rows.push(row("mail", "Email", esc(contact.email), "mailto:" + esc(contact.email)));
  document.getElementById("careList").innerHTML = rows.join("") +
    (contact.hours ? '<p class="care-hours">' + esc(contact.hours) + '</p>' : "");

})();

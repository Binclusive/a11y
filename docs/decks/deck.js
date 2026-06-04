/* =============================================================================
   deck.js — slide navigation + accessibility for both decks.
   No dependencies. Drives any page whose slides are <section class="slide">
   inside <main class="deck">.

   Keys:  →/Space/PageDown next · ←/PageUp prev · Home first · End last
          o/Esc toggle contents overview · 1–9 jump to that contents item
   A11y:  only the active slide is exposed to AT (inactive get aria-hidden +
          inert-like). A polite live region announces "Slide N of M: <title>".
          Focus moves to the active slide so a keyboard/SR user follows along.
   ========================================================================== */
(function () {
  "use strict";

  var deck = document.querySelector(".deck");
  if (!deck) return;
  var slides = Array.prototype.slice.call(deck.querySelectorAll(".slide"));
  if (!slides.length) return;

  var progress = document.querySelector(".deck-progress");
  var counterCur = document.querySelector("[data-counter-current]");
  var counterTot = document.querySelector("[data-counter-total]");
  var live = document.querySelector("[data-live]");
  var contents = document.querySelector(".contents");
  var contentsList = document.querySelector("[data-contents-list]");
  var deckNav = document.querySelector(".deck-nav");
  var hint = document.querySelector(".overview-hint");
  var btnMenu = document.querySelector("[data-menu]");

  var index = 0;
  var total = slides.length;

  if (counterTot) counterTot.textContent = pad(total);

  // Build the contents overview from each slide's data-title.
  if (contentsList) {
    slides.forEach(function (s, i) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = s.getAttribute("data-title") || "Slide " + (i + 1);
      btn.addEventListener("click", function () {
        go(i, true);
        closeContents();
      });
      li.appendChild(btn);
      contentsList.appendChild(li);
    });
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function render(focusSlide) {
    slides.forEach(function (s, i) {
      var active = i === index;
      s.classList.toggle("is-active", active);
      s.setAttribute("aria-hidden", active ? "false" : "true");
      // keep inactive slides out of the tab order entirely
      if (active) {
        s.removeAttribute("inert");
        s.setAttribute("tabindex", "-1");
      } else {
        s.setAttribute("inert", "");
        s.removeAttribute("tabindex");
      }
    });
    if (progress) progress.style.width = ((index + 1) / total) * 100 + "%";
    if (counterCur) counterCur.textContent = pad(index + 1);

    var title = slides[index].getAttribute("data-title") || "";
    if (live) live.textContent = "Slide " + (index + 1) + " of " + total + ": " + title;
    // Move focus to the active slide ONLY on keyboard/contents navigation — never
    // on a nav-button click or swipe, which would yank focus off the button the
    // user is still operating. The live region announces every change regardless.
    if (focusSlide) slides[index].focus({ preventScroll: true });
    try {
      history.replaceState(null, "", "#" + (index + 1));
    } catch (e) { /* file:// can reject replaceState — ignore */ }
  }

  function go(i, focusSlide) {
    index = Math.max(0, Math.min(total - 1, i));
    render(focusSlide);
  }
  function next(focusSlide) { if (index < total - 1) go(index + 1, focusSlide); }
  function prev(focusSlide) { if (index > 0) go(index - 1, focusSlide); }

  function setBehindInert(on) {
    // Hold everything behind the contents dialog inert so Tab can't walk out of
    // the modal into the deck or nav chrome — the promise aria-modal can't keep.
    [deck, deckNav, hint].forEach(function (el) {
      if (!el) return;
      if (on) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    });
  }
  function openContents() {
    if (!contents) return;
    contents.classList.add("is-open");
    setBehindInert(true);
    if (btnMenu) btnMenu.setAttribute("aria-expanded", "true");
    var f = contents.querySelector("button");
    if (f) f.focus();
  }
  function closeContents() {
    if (!contents) return;
    contents.classList.remove("is-open");
    setBehindInert(false);
    if (btnMenu) btnMenu.setAttribute("aria-expanded", "false");
    slides[index].focus({ preventScroll: true });
  }
  function toggleContents() {
    if (contents && contents.classList.contains("is-open")) closeContents();
    else openContents();
  }

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (k === "o" || k === "O") { e.preventDefault(); toggleContents(); return; }
    if (k === "Escape") { closeContents(); return; }
    if (contents && contents.classList.contains("is-open")) return;
    switch (k) {
      case "ArrowRight":
      case "PageDown":
      case " ":
      case "Spacebar":
        e.preventDefault(); next(true); break;
      case "ArrowLeft":
      case "PageUp":
        e.preventDefault(); prev(true); break;
      case "Home": e.preventDefault(); go(0, true); break;
      case "End": e.preventDefault(); go(total - 1, true); break;
      default:
        if (/^[1-9]$/.test(k)) { e.preventDefault(); go(parseInt(k, 10) - 1, true); }
    }
  });

  // nav buttons — click must NOT steal focus to the slide (finding 5)
  var btnPrev = document.querySelector("[data-prev]");
  var btnNext = document.querySelector("[data-next]");
  if (btnPrev) btnPrev.addEventListener("click", function () { prev(false); });
  if (btnNext) btnNext.addEventListener("click", function () { next(false); });
  if (btnMenu) {
    btnMenu.setAttribute("aria-expanded", "false");
    btnMenu.addEventListener("click", toggleContents);
  }
  // click the dialog backdrop to dismiss (mouse users can't Tab out while inert)
  if (contents) contents.addEventListener("click", function (e) {
    if (e.target === contents) closeContents();
  });

  // touch / swipe
  var x0 = null;
  deck.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  deck.addEventListener("touchend", function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) { dx < 0 ? next(false) : prev(false); }
    x0 = null;
  }, { passive: true });

  // deep-link to #N on load
  var start = parseInt((location.hash || "").replace("#", ""), 10);
  if (start >= 1 && start <= total) index = start - 1;

  render(false);
})();

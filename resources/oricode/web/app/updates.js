/* OriCode PWA updater — consent-first reloads.
 * Registers the service worker, shows an accessible banner when a new version
 * is waiting, and only reloads after the user presses "Actualizar". Draft text
 * in the composer is preserved across the reload via sessionStorage, and a
 * reload is deferred while a generation is in flight (send button disabled).
 */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;

  var DRAFT_KEY = "oc_draft";
  var accepted = false;
  var controllerChanged = false;
  var banner;

  function composer() { return document.getElementById("ta"); }
  function generating() {
    var send = document.getElementById("send");
    return !!(send && send.disabled);
  }

  // Restore a draft saved before a consent reload.
  try {
    var draft = sessionStorage.getItem(DRAFT_KEY);
    if (draft !== null) {
      sessionStorage.removeItem(DRAFT_KEY);
      var ta = composer();
      if (ta && !ta.value) ta.value = draft;
    }
  } catch (e) { /* storage unavailable */ }

  function saveDraft() {
    try {
      var ta = composer();
      if (ta && ta.value) sessionStorage.setItem(DRAFT_KEY, ta.value);
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch (e) { /* storage unavailable */ }
  }

  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement("div");
    banner.id = "oc-update";
    banner.setAttribute("role", "status");
    banner.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:9999;" +
      "max-width:calc(100vw - 24px);flex-wrap:wrap;" +
      "display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;" +
      "background:var(--inbg,#fff);color:inherit;border:1px solid var(--border,#ccc);" +
      "box-shadow:0 4px 18px rgba(0,0,0,.25);font-size:13px";
    var text = document.createElement("span");
    text.textContent = "Nueva versión disponible";
    var yes = document.createElement("button");
    yes.id = "oc-update-yes";
    yes.textContent = "Actualizar";
    yes.style.cssText = "background:var(--acc,#3b82f6);color:#fff;border:none;padding:6px 12px;border-radius:8px;cursor:pointer;font-weight:600";
    var later = document.createElement("button");
    later.id = "oc-update-later";
    later.textContent = "Más tarde";
    later.style.cssText = "background:none;border:1px solid var(--border,#ccc);color:inherit;padding:6px 12px;border-radius:8px;cursor:pointer";
    banner.append(text, yes, later);
    document.body.appendChild(banner);
    yes.addEventListener("click", acceptUpdate);
    later.addEventListener("click", function () { banner.remove(); banner = null; });
    return banner;
  }

  function maybeReload() {
    if (!accepted || !controllerChanged) return;
    if (generating()) {
      var note = document.querySelector("#oc-update span");
      if (note) note.textContent = "Se actualizará al terminar la respuesta…";
      return;
    }
    saveDraft();
    location.reload();
  }

  function acceptUpdate() {
    if (accepted) return;
    accepted = true;
    var yes = document.getElementById("oc-update-yes");
    if (yes) yes.disabled = true;
    saveDraft();
    navigator.serviceWorker.getRegistration().then(function (reg) {
      var waiting = reg && reg.waiting;
      if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
      else maybeReload(); // no waiting worker: nothing to activate
    }).catch(function () {
      accepted = false;
      if (yes) yes.disabled = false;
      var note = document.querySelector("#oc-update span");
      if (note) note.textContent = "No se pudo comprobar la actualización. Reintenta.";
    });
  }

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    // Only reached after an accepted SKIP_WAITING; old workers never claim
    // without the user asking, so flag-gate the reload anyway.
    controllerChanged = true;
    maybeReload();
  });

  navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).then(function (reg) {
    function watch(worker) {
      if (!worker) return;
      worker.addEventListener("statechange", function () {
        if (worker.state === "installed" && navigator.serviceWorker.controller) ensureBanner();
      });
      if (worker.state === "installed" && navigator.serviceWorker.controller) ensureBanner();
    }
    if (reg.waiting) ensureBanner();
    watch(reg.installing); // registration already in progress
    reg.addEventListener("updatefound", function () { watch(reg.installing); });
    // Periodic update checks: daily while open, and whenever the tab refocuses.
    setInterval(function () { reg.update().catch(function () {}); }, 24 * 60 * 60 * 1000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) reg.update().catch(function () {});
    });
  }).catch(function () {});

  // Deferred reload while a generation is in flight.
  setInterval(maybeReload, 500);
})();

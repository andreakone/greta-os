/* Greta OS — shell desktop + gestione emulatore v86. */

"use strict";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  emu: null,
  profile: null,
  customProfile: null,
  running: false,
  bootSeq: 0,
  scale: 1,
  fitMode: true,
  lastProgress: { index: 0, count: 0, frac: 0 },
};

/* ================= rilevamento hardware del PC ================= */
const HOST = {
  ram_gb: navigator.deviceMemory || null,
  cores: navigator.hardwareConcurrency || null,
  lang: (navigator.language || "").toLowerCase(),
  coarse_pointer: matchMedia("(pointer: coarse)").matches,
  screen: screen.width + "×" + screen.height,
  dpr: window.devicePixelRatio || 1,
};

function host_lang2() {
  return (HOST.lang || "").slice(0, 2);
}

/* Comandi automatici della guest, adattati al PC (es. console italiana).
   Nota: keyboard_send_text usa scancode "us"; dopo `loadkeys it` la guest
   rileggerebbe gli stessi scancode col keymap italiano (lo "/" diventa "-"),
   quindi tutti i comandi devono essere digitati su UNA riga, prima che
   loadkeys venga eseguito. */
function auto_cmds(profile) {
  const c = profile && profile.auto_cmd ? profile.auto_cmd.slice() : [];
  if (!c.length) return c;
  if (host_lang2() === "it") return ["loadkeys it; " + c.join("; ")];
  return c;
}

/* ================= orologio ================= */
function tick_clock() {
  $("clock").textContent = new Date().toLocaleTimeString("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
tick_clock();
setInterval(tick_clock, 10000);

/* ================= splash / progresso ================= */
function splash_show() {
  const el = $("splash");
  el.hidden = false;
  el.classList.remove("fadeout", "error");
  $("btn-retry").hidden = true;
}

function set_progress(frac, status, sub) {
  frac = Math.max(0, Math.min(1, frac || 0));
  $("progress-bar").style.width = (frac * 100).toFixed(1) + "%";
  if (status !== undefined && status !== null) $("progress-text").textContent = status;
  $("progress-sub").textContent = sub || "";
}

function splash_error(msg, detail) {
  const el = $("splash");
  el.classList.add("error");
  set_progress(1, "Errore: " + msg, detail || "Controlla la connessione e premi Riprova.");
  $("btn-retry").hidden = false;
}

function splash_hide() {
  const el = $("splash");
  if (el.hidden) return;
  $("desktop").hidden = false;
  el.classList.add("fadeout");
  setTimeout(() => {
    el.hidden = true;
    el.classList.remove("fadeout");
  }, 450);
}

function friendly_name(url) {
  if (!url) return "";
  let n = String(url);
  try {
    if (/^https?:/.test(n)) n = new URL(n).pathname.split("/").filter(Boolean).pop() || n;
  } catch (e) {}
  return n;
}

/* ================= ciclo di vita emulator ================= */
function reset_screen() {
  const c = $("screen_container");
  c.innerHTML = '<div class="screen-text"></div><canvas style="display:none"></canvas>';
}

function base_options() {
  return {
    wasm_path: "vendor/v86.wasm",
    bios: { url: "vendor/bios/seabios.bin" },
    vga_bios: { url: "vendor/bios/vgabios.bin" },
    screen_container: $("screen_container"),
    autostart: true,
    disable_speaker: true,
  };
}

async function shutdown() {
  S.bootSeq++;
  const emu = S.emu;
  S.emu = null;
  S.running = false;
  document.body.classList.remove("vm-on");
  try { document.exitPointerLock(); } catch (e) {}
  if (emu) {
    try { await emu.stop(); } catch (e) {}
    try { await emu.destroy(); } catch (e) {}
  }
  reset_screen();
  update_ui();
}

async function boot(profile) {
  if (typeof V86 === "undefined") {
    splash_show();
    splash_error("vendor/libv86.js non caricato");
    return;
  }
  await shutdown();
  const seq = S.bootSeq;
  S.profile = profile;
  S.fitMode = true;
  S.lastProgress = { index: 0, count: 0, frac: 0 };

  splash_show();
  set_progress(0.02, "Preparazione di " + (profile.short || profile.name) + "…", "");
  $("status-left").textContent = "Avvio " + (profile.short || profile.name) + "…";

  const opts = base_options();
  Object.assign(opts, profile.make_options());

  let emu;
  try {
    emu = new V86(opts);
  } catch (e) {
    splash_error(e.message || String(e));
    return;
  }
  S.emu = emu;
  attach_listeners(emu, seq);
}

function attach_listeners(emu, seq) {
  const on = (ev, fn) => emu.add_listener(ev, (...args) => { if (seq !== S.bootSeq) return; fn(...args); });

  on("download-progress", (e) => {
    const name = friendly_name(e.file_name);
    const isWasm = /v86.*\.wasm$/i.test(name);
    if (isWasm) {
      const f = e.lengthComputable && e.total ? e.loaded / e.total : 0.3;
      set_progress(0.02 + 0.15 * f, "Scaricamento motore WebAssembly…", name + " · " + fmt_bytes(e.loaded) + (e.lengthComputable && e.total ? " / " + fmt_bytes(e.total) : ""));
      return;
    }
    const count = Math.max(1, e.file_count || 1);
    const idx = Math.max(0, e.file_index || 0);
    const frac = e.lengthComputable && e.total ? e.loaded / e.total : 0;
    S.lastProgress = { index: idx, count, frac };
    const overall = (idx + frac) / count;
    set_progress(
      0.17 + 0.8 * overall,
      "Scaricamento " + (idx + 1) + " di " + count + "…",
      name + (e.lengthComputable && e.total
        ? " · " + fmt_bytes(e.loaded) + " / " + fmt_bytes(e.total)
        : " · " + fmt_bytes(e.loaded))
    );
  });

  on("download-error", (e) => {
    const status = e && e.request && e.request.status ? " (HTTP " + e.request.status + ")" : "";
    splash_error("download non riuscito" + status, friendly_name(e && e.file_name));
  });

  on("emulator-loaded", () => {
    set_progress(0.97, "Avvio del sistema operativo…", "BIOS + kernel in esecuzione");
  });

  on("emulator-started", () => {
    S.running = true;
    document.body.classList.add("vm-on");
    set_progress(1, "Sistema in esecuzione");
    splash_hide();
    $("status-left").textContent = "In esecuzione — " + (S.profile.short || S.profile.name);
    $("stage-hint").classList.remove("used");
    update_ui();
    if (S.fitMode) setTimeout(fit_scale, 150);
    auto_type(emu, S.profile, seq);
  });

  on("emulator-stopped", () => {
    S.running = false;
    $("status-left").textContent = "In pausa — " + (S.profile.short || S.profile.name);
    update_ui();
  });

  on("eth-transmit-end", net_blink);
  on("eth-receive-end", net_blink);
}

function auto_type(emu, profile, seq) {
  const cmds = auto_cmds(profile);
  if (!cmds.length) return;
  let delay = 6000;
  for (const cmd of cmds) {
    setTimeout(() => {
      if (seq !== S.bootSeq || S.emu !== emu || !S.running) return;
      try { emu.keyboard_send_text(cmd + "\n"); } catch (e) {}
    }, delay);
    delay += 9000;
  }
}

function fmt_bytes(n) {
  if (!n && n !== 0) return "";
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " kB";
  return n + " B";
}

/* ================= rete ================= */
let net_timer = 0;
function net_blink() {
  const dot = document.querySelector("#net-indicator .net-dot");
  if (!dot) return;
  dot.classList.add("on");
  clearTimeout(net_timer);
  net_timer = setTimeout(() => dot.classList.remove("on"), 180);
}

/* ================= UI topbar ================= */
function update_ui() {
  $("btn-pause").textContent = S.running ? "Pausa" : "Riprendi";
  $("btn-pause").disabled = !S.emu;
  $("btn-restart").disabled = !S.emu;
  $("btn-cad").disabled = !S.emu;
  $("btn-screenshot").disabled = !S.emu;
  $("btn-fullscreen").disabled = !S.emu;
  $("btn-zoom-in").disabled = !S.emu;
  $("btn-zoom-out").disabled = !S.emu;
  $("btn-zoom-fit").disabled = !S.emu;
}

/* ================= scala dello schermo ================= */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

function apply_scale(f) {
  if (!S.emu) return;
  S.scale = f;
  S.emu.screen_set_scale(f, f);
}

function fit_scale() {
  if (!S.emu) return;
  const emu = S.emu;
  emu.screen_set_scale(1, 1);
  const holder = $("screen_holder");
  const scr = $("screen_container");
  const r = scr.getBoundingClientRect();
  const a = holder.getBoundingClientRect();
  if (!r.width || !r.height || !a.width || !a.height) return;
  let f = Math.min(a.width / r.width, a.height / r.height);
  f = Math.floor(f * 100) / 100;
  if (f <= 0.05) return;
  S.scale = f;
  emu.screen_set_scale(f, f);
}

function zoom(step) {
  S.fitMode = false;
  let cur = S.scale;
  let i = 0;
  for (let k = 0; k < ZOOM_STEPS.length; k++) {
    if (Math.abs(ZOOM_STEPS[k] - cur) < 0.001) { i = k; break; }
    if (ZOOM_STEPS[k] < cur) i = k;
  }
  i = Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + step));
  apply_scale(ZOOM_STEPS[i]);
}

window.addEventListener("resize", () => {
  if (S.fitMode && S.emu && S.running) fit_scale();
});

/* ================= azioni ================= */
async function send_cad() {
  if (!S.emu) return;
  const down = [29, 56, 83];
  const up = [29 | 128, 56 | 128, 83 | 128];
  try {
    await S.emu.keyboard_send_scancodes(down, 25);
    await sleep(60);
    await S.emu.keyboard_send_scancodes(up, 25);
  } catch (e) {}
}

function screenshot() {
  if (!S.emu) return;
  const img = S.emu.screen_make_screenshot();
  if (!img) return;
  const save = () => {
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = img.src;
    a.download = "greta-os-" + ts + ".png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  if (img.complete && img.src) save();
  else img.onload = save;
}

function open_info() {
  fill_info();
  $("info-modal").hidden = false;
}
function close_info() { $("info-modal").hidden = true; }

/* ================= puntatore sincronizzato con la VM ================= */
const HINT_DEFAULT = "Clicca per sincronizzare il puntatore con la VM · ESC per liberarlo";
const HINT_LOCKED = "Mouse sincronizzato con la VM · premi ESC per liberarlo";

function on_pointer_lock_change() {
  const locked = !!document.pointerLockElement;
  const hint = $("stage-hint");
  hint.textContent = locked ? HINT_LOCKED : HINT_DEFAULT;
  if (!locked && S.running) hint.classList.remove("used");
}

/* ================= informazioni su PC e cache ================= */
async function fill_cache_info() {
  const st = await ImgCache.stats();
  $("cache-info").textContent = st.count
    ? st.count + " file · " + fmt_bytes(st.size) + " salvati in questo browser: " +
      "le prossime volte le immagini verranno lette da disco, senza re-download."
    : "nessuna immagine salvata: il primo avvio scarica e salva tutto, i successivi sono senza download.";
}

function fill_info() {
  const ul = $("host-info");
  ul.innerHTML = "";
  const add = (html) => {
    const li = document.createElement("li");
    li.innerHTML = html;
    ul.appendChild(li);
  };
  add("RAM: <strong>" +
      (HOST.ram_gb ? HOST.ram_gb + " GB (dichiarati dal browser)" : "non disponibile") + "</strong>" +
      (HOST.ram_gb >= 8 ? " → la VM riceve il doppio (tetto 1 GB)" : ""));
  add("Core CPU: <strong>" + (HOST.cores || "?") + "</strong> — v86 usa un solo thread, gli altri tengono vivo il sito");
  add("Schermo: <strong>" + HOST.screen + "</strong> · densità " + HOST.dpr +
      "× — lo schermo della VM si adatta alla finestra");
  add("Lingua: <strong>" + (navigator.language || "?") + "</strong>" +
      (host_lang2() === "it" ? " → console della guest in italiano (<code>loadkeys it</code>)" : ""));
  add("Puntatore: <strong>" +
      (HOST.coarse_pointer ? "tattile — per la VM è meglio un mouse" : "mouse/trackpad") +
      "</strong> — clic sullo schermo = puntatore sincronizzato (pointer lock)");
  fill_cache_info();
}

/* ================= schermo intero ================= */
function is_fullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggle_fullscreen() {
  const h = $("screen_holder");
  if (is_fullscreen()) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } else if (h.requestFullscreen) {
    h.requestFullscreen().catch(() => {});
  } else if (h.webkitRequestFullscreen) {
    h.webkitRequestFullscreen();
  }
}

function on_fullscreen_change() {
  const on = is_fullscreen();
  $("btn-fs-exit").hidden = true;
  if (on) $("stage-hint").classList.add("used");
  if (S.fitMode && S.emu) setTimeout(fit_scale, 80);
}

function on_mouse_move(e) {
  const exit = $("btn-fs-exit");
  if (!is_fullscreen()) {
    if (!exit.hidden) exit.hidden = true;
    return;
  }
  const in_corner = e.clientY <= 100 && e.clientX >= window.innerWidth - 220;
  const over_btn = exit === e.target || exit.contains(e.target);
  const show = in_corner || over_btn;
  if (show && exit.hidden) exit.hidden = false;
  else if (!show && !exit.hidden) exit.hidden = true;
}

/* ================= distro locali (ISO/IMG scelte dall'utente) ================= */
function load_local_file(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const as_cd = ext === "iso";
  const profile = {
    id: "local",
    name: "Locale: " + file.name,
    short: file.name,
    make_options() {
      const opts = {
        memory_size: mem(file.size > 700 * MB ? 1024 : 512) * MB,
        net_device: { type: "ne2k", relay_url: RELAY },
      };
      const img = { buffer: file };
      if (as_cd) opts.cdrom = img;
      else opts.hda = img;
      return opts;
    },
  };
  S.customProfile = profile;

  const sel = $("distro-select");
  let opt = sel.querySelector('option[value="local"]');
  if (!opt) {
    opt = document.createElement("option");
    opt.value = "local";
    sel.appendChild(opt);
  }
  opt.textContent = "Immagine locale: " + file.name;
  sel.value = "local";
  boot(profile);
}

function boot_selected() {
  const id = $("distro-select").value;
  if (id === "local" && S.customProfile) boot(S.customProfile);
  else {
    const p = find_profile(id);
    if (p) boot(p);
  }
}

/* ================= inizializzazione ================= */
function init() {
  const sel = $("distro-select");
  for (const p of PROFILES) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    o.title = p.desc || "";
    sel.appendChild(o);
  }
  sel.value = "arch";

  sel.addEventListener("change", boot_selected);
  $("btn-boot").addEventListener("click", boot_selected);
  $("btn-retry").addEventListener("click", boot_selected);

  $("btn-pause").addEventListener("click", async () => {
    if (!S.emu) return;
    if (S.running) await S.emu.stop();
    else await S.emu.run();
  });
  $("btn-restart").addEventListener("click", () => { if (S.profile) boot(S.profile); });
  $("btn-cad").addEventListener("click", send_cad);
  $("btn-screenshot").addEventListener("click", screenshot);
  $("btn-fullscreen").addEventListener("click", toggle_fullscreen);
  $("btn-fs-exit").addEventListener("click", toggle_fullscreen);
  document.addEventListener("fullscreenchange", on_fullscreen_change);
  document.addEventListener("webkitfullscreenchange", on_fullscreen_change);
  document.addEventListener("mousemove", on_mouse_move);
  $("btn-zoom-in").addEventListener("click", () => zoom(1));
  $("btn-zoom-out").addEventListener("click", () => zoom(-1));
  $("btn-zoom-fit").addEventListener("click", () => {
    S.fitMode = true;
    fit_scale();
  });

  $("btn-local-iso").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) load_local_file(f);
    e.target.value = "";
  });

  $("btn-info").addEventListener("click", open_info);
  $("dock-info").addEventListener("click", open_info);
  $("info-close").addEventListener("click", close_info);
  $("btn-cache-clear").addEventListener("click", async () => {
    await ImgCache.clear();
    fill_cache_info();
  });
  $("info-modal").addEventListener("click", (e) => {
    if (e.target === $("info-modal")) close_info();
  });

  $("dock-terminal").addEventListener("click", () => {
    $("distro-select").value = "linuxcli";
    boot_selected();
  });
  $("dock-desktop").addEventListener("click", () => {
    $("distro-select").value = "arch";
    boot_selected();
  });
  $("dock-iso").addEventListener("click", () => $("file-input").click());

  $("screen_holder").addEventListener("click", (e) => {
    $("stage-hint").classList.add("used");
    $("screen_container").focus();
    if (e.target && e.target.closest && e.target.closest(".fs-exit")) return;
    if (S.emu && !document.pointerLockElement) {
      try {
        const p = S.emu.lock_mouse();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (err) {}
    }
  });
  document.addEventListener("pointerlockchange", on_pointer_lock_change);
  document.addEventListener("webkitpointerlockchange", on_pointer_lock_change);

  /* nasconde il puntatore del browser quando la guest disegna il suo */
  const holder = $("screen_holder");
  const sync_gfx_cursor = () => {
    const canvas = $("screen_container").querySelector("canvas");
    const gfx = !!(canvas && canvas.style.display !== "none");
    holder.classList.toggle("gfx", gfx);
  };
  new MutationObserver(sync_gfx_cursor).observe($("screen_container"), {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("info-modal").hidden) close_info();
  });

  update_ui();
  boot(PROFILES[0]);
}

document.addEventListener("DOMContentLoaded", init);

window.GRETA = { S, boot, shutdown, HOST, ImgCache, auto_cmds };

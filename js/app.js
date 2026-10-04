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
  kbdRetry: 0,
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
  net_reset();
  touch_model = null;
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
  if (!S.profile || S.profile.id !== profile.id) S.kbdRetry = 0;
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
    check_kbd_init(emu, seq);
  });

  on("emulator-stopped", () => {
    S.running = false;
    $("status-left").textContent = "In pausa — " + (S.profile.short || S.profile.name);
    update_ui();
  });

  on("eth-transmit-end", net_blink);
  on("eth-receive-end", net_rx);
}

/* Alcune immagini (es. linux.iso) perdono la race di inizializzazione
   dell'i8042 sotto carico: il kernel stampa "No controller found" e la
   tastiera PS/2 resta morta. Se succede, un solo riavvio automatico. */
function check_kbd_init(emu, seq) {
  setTimeout(() => {
    if (seq !== S.bootSeq || S.emu !== emu || !S.running || S.kbdRetry) return;
    let txt = "";
    try {
      const sa = emu.screen_adapter;
      if (sa && sa.get_text_screen) txt = sa.get_text_screen().join("\n");
    } catch (e) { return; }
    if (!/No controller found/.test(txt)) return;
    S.kbdRetry = 1;
    $("status-left").textContent = "Tastiera non inizializzata — riavvio…";
    boot(S.profile);
  }, 8000);
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

/* ================= rete =================
   Il pallino è grigio finché la guest non riceve nulla: non significa
   "rete assente", ma "nessun pacchetto ancora". Con il primo frame in
   arrivo dal relè (DHCP/risposte) diventa verde; lampeggia arancione
   su ogni pacchetto in transito. */
let net_timer = 0;
let net_rx_total = 0;
function net_reset() {
  net_rx_total = 0;
  clearTimeout(net_timer);
  const dot = document.querySelector("#net-indicator .net-dot");
  if (dot) dot.classList.remove("on", "ok");
  const ind = $("net-indicator");
  if (ind) ind.title = "Rete guest (relè websocket) — in attesa di traffico";
}
function net_blink() {
  const dot = document.querySelector("#net-indicator .net-dot");
  if (!dot) return;
  dot.classList.add("on");
  clearTimeout(net_timer);
  net_timer = setTimeout(() => dot.classList.remove("on"), 180);
}
function net_rx(bytes) {
  net_rx_total += Number(bytes) || 0;
  if (!net_rx_total) return;
  const dot = document.querySelector("#net-indicator .net-dot");
  if (dot && !dot.classList.contains("ok")) {
    dot.classList.add("ok");
    const ind = $("net-indicator");
    if (ind) ind.title = "Rete guest connessa (relè websocket) — verde = traffico ricevuto";
  }
  net_blink();
}

/* ================= touch + tastiera mobile =================
   Su dispositivi touch v86 da solo muove il cursore trascinando ma non
   clicca: qui gestiamo noi i touch (in cattura, fermando i listener
   originali di v86) inviando i messaggi mouse sul bus dell'emulatore:
     - tocco breve  -> clic sinistro
     - trascina     -> sinistro premuto (drag)
     - premi a lungo-> tasto destro
     - due dita     -> rotellina (mouse-wheel)
   La tastiera usa l'ufficiale classe v86 "phone_keyboard": la textarea
   inoltra soft keyboard (input insertText/insertLineBreak), tastiere
   fisiche (keydown) e blocca gli input normali. */
const TOUCH_CAPABLE = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
let touch_model = null; // posizione stimata del cursore guest (coordinate viewport)
let kbd_ctrl_armed = false;

const KBD_SC = {
  esc: [0x01, 0x81],
  tab: [0x0f, 0x8f],
  bs: [0x0e, 0x8e],
  enter: [0x1c, 0x9c],
  left: [0x4b, 0xcb],
  up: [0x48, 0xc8],
  down: [0x50, 0xd0],
  right: [0x4d, 0xcd],
};

function send_scancodes(codes) {
  if (!S.emu) return;
  try {
    for (const c of codes) S.emu.bus.send("keyboard-code", c);
  } catch (e) {}
}

function kbd_ctrl_set(on) {
  kbd_ctrl_armed = !!on;
  const b = $("kbd-ctrl");
  if (b) b.classList.toggle("on", kbd_ctrl_armed);
}

function kbd_open() {
  $("kbd-bar").hidden = false;
  $("btn-kbd").classList.add("on");
  try { $("phone-kbd").focus(); } catch (e) {}
}

function kbd_close() {
  $("kbd-bar").hidden = true;
  $("btn-kbd").classList.remove("on");
  kbd_ctrl_set(false);
  try { $("phone-kbd").blur(); } catch (e) {}
}

function kbd_send_ctrl_char(ch) {
  if (!S.emu) return;
  try {
    S.emu.bus.send("keyboard-code", 0x1d); // Ctrl sinistro premuto
    S.emu.keyboard_adapter.simulate_char(ch);
    S.emu.bus.send("keyboard-code", 0x9d); // rilascio Ctrl
  } catch (e) {}
}

function init_touch_kbd() {
  if (!TOUCH_CAPABLE) return;
  $("btn-kbd").hidden = false;
  $("stage-hint").textContent =
    "Trascina per muovere il puntatore · tocca per cliccare · tieni premuto per il tasto destro · " +
    "due dita per scorrere · Tastiera in alto";

  /* --- barra tastiera --- */
  $("btn-kbd").addEventListener("click", () => {
    if ($("kbd-bar").hidden) kbd_open();
    else kbd_close();
  });
  // i click sui tasti speciali non devono togliere il focus dalla VM
  $("kbd-bar").addEventListener("mousedown", (e) => {
    if (e.target.closest && e.target.closest(".kbd-key")) e.preventDefault();
  });
  $("kbd-bar").addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".kbd-key");
    if (!b) return;
    const k = b.dataset.k;
    if (k === "close") { kbd_close(); return; }
    if (k === "ctrl") { kbd_ctrl_set(!kbd_ctrl_armed); return; }
    if (KBD_SC[k]) {
      const was_armed = kbd_ctrl_armed;
      if (was_armed) {
        send_scancodes([0x1d, ...KBD_SC[k], 0x9d]);
        kbd_ctrl_set(false);
      } else {
        send_scancodes(KBD_SC[k]);
      }
      const inp = $("phone-kbd");
      if (k === "bs") inp.value = was_armed
        ? inp.value.replace(/\S+\s*$/, "") : inp.value.slice(0, -1);
      if (k === "enter") inp.value = "";
    }
    try { $("phone-kbd").focus(); } catch (err) {}
  });

  /* soft keyboard: prima di v86 (cattura) per intercettare Ctrl+lettera,
     dopov86 (bolle) per ripulire il valore accumulato */
  window.addEventListener("input", (e) => {
    const inp = $("phone-kbd");
    if (e.target !== inp) return;
    if (kbd_ctrl_armed && e.inputType === "insertText" && e.data) {
      e.stopPropagation(); // v86 non deve inviarlo senza Ctrl
      for (const ch of e.data) kbd_send_ctrl_char(ch);
      inp.value = inp.value.endsWith(e.data) ? inp.value.slice(0, -e.data.length) : "";
      kbd_ctrl_set(false);
      return;
    }
    if (inp.value.length > 300) inp.value = inp.value.slice(-200);
  }, true);

  /* --- touch mouse (cattura su window, ferma i listener touch di v86) --- */
  let st = null;      // stato del tocco a un dito
  let two_finger = null; // stato scroll a due dita

  const rect = () => $("screen_container").getBoundingClientRect();
  const send = (name, data) => {
    try { if (S.emu && S.emu.bus && S.running) S.emu.bus.send(name, data); } catch (e) {}
  };
  const click = (l, m, r) => send("mouse-click", [!!l, !!m, !!r]);
  const in_vm = (t) => !!(t && t.closest && t.closest("#screen_holder") && !t.closest("button"));
  const touch_by_id = (list, id) => {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  };
  const mid_y = (e) => (e.touches[0].clientY + e.touches[1].clientY) / 2;

  function move_to(x, y, px, py) {
    const dx = x - px, dy = y - py;
    if (!dx && !dy) return;
    send("mouse-delta", [dx, -dy]);
    if (S.emu && S.emu.mouse_adapter && S.emu.mouse_adapter.absolute_mouse) {
      const r = rect();
      send("mouse-absolute", [x - r.left, y - r.top, r.width, r.height]);
    }
  }

  const touch_opts = { passive: false, capture: true };

  window.addEventListener("touchstart", (e) => {
    if (!in_vm(e.target)) return;
    e.stopPropagation(); // niente handler touch doppi di v86 (fase bolle)
    e.preventDefault();
    $("stage-hint").classList.add("used");

    if (e.touches.length >= 2) {
      if (st) { clearTimeout(st.timer); if (st.down || st.right) click(false, false, false); st = null; }
      two_finger = { y: mid_y(e) };
      return;
    }
    if (two_finger) return;

    const t = e.changedTouches[0];
    if (!touch_model) { // prima interazione: il cursore parte dal centro
      const r = rect();
      touch_model = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    move_to(t.clientX, t.clientY, touch_model.x, touch_model.y);
    touch_model = { x: t.clientX, y: t.clientY };

    st = {
      id: t.identifier,
      startX: t.clientX, startY: t.clientY,
      lastX: t.clientX, lastY: t.clientY,
      moved: false, down: false, right: false, timer: 0,
    };
    st.timer = setTimeout(() => {
      if (!st || st.moved) return;
      st.right = true;
      click(false, false, true); // tasto destro premuto
    }, 550);
  }, touch_opts);

  window.addEventListener("touchmove", (e) => {
    if (!in_vm(e.target)) return;
    e.stopPropagation();
    e.preventDefault();

    if (two_finger) {
      if (e.touches.length < 2) { two_finger = null; return; }
      const y = mid_y(e);
      const dy = y - two_finger.y;
      if (Math.abs(dy) >= 45) {
        send("mouse-wheel", [dy < 0 ? 1 : -1, 0]); // convenzione v86: [segno, 0]
        two_finger.y = y;
      }
      return;
    }
    if (!st) return;
    const t = touch_by_id(e.changedTouches, st.id);
    if (!t) return;
    const dx = t.clientX - st.lastX, dy = t.clientY - st.lastY;
    if (dx || dy) {
      move_to(t.clientX, t.clientY, st.lastX, st.lastY);
      st.lastX = t.clientX; st.lastY = t.clientY;
      touch_model = { x: t.clientX, y: t.clientY };
    }
    if (!st.moved && Math.hypot(t.clientX - st.startX, t.clientY - st.startY) > 5) {
      st.moved = true;
      clearTimeout(st.timer);
      if (!st.right) { st.down = true; click(true, false, false); } // inizio drag
    }
  }, touch_opts);

  window.addEventListener("touchend", (e) => {
    if (!in_vm(e.target)) return;
    e.stopPropagation();
    e.preventDefault();

    if (two_finger) {
      if (e.touches.length < 2) two_finger = null;
      return;
    }
    if (!st) return;
    const t = touch_by_id(e.changedTouches, st.id);
    if (!t) return;
    clearTimeout(st.timer);
    if (st.right || st.down) click(false, false, false);
    else { click(true, false, false); click(false, false, false); } // tocco = clic
    touch_model = { x: t.clientX, y: t.clientY };
    st = null;
  }, touch_opts);

  window.addEventListener("touchcancel", (e) => {
    if (st) {
      clearTimeout(st.timer);
      if (st.down || st.right) click(false, false, false);
      st = null;
    }
    two_finger = null;
  }, touch_opts);
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
      (HOST.coarse_pointer ? "tattile" : "mouse/trackpad") +
      "</strong> — " +
      (TOUCH_CAPABLE
        ? "trascina per muovere, tocca per cliccare, premi a lungo per il tasto destro; " +
          "pulsante Tastiera = tastiera sullo schermo"
        : "clic sullo schermo = puntatore sincronizzato (pointer lock)"));
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

  init_touch_kbd();

  update_ui();
  boot(PROFILES[0]);
}

document.addEventListener("DOMContentLoaded", init);

window.GRETA = { S, boot, shutdown, HOST, ImgCache, auto_cmds };

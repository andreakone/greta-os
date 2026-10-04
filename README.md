# Greta OS

Un desktop Linux completo e reale che gira **nel browser**, grazie a [v86](https://github.com/copy/v86)
(CPU x86 emulata in WebAssembly). Interfaccia ispirata ad Ubuntu (tema Yaru scuro), tutto in italiano.

## Come avviarlo

**Online**: <https://andreakone.github.io/greta-os/> — pubblicato su GitHub Pages, nessuna installazione.

**In locale** (per sviluppo): il progetto è statico, serve solo un web server qualsiasi
(necessario per caricare i file `.wasm`).

```bash
python -m http.server 8081 --directory progetti/greta
```

poi apri <http://127.0.0.1:8081/>.

> Nota: non aprire `index.html` con `file://` — il browser bloccherebbe il caricamento di `v86.wasm`.

## Cosa fa

- **Avvia / Pausa / Riavvia / Ctrl+Alt+Del** — controllo della VM.
- **Selettore distro** — Arch Linux (desktop grafico, avvia automaticamente X con `./startx.sh`),
  Tiny Core, Damn Small Linux, SliTaz, terminale, e altre.
- **Adatta / − / +** — scala lo schermo della VM.
- **Screenshot** — scarica uno screenshot del guest.
- **ISO locale…** — carica un `.iso`/`.img`/`.ima` scelto da te (avvio da disco locale, nessun upload).
- **Info** — pannello con credenziali e dettagli tecnici.
- **Schermo intero** — il pulsante ⛶ in alto a destra; in schermo intero, portando il mouse
  nell'angolo in alto a destra compare il pulsante per tornare alla modalità finestra.

## Struttura

```
greta/
├── index.html          # shell dell'app (topbar, dock, stage, splash, modali)
├── css/style.css       # tema Ubuntu/Yaru scuro
├── js/profiles.js      # definizioni delle distro (immagini, opzioni v86, auto_cmd, RAM dinamica)
├── js/cache.js         # cache delle immagini in IndexedDB + shim XHR
├── js/app.js           # ciclo di vita, UI, schermo intero, pointer lock, auto-comandi
└── vendor/             # v86 locale
    ├── libv86.js
    ├── v86.wasm
    └── bios/           # seabios.bin, vgabios.bin
```

## Note

- **Immagini**: le ISO/IMG vengono scaricate da `i.copy.sh` (host pubblico del progetto v86/copy.sh)
  durante l'avvio. L'host protegge gli hotlink: la pagina usa `<meta name="referrer" content="no-referrer">`
  per farsi accettare — non rimuoverlo.
- **Rete**: la scheda di rete della VM (`ne2k`) si collega al relè WebSocket pubblico
  `wss://relay.widgetry.org/`; il traffico guest passa da lì, quindi non usare la VM per dati sensibili.
- **Cache ISO**: le immagini scaricate vengono salvate nel browser (IndexedDB, tetto ~1,2 GB):
  i riavvii successivi partono senza riscaricare (dal vivo: ~5 s invece di decine). In **Info**
  trovi lo stato della cache e il pulsante per svuotarla.
- **RAM adattata al PC**: se il browser dichiara ≥8 GB (`navigator.deviceMemory`) la VM riceve
  il doppio della RAM del profilo, con tetto di 1 GB.
- **Mouse sincronizzato**: un clic sullo schermo attiva il pointer lock (il puntatore sparisce
  e segue la VM); `ESC` lo libera. La schermata "Il mouse è sincronizzato" spiega la scorciatoia.
- **Tastiera italiana**: con browser in italiano l'app digita `loadkeys it; ./startx.sh` su
  un'unica riga — dopo `loadkeys it` gli scancode "us" dell'auto-typing sarebbero rilettuti dal
  keymap italiano (lo `/` diventerebbe `-`), quindi tutto va digitato prima del cambio layout.
- **Arch Linux**: al prompt digita `./networking.sh` per abilitare la rete e `./startx.sh` per il
  desktop grafico (l'app lo digita già da sola con `auto_cmd`).
- **Nessuna immagine Ubuntu desktop è inclusata**: un'ISO Ubuntu con desktop pesa ~2-3 GB e
  l'host pubblico non la serve con CORS — per questo Greta OS offre un tema Ubuntu e il caricamento
  di ISO locali.
- Le immagini scaricate sono grandi (centinaia di MB): il primo avvio richiede pazienza e banda.

## Crediti

- [v86](https://github.com/copy/v86) — emulatore x86 in WebAssembly (MIT) — © Fabian Hemmer
- Immagini: [i.copy.sh](https://i.copy.sh) · Relè rete: [relay.widgetry.org](https://relay.widgetry.org)
- BIOS: SeaBIOS e VGABios (software libero, inclusi in `vendor/bios/`)

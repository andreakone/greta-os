/* Configurazioni delle distro reali (API pubblica v86).
   Le immagini sono servite da i.copy.sh (CORS: *). */

"use strict";

const IMG = "https://i.copy.sh/";
const RELAY = "wss://relay.widgetry.org/";
const MB = 1024 * 1024;

/* RAM consigliata per la VM: se il PC ne ha a sufficienza (â‰¥8 GB dichiarati
   da navigator.deviceMemory) la VM riceve il doppio, con tetto di 1 GB. */
function mem(mb) {
  const ram = (typeof navigator !== "undefined" && navigator.deviceMemory) || 0;
  if (ram >= 8) return Math.min(mb * 2, 1024);
  return mb;
}

const PROFILES = [
  {
    id: "arch",
    name: "Arch Linux â€” desktop grafico",
    short: "Arch Linux (desktop)",
    desc: "Snapshot ripristinato in console: Greta OS digita automaticamente ./startx.sh e la sessione grafica Ã¨ pronta in pochi secondi.",
    builtin: true,
    auto_cmd: ["./startx.sh"],
    make_options() {
      return {
        memory_size: mem(512) * MB,
        vga_memory_size: 8 * MB,
        initial_state: { url: IMG + "arch_state-v3.bin.zst" },
        filesystem: { baseurl: IMG + "arch/" },
        net_device: { type: "virtio", relay_url: RELAY },
        preserve_mac_from_state_image: true,
      };
    },
  },
  {
    id: "archboot",
    name: "Arch Linux â€” avvio completo",
    short: "Arch Linux (boot)",
    desc: "Avvio a freddo: kernel caricato dal filesystem 9p, boot completo fino al login grafico (piÃ¹ lento).",
    builtin: true,
    make_options() {
      return {
        memory_size: mem(512) * MB,
        vga_memory_size: 8 * MB,
        filesystem: { baseurl: IMG + "arch/", basefs: { url: IMG + "fs.json" } },
        bzimage_initrd_from_filesystem: true,
        cmdline: "rw apm=off vga=0x344 video=vesafb:ypan,vremap:8 root=host9p rootfstype=9p " +
                 "rootflags=trans=virtio,cache=loose mitigations=off audit=0 init_on_free=on " +
                 "tsc=reliable random.trust_cpu=on nowatchdog init=/usr/bin/init-openrc " +
                 "net.ifnames=0 biosdevname=0",
        net_device: { type: "virtio", relay_url: RELAY },
      };
    },
  },
  {
    id: "tinycore",
    name: "TinyCore 11 â€” desktop leggero",
    short: "TinyCore 11",
    desc: "Desktop minimalista (~20 MB di ISO): molto veloce anche sotto emulazione.",
    builtin: true,
    make_options() {
      return {
        memory_size: mem(256) * MB,
        net_device: { type: "ne2k", relay_url: RELAY },
        hda: { url: IMG + "TinyCore-11.0.iso", size: 19922944, async: false },
      };
    },
  },
  {
    id: "dsl",
    name: "Damn Small Linux â€” desktop",
    short: "Damn Small Linux",
    desc: "Classico desktop ultra-leggero (~50 MB) con window manager fluxbox.",
    builtin: true,
    make_options() {
      return {
        memory_size: mem(256) * MB,
        net_device: { type: "ne2k", relay_url: RELAY },
        cdrom: { url: IMG + "dsl-4.11.rc2.iso", size: 52824064, async: false },
      };
    },
  },
  {
    id: "slitaz",
    name: "SliTaz â€” desktop",
    short: "SliTaz",
    desc: "Distribuzione francese leggera con desktop graphico (~56 MB).",
    builtin: true,
    make_options() {
      return {
        memory_size: mem(512) * MB,
        net_device: { type: "ne2k", relay_url: RELAY },
        hda: { url: IMG + "slitaz-rolling-2024.iso", size: 56573952, async: false },
      };
    },
  },
  {
    id: "linuxcli",
    name: "Linux â€” terminale",
    short: "Linux (terminale)",
    desc: "Kernel Linux con console testuale, senza interfaccia grafica (circa 6 MB).",
    builtin: true,
    make_options() {
      return {
        memory_size: mem(128) * MB,
        net_device: { type: "ne2k", relay_url: RELAY },
        cdrom: { url: IMG + "linux.iso", size: 6547456, async: false },
      };
    },
  },
];

function find_profile(id) {
  return PROFILES.find((p) => p.id === id) || null;
}

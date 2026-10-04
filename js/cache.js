/* Cache delle immagini guest in IndexedDB + shim di XMLHttpRequest.
   Primo avvio: v86 scarica da i.copy.sh e tutto viene salvato nel browser.
   Avvii successivi: le immagini lette dal disco, nessun re-download.
   Interceptione limitata all'origine delle immagini (IMG in profiles.js). */

"use strict";

const IMG_CACHE_DB = "greta-os-cache";
const IMG_CACHE_STORE = "img";
const IMG_CACHE_MAX = 1.2 * 1024 * 1024 * 1024; /* niente file oltre 1,2 GB */

const ImgCache = {
  _db: null,

  async _open() {
    if (this._db) return this._db;
    this._db = await new Promise((res, rej) => {
      let rq;
      try { rq = indexedDB.open(IMG_CACHE_DB, 1); } catch (e) { rej(e); return; }
      rq.onupgradeneeded = () => rq.result.createObjectStore(IMG_CACHE_STORE);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return this._db;
  },

  async get(url) {
    try {
      const db = await this._open();
      return await new Promise((res, rej) => {
        const rq = db.transaction(IMG_CACHE_STORE, "readonly")
          .objectStore(IMG_CACHE_STORE).get(url);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) {
      return null;
    }
  },

  async put(url, blob) {
    if (!blob || !blob.size || blob.size > IMG_CACHE_MAX) return false;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        if (est.quota && est.usage !== undefined &&
            est.usage + blob.size > est.quota * 0.9) {
          console.info("cache: spazio quasi esaurito, file non salvato");
          return false;
        }
      }
      const db = await this._open();
      await new Promise((res, rej) => {
        const rq = db.transaction(IMG_CACHE_STORE, "readwrite")
          .objectStore(IMG_CACHE_STORE)
          .put({ blob, ts: Date.now(), size: blob.size }, url);
        rq.onsuccess = () => res();
        rq.onerror = () => rej(rq.error);
      });
      return true;
    } catch (e) {
      console.warn("cache: salvataggio non riuscito", e);
      return false;
    }
  },

  async clear() {
    try {
      const db = await this._open();
      await new Promise((res, rej) => {
        const rq = db.transaction(IMG_CACHE_STORE, "readwrite")
          .objectStore(IMG_CACHE_STORE).clear();
        rq.onsuccess = () => res();
        rq.onerror = () => rej(rq.error);
      });
      return true;
    } catch (e) {
      return false;
    }
  },

  async stats() {
    try {
      const db = await this._open();
      const items = await new Promise((res, rej) => {
        const rq = db.transaction(IMG_CACHE_STORE, "readonly")
          .objectStore(IMG_CACHE_STORE).getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
      let size = 0;
      for (const it of items) size += (it && it.size) || 0;
      return { count: items.length, size };
    } catch (e) {
      return { count: 0, size: 0 };
    }
  },
};

/* ================= shim XHR ================= */
(function () {
  const Orig = window.XMLHttpRequest;

  function origin_of(u) {
    try { return new URL(u, location.href).origin; } catch (e) { return ""; }
  }

  function define(xhr, name, value) {
    try {
      Object.defineProperty(xhr, name, { value, configurable: true });
    } catch (e) {}
  }

  function synthesize(xhr, blob, range) {
    (async () => {
      try {
        if (xhr.__aborted) return;
        let buf = await blob.arrayBuffer();
        let status = 200;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          if (m) {
            const start = Math.min(+m[1], buf.byteLength);
            const end = m[2] === "" ? buf.byteLength - 1
              : Math.min(+m[2], buf.byteLength - 1);
            buf = buf.slice(start, Math.max(start, end) + 1);
            status = 206;
          }
        }
        if (xhr.__aborted) return;
        define(xhr, "readyState", 4);
        define(xhr, "status", status);
        define(xhr, "statusText", status === 206 ? "Partial Content" : "OK");
        define(xhr, "response", buf);
        try { xhr.onreadystatechange && xhr.onreadystatechange({ target: xhr }); } catch (e) {}
        if (!range && xhr.onprogress) {
          try {
            xhr.onprogress({
              lengthComputable: true,
              loaded: buf.byteLength,
              total: blob.size,
              target: xhr,
            });
          } catch (e) {}
        }
        try { xhr.onload && xhr.onload({ target: xhr, type: "load" }); } catch (e) {}
        try { xhr.onloadend && xhr.onloadend({ target: xhr, type: "loadend" }); } catch (e) {}
      } catch (e) {
        console.warn("cache: replay non riuscito", e);
      }
    })();
  }

  class CachedXHR extends Orig {
    open(method, url) {
      this.__url = url;
      this.__method = String(method || "GET").toUpperCase();
      this.__range = null;
      this.__aborted = false;
      this.__cacheable = this.__method === "GET" && origin_of(url) === origin_of(IMG);
      return super.open.apply(this, arguments);
    }
    setRequestHeader(name, value) {
      if (this.__cacheable && /^range$/i.test(name)) this.__range = value;
      return super.setRequestHeader.apply(this, arguments);
    }
    send(body) {
      if (!this.__cacheable) return super.send.apply(this, arguments);
      const xhr = this;
      (async () => {
        try {
          if (!xhr.__range) {
            const hit = await ImgCache.get(xhr.__url);
            if (hit && hit.blob && hit.blob.size) {
              xhr.__hit = true;
              synthesize(xhr, hit.blob, xhr.__range);
              return;
            }
          }
          if (xhr.__aborted) return;
          if (!xhr.__range) {
            super.addEventListener("load", () => {
              try {
                if (xhr.status === 200 && xhr.response instanceof ArrayBuffer &&
                    xhr.responseType === "arraybuffer" && xhr.response.byteLength) {
                  ImgCache.put(xhr.__url, new Blob([xhr.response]));
                }
              } catch (e) {}
            });
          }
          super.send(body);
        } catch (e) {
          try { super.send(body); } catch (e2) {}
        }
      })();
    }
    abort() {
      this.__aborted = true;
      try { return super.abort(); } catch (e) {}
    }
  }

  window.XMLHttpRequest = CachedXHR;
})();

#!/usr/bin/env python3
"""Lokaler Server für den AIDA Reise-Radar (nur Standardbibliothek)."""
import argparse, json, mimetypes, os, re, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.dirname(APP_DIR)
ID_RE = re.compile(r"^[A-Z0-9]{6,14}$")
LOCK = threading.Lock()
CFG = {"root": DEFAULT_ROOT, "git": True}
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("text/javascript", ".js")


def inside(base, path):
    base = os.path.realpath(base)
    p = os.path.realpath(path)
    return p == base or p.startswith(base + os.sep)


def resolve(urlpath):
    """Liefert Dateipfad oder None. Erlaubt: app/*, data/**, merkliste.json."""
    path = unquote(urlsplit(urlpath).path)
    if "\x00" in path or "\\" in path:
        return None
    if path == "/":
        path = "/index.html"
    parts = [p for p in path.split("/") if p]
    if any(p in (".", "..") for p in parts):
        return None
    root = CFG["root"]
    if parts and (parts[0] == "data" or parts == ["merkliste.json"]):
        base, rel = root, parts
    else:
        base, rel = APP_DIR, parts
    full = os.path.join(base, *rel)
    allowed = os.path.join(root, "data") if base == root and rel[0] == "data" else base
    if base == root and rel == ["merkliste.json"]:
        allowed = root
    if not inside(allowed, full) or not os.path.isfile(full):
        return None
    if base == APP_DIR and os.path.splitext(full)[1].lower() not in (".html", ".js", ".css", ".svg", ".ico", ".png"):
        return None
    return full


def git(*args):
    r = subprocess.run(["git", *args], cwd=CFG["root"], capture_output=True, text=True, timeout=120)
    return r.returncode, (r.stderr or r.stdout).strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "AidaRadar/1.0"

    def log_message(self, fmt, *a):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        raw = unquote(urlsplit(self.path).path)
        if ".." in raw.split("/") or "\\" in raw or "\x00" in raw:
            return self.send_json(403, {"fehler": "Verboten"})
        f = resolve(self.path)
        if not f:
            return self.send_json(404, {"fehler": "Nicht gefunden"})
        ctype = mimetypes.guess_type(f)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/json",):
            ctype += "; charset=utf-8"
        with open(f, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlsplit(self.path).path != "/api/merkliste":
            return self.send_json(404, {"fehler": "Nicht gefunden"})
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return self.send_json(403, {"fehler": "Verboten"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 1_000_000:
                raise ValueError
            data = json.loads(self.rfile.read(n) or b"{}")
            reisen = data["reisen"]
            if not isinstance(reisen, list) or not all(isinstance(x, str) and ID_RE.match(x) for x in reisen):
                raise ValueError
        except Exception:
            return self.send_json(400, {"fehler": "Ungültige Merkliste"})
        reisen = list(dict.fromkeys(reisen))
        with LOCK:
            fn = os.path.join(CFG["root"], "merkliste.json")
            tmp = fn + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"reisen": reisen}, fh, ensure_ascii=False, indent=1)
                fh.write("\n")
            os.replace(tmp, fn)
            if not CFG["git"]:
                return self.send_json(200, {"ok": True, "reisen": reisen, "git": False})
            try:
                rc, out = git("add", "merkliste.json")
                if rc == 0:
                    rc, out = git("commit", "-m", "Merkliste aktualisiert")
                    if rc != 0 and "nothing to commit" in out + "":
                        rc = 0
                    elif rc != 0 and "nichts zu committen" in out:
                        rc = 0
                if rc != 0:
                    return self.send_json(200, {"ok": True, "reisen": reisen, "warnung": "Lokal gespeichert, Commit fehlgeschlagen: " + out[:200]})
                rc, out = git("push")
                if rc != 0:
                    return self.send_json(200, {"ok": True, "reisen": reisen, "warnung": "Lokal gespeichert, Push fehlgeschlagen: " + out[:200]})
            except Exception as e:
                return self.send_json(200, {"ok": True, "reisen": reisen, "warnung": "Lokal gespeichert, Git-Fehler: %s" % e})
        self.send_json(200, {"ok": True, "reisen": reisen})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-git", action="store_true")
    a = ap.parse_args()
    CFG["root"] = os.path.abspath(a.root)
    CFG["git"] = not a.no_git
    if CFG["git"]:
        try:
            rc, out = git("pull", "--rebase", "-q")
            if rc != 0:
                print("Hinweis: git pull fehlgeschlagen:", out[:300])
        except Exception as e:
            print("Hinweis: git pull nicht möglich:", e)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print("AIDA Reise-Radar läuft: http://127.0.0.1:%d  (Daten: %s)" % (a.port, CFG["root"]), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

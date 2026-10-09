"""Ergänzt data/ports.json um Koordinaten für alle Hafencodes im Katalog (UN/LOCODE)."""
import csv
import io
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
SRC = "https://raw.githubusercontent.com/datasets/un-locode/main/data/code-list.csv"


def coord(s):
    """'4234N 00135E' -> (42.567, 1.583)"""
    m = re.match(r"(\d{2})(\d{2})([NS])\s+(\d{3})(\d{2})([EW])", s or "")
    if not m:
        return None
    lat = int(m[1]) + int(m[2]) / 60
    lon = int(m[4]) + int(m[5]) / 60
    return round(-lat if m[3] == "S" else lat, 4), round(-lon if m[6] == "W" else lon, 4)


def osm(name, country):
    """Ersatz über OpenStreetMap Nominatim (max. 1 Anfrage/s laut Nutzungsregeln)."""
    time.sleep(1.1)
    q = urllib.parse.urlencode({"q": re.sub(r"\s*\(.*?\)", "", name), "countrycodes": country.lower(),
                                "format": "json", "limit": 1})
    req = urllib.request.Request(f"https://nominatim.openstreetmap.org/search?{q}",
                                 headers={"User-Agent": "aida-reise-check (privat)"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            hit = json.loads(r.read())
        return (round(float(hit[0]["lat"]), 4), round(float(hit[0]["lon"]), 4)) if hit else None
    except Exception:
        return None


def main():
    catalog = json.loads((DATA / "catalog.json").read_text())
    ports_file = DATA / "ports.json"
    ports = json.loads(ports_file.read_text()) if ports_file.exists() else {}
    codes = {}
    for j in catalog["journeys"]:
        for s in j.get("itinerary", []):
            if s.get("code"):
                codes[s["code"]] = s.get("name")
    codes.pop("SEE", None)  # Seetag
    missing = [c for c in codes if c not in ports or ports[c].get("lat") is None]
    if not missing:
        print("Häfen: alle bekannt")
        return
    with urllib.request.urlopen(SRC, timeout=60) as r:
        rows = csv.DictReader(io.StringIO(r.read().decode("utf-8")))
        index = {r["Country"] + r["Location"]: r for r in rows}
    for c in missing:
        row = index.get(c)
        ll = coord(row["Coordinates"]) if row else None
        if not ll:
            ll = osm(codes[c], c[:2])
        ports[c] = {"name": codes[c], "lat": ll[0] if ll else None, "lon": ll[1] if ll else None}
    ports_file.write_text(json.dumps(ports, ensure_ascii=False, indent=0, sort_keys=True))
    print(f"Häfen: {len(missing)} neu, davon ohne Koordinaten: "
          f"{[c for c in missing if ports[c]['lat'] is None]}")


if __name__ == "__main__":
    main()

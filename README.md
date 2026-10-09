# AIDA Reise-Radar

Liest den kompletten AIDA-Katalog von aida.de aus: alle Abfahrten mit Route, Preisen je Kabinenart und Tarif und den **freien Kabinen je Unterkategorie** (Kabinennummer, Deck, Lage). Dazu gibt es eine lokale Web-App zum Filtern und Vergleichen.

## Inhalt

| Ordner | Inhalt |
|---|---|
| `crawler/crawl.py` | Abruf: Katalog → Details/Preise → Schiffspläne → freie Kabinen |
| `crawler/ports.py` | Hafen-Koordinaten (UN/LOCODE, Ersatz über OpenStreetMap) |
| `app/` | Lokale Web-App (`serve.py` + HTML/JS, keine Abhängigkeiten außer Python) |
| `data/` | Letzter Datenstand (`catalog.json`, `cabins/`, `ships/`, `history/`, `changes/`) |
| `.github/workflows/daily.yml` | GitHub-Action für den Abruf, **täglicher Zeitplan ist abgeschaltet** |

## App starten

```bash
python3 app/serve.py          # http://127.0.0.1:8765
python3 app/serve.py --no-git # ohne git pull / Merkliste-Push
```

Auf dem Mac geht es auch per Doppelklick auf `App starten.command`.

## Abruf selbst ausführen

Der Abruf braucht einen **echten Browser mit Fenster**. aida.de (Akamai) sperrt einfache HTTP-Abfragen und unsichtbare Browser.

```bash
pip install playwright==1.48.0 && python -m playwright install chromium
python3 crawler/crawl.py --limit 20 --minutes 5   # kurzer Test
python3 crawler/crawl.py --minutes 120            # alles
python3 crawler/ports.py
```

Auf einem Linux-Server ohne Bildschirm: `xvfb-run -a python crawler/crawl.py …`. So läuft es auch in der GitHub-Action.

Optionen:

| Option | Bedeutung |
|---|---|
| `--minutes` | Zeitbudget für den ganzen Lauf |
| `--only-cabins` | Preise nicht erneuern, nur freie Kabinen zählen |
| `--conc` | gleichzeitige Anfragen (Standard 3) |
| `--delay` | Pause je Strang in Sekunden |

`merkliste.json` legt Reisen fest, deren Kabinen bei jedem Lauf gezählt werden. Alle anderen Reisen werden reihum gezählt, die am längsten nicht gezählten zuerst.

**Dauer:** Auf GitHub-Servern brauchen die Preise aller ca. 2.000 Reisen etwa 25 Minuten, die freien Kabinen etwa 4 Sekunden pro Reise.

## Täglichen Abruf einrichten

In `.github/workflows/daily.yml` den auskommentierten `schedule`-Block wieder aktivieren. Er startet um 06:00 deutscher Zeit, ein Prüfschritt sorgt für einen Lauf pro Tag. Achtung: Bei privaten Repos sind die kostenlosen Actions-Minuten begrenzt.

## Genutzte Schnittstellen (dieselben wie auf aida.de)

| Abfrage | Inhalt |
|---|---|
| `search.singleCruise.json/size=3000/…` | alle Abfahrten in einer Abfrage. Blättern geht nur in Pfadform, `?p=` wird ignoriert |
| `detail.cruise.json/…/JourneyIdentifier=<ID>.json` | Route, Kategorien, Preise je Tarif und Flughafen |
| `detail.cabins.json/shipName=<Schiff>/variation=<V>.json` | Schiffsplan mit allen Kabinen |
| `player.proxy.json?subCategoryCall` (POST) | buchbare PREMIUM-Unterkategorien mit Preis |
| `booking.proxy.json?cabinListCall=<Unterkat>` (POST) | freie Kabinen der Unterkategorie (Nummer, Deck, Lage) |

Tempo bitte maßvoll halten. Zu viele gleichzeitige Anfragen führen zu einer Sperre.

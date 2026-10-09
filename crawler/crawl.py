"""Täglicher AIDA-Abruf: Katalog, Preise je Kabinenkategorie, freie Kabinen je Unterkategorie.

Nutzt einen normalen Browser (Playwright, mit Fenster bzw. xvfb auf GitHub) und ruft
dieselben Schnittstellen ab, die aida.de selbst lädt. Gemächliches Tempo, eine Anfrage
nach der anderen.

Aufruf:  python crawler/crawl.py [--limit N] [--minutes M]
"""
import argparse
import datetime as dt
import json
import random
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
API = "/content/aida-search-and-booking/requests/"
BERLIN = ZoneInfo("Europe/Berlin")
TARIFFS = {  # Schlüssel in detail.cruise.json -> Anzeigename
    "lig": "LIGHT", "cla": "CLASSIC", "ind": "PREMIUM",
    "claAl": "CLASSIC ALL IN", "indAl": "PREMIUM ALL IN", "comAl": "COMFORT ALL IN",
    "pau": "PAUSCHAL", "pauAl": "PAUSCHAL ALL IN", "see": "SEA", "seeAl": "SEA ALL IN",
}
ADULTS = 2
PAX_AGES = [40] * ADULTS


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


class Aida:
    def __init__(self, page, delay):
        self.page, self.delay, self.calls, self.errors = page, delay, 0, 0

    def _call(self, method, url, body=None, retries=2):
        status = None
        for attempt in range(retries + 1):
            time.sleep(self.delay + random.uniform(0, self.delay / 2))
            status, text = self.page.evaluate(
                """async ([m,u,b]) => {
                    const o = {method:m, headers:{'Accept':'application/json'}};
                    if (b) { o.body = b; o.headers['Content-Type'] = 'application/json'; }
                    try { const r = await fetch(u, o); return [r.status, await r.text()]; }
                    catch (e) { return [0, String(e)]; }
                }""",
                [method, url, json.dumps(body) if body else None],
            )
            self.calls += 1
            if status == 200:
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    pass
            if status == 403:
                raise RuntimeError("403 von aida.de – Abruf gesperrt, Lauf wird beendet")
            time.sleep(5 * (attempt + 1))
        self.errors += 1
        log(f"  FEHLER {status} {url[:120]}")
        return None

    def parallel(self, reqs, conc=3):
        """Mehrere Anfragen, höchstens `conc` gleichzeitig, je Strang mit Pause.
        reqs: [(method, url, body)] -> [json|None] in gleicher Reihenfolge."""
        if not reqs:
            return []
        res = self.page.evaluate(
            """async ([reqs, conc, pause]) => {
                const out = new Array(reqs.length); let next = 0;
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                async function worker() {
                    while (next < reqs.length) {
                        const i = next++; const [m, u, b] = reqs[i];
                        const o = {method:m, headers:{'Accept':'application/json'}};
                        if (b) { o.body = b; o.headers['Content-Type'] = 'application/json'; }
                        try { const r = await fetch(u, o); out[i] = [r.status, await r.text()]; }
                        catch (e) { out[i] = [0, String(e)]; }
                        await sleep(pause * (1 + Math.random() / 2));
                    }
                }
                await Promise.all(Array.from({length: Math.min(conc, reqs.length)}, worker));
                return out;
            }""",
            [[[m, u, json.dumps(b) if b else None] for m, u, b in reqs], conc, int(self.delay * 1000)],
        )
        self.calls += len(reqs)
        out = []
        for (m, u, b), (status, text) in zip(reqs, res):
            if status == 403:
                raise RuntimeError("403 von aida.de – Abruf gesperrt, Lauf wird beendet")
            data = None
            if status == 200:
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    pass
            out.append(data if data is not None else self._call(m, u, b))  # Fehler einzeln nachholen
        return out

    def get(self, path):
        return self._call("GET", API + path)

    def post(self, path, body):
        return self._call("POST", API + path, body)

    # --- Schnittstellen -------------------------------------------------
    def catalog(self, size=3000):
        # Pfadform wie auf aida.de (getCachableEndpointFormat); Blättern per p wird ignoriert,
        # daher alles in einer Abfrage
        return self.get(f"search.singleCruise.json/size={size}/sortCriteria=Price/sortDirection=Asc/"
                        f"pax[adults]={ADULTS}/pax[juveniles]=0/pax[children]=0/pax[babies]=0.json")

    def req_detail(self, jid):
        return ("GET", API + f"detail.cruise.json/adults={ADULTS}/juveniles=0/children=0/babies=0/"
                f"JourneyIdentifier={jid}.json", None)

    def ship_plan(self, ship, variation):
        return self.get(f"detail.cabins.json/shipName={ship}/variation={variation}.json")

    def req_subcategories(self, jid, tariff="IND"):
        today = dt.date.today().isoformat()
        return ("POST", API + "player.proxy.json?subCategoryCall", {
            "cruise": {"journeyIdentifier": [jid], "tariffTypes": [tariff]},
            "paging": {"entity": "Route", "resultsFrom": 1, "resultsTotal": 20},
            "detailLevel": ["PriceDetails"], "productTypes": ["Cruise", "CruisePackage"],
            "flight": {"allowOpenJaw": False, "allowOneway": True},
            "period": {"start": {"preOffset": 0, "date": today, "postOffset": 999}},
            "composition": "none",
            "passengers": [{"id": i + 1, "age": a} for i, a in enumerate(PAX_AGES)],
        })

    def req_cabin_list(self, jid, start, end, subcat, tariff="IND"):
        # Gleicher Aufbau wie die Anfrage der AIDA-Buchungsseite selbst
        today = dt.date.today().isoformat()
        ctx = {"requestor": {"agency": {"agencyID": "30449"}, "agent": {"id": "GOOFY", "name": ""}},
               "messageContext": {"touroperatorSessionID": "", "transactionCounter": 0,
                                  "touroperatorCode": "AIDA", "touroperatorBrand": "AID",
                                  "discriminator": "GlobalMessageContext"},
               "timeStamp": today, "discriminator": "StringRequestType"}

        def wrap(req):
            return {"version": "4", "content": {"contentType": "text/json", "stringRequest": req},
                    "discriminator": "StringVersionSpecificRequestType"}

        action = {
            "startDate": start, "endDate": end,
            "requestedTraveller": [{"id": i + 1, "age": a} for i, a in enumerate(PAX_AGES)],
            "product": {"code": jid, "discriminator": "ProductCodeRequestType"},
            "cruiseCategoryCode": {"code": tariff, "discriminator": "CruiseCategoryCodeRequestType"},
            "cabinCategoryCode": {"code": subcat, "discriminator": "CabinCategoryCodeRequestType"},
            "attributes": [{"code": "CPLFilter", "value": "N"}],
            "discriminator": "SearchCruiseCabinsRequestType",
        }
        body = {"routingHeader": {"routingHeader": {"operatorSystemRouting": "", "gdsAgency": "30449"},
                                  "payload": wrap(ctx), "operatorSystemCode": "AIDA"},
                "payload": wrap({**ctx, "requestedAction": action})}
        return ("POST", API + f"booking.proxy.json?cabinListCall={subcat}", body)


# --- Aufbereitung -----------------------------------------------------------
def parse_catalog_item(item, variant):
    return {
        "id": variant["journeyIdentifier"],
        "title": item.get("title") or item.get("routeGroupCode"),
        "routeCode": item.get("routeCode"),
        "routeGroupId": item.get("yieldRouteCode"),
        "ship": variant["ship"]["name"], "shipCode": variant["ship"]["code"],
        "shipVariation": variant.get("shipVariation"),
        "start": variant["startDate"], "end": variant["endDate"], "nights": variant["duration"],
        "from": variant.get("fromCity"), "to": variant.get("toCity"),
        "ports": [p.get("marketingName") or p.get("name") if isinstance(p, dict) else p
                  for p in item.get("ports", [])],
        "fromPricePP": variant.get("amountPerPerson"), "fromTariff": variant.get("tariffType"),
        "flightIncluded": variant.get("flightIncluded"),
        "notes": variant.get("notes", []),
        "campaigns": [c.get("name") for c in variant.get("campaigns", []) if c.get("name")],
        "image": variant.get("imageUrl"),
        "bookingLink": "https://aida.de/buchen" + variant["bookingLink"] if variant.get("bookingLink") else None,
    }


def parse_detail(d):
    out = {
        "region": d.get("region"),
        "available": d.get("isCruiseAvailable"),
        "itinerary": [{
            "day": s.get("day"), "code": s.get("code"), "name": s.get("name"),
            "arr": s.get("arrivalDateTime") or None, "dep": s.get("departureDateTime") or None,
            "tender": s.get("isTenderPort"), "scenic": s.get("isScenicPort"), "link": s.get("link"),
        } for s in d.get("itinerary", [])],
        "mapImage": (d.get("imageUrl") or {}).get("mapImage"),
        "categories": [],
    }
    for c in d.get("cabinItemsVariant", []):
        cat = {"code": c.get("cabinCode"), "name": c.get("cabinName"), "tariffs": {}}
        for key, label in TARIFFS.items():
            t = c.get(key)
            if not isinstance(t, dict) or not t.get("prices"):
                continue
            prices = t["prices"]
            cabin = [p["cabinAmount"] for p in prices if p.get("cabinAmount")]
            flights = [p for p in prices if p.get("flightIncluded") and p.get("amount")
                       and p.get("flightDirection") == "two-way"]  # Hin- und Rückflug
            best_f = min(flights, key=lambda p: p["amount"]) if flights else None
            cat["tariffs"][label] = {
                "cabin": min(cabin) if cabin else None,  # Kabinenpreis ohne Flug, gesamt
                "withFlight": best_f["amount"] if best_f else None,
                "flightFrom": best_f.get("departureAirport") if best_f else None,
                "campaigns": sorted({x.get("name") for p in prices
                                     for x in p.get("campaigns") or [] if x.get("name")}),
            }
        if cat["tariffs"]:
            out["categories"].append(cat)
    return out


def parse_subcategories(resp):
    """PREMIUM-Unterkategorien, die buchbar sind, mit günstigstem Preis ohne/mit Flug."""
    if not resp:
        return None
    variants = {}
    for s in resp.get("services", []):
        for v in (s.get("cruiseService") or {}).get("cruiseVariants", []):
            variants[(s["id"], v["id"])] = v["cabin"]
    subs = {}
    for prod in resp.get("products", []):
        refs = prod.get("serviceReferences", [])
        cruise_refs = [r for r in refs if (r.get("serviceId"), r.get("serviceVariantId")) in variants]
        if not cruise_refs:
            continue
        cab = variants[(cruise_refs[0].get("serviceId"), cruise_refs[0].get("serviceVariantId"))]
        amount = (prod.get("priceInformation") or {}).get("amount")
        e = subs.setdefault(cab["cabinCode"], {"name": cab.get("cabinName"), "type": cab.get("cabinType"),
                                               "price": None, "priceWithFlight": None})
        k = "price" if len(refs) == len(cruise_refs) else "priceWithFlight"
        if amount and (e[k] is None or amount < e[k]):
            e[k] = amount
    for v in variants.values():  # Unterkategorien ohne Preisprodukt trotzdem aufnehmen
        subs.setdefault(v["cabinCode"], {"name": v.get("cabinName"), "type": v.get("cabinType"),
                                         "price": None, "priceWithFlight": None})
    return subs


def parse_cabin_list(resp):
    if not resp:
        return None
    try:
        cabins = resp["payload"]["content"]["stringResponse"]["actionResult"].get("cabins", [])
    except (KeyError, TypeError):
        return None
    out, states = [], {}
    for c in cabins:
        cab = c.get("cabin", {})
        states[cab.get("state")] = states.get(cab.get("state"), 0) + 1
        if cab.get("state") != "Available":
            continue
        out.append({"n": cab.get("number"), "deck": cab.get("deck"),
                    "attrs": [a.get("value") for a in c.get("attributes", []) if a.get("value")]})
    return out, states


def parse_ship_plan(plan):
    cabins = []
    for c in plan or []:
        fp = (c.get("cabin_category_specification") or {}).get("cabin_floor_plan") or ""
        cabins.append({
            "n": str(c.get("cabin_number")), "deck": c.get("deck"), "size": c.get("cabin_size"),
            "balcony": c.get("balcony"), "balconyType": c.get("balcony_type") or None,
            "balconySize": c.get("balcony_size") or None, "maxPax": c.get("maximum_occupancy"),
            "doubleBed": c.get("double_bed"), "connecting": c.get("connecting_door"),
            "nearStairs": c.get("close_to_stairs"), "floorPlan": fp.rsplit("/", 1)[-1] or None,
        })
    return cabins


def cat_prices(j):
    """{'I': {'name':..., 'price': günstigster Kabinenpreis ohne Flug über alle Tarife}}"""
    out = {}
    for c in j.get("categories", []):
        vals = [t["cabin"] for t in c["tariffs"].values() if t.get("cabin")]
        if vals:
            out[c["code"]] = {"name": c["name"], "price": min(vals)}
    return out


def build_changes(prev, cur, today, partial=False):
    ch = {"date": today, "new": [], "gone": [], "price": [], "categoryGone": [], "categoryBack": []}
    for jid, j in cur.items():
        if jid not in prev:
            ch["new"].append(jid)
            continue
        if j.get("stale"):
            continue
        a, b = cat_prices(prev[jid]), cat_prices(j)
        for code, v in b.items():
            if code in a and a[code]["price"] != v["price"]:
                ch["price"].append({"id": jid, "cat": code, "name": v["name"],
                                    "old": a[code]["price"], "new": v["price"]})
            elif code not in a and a:
                ch["categoryBack"].append({"id": jid, "cat": code, "name": v["name"], "price": v["price"]})
        for code, v in a.items():
            if code not in b:
                ch["categoryGone"].append({"id": jid, "cat": code, "name": v["name"]})
    if not partial:
        ch["gone"] = [{"id": jid, "title": prev[jid].get("title"), "start": prev[jid].get("start"),
                       "ship": prev[jid].get("ship")} for jid in prev if jid not in cur]
    return ch


def update_history(result, today):
    for j in result:
        f = DATA / "history" / f"{j['id']}.json"
        h = load(f, {"prices": {}, "free": {}})
        p = {k: v["price"] for k, v in cat_prices(j).items()}
        last_p = h["prices"][max(h["prices"])] if h["prices"] else None
        if p and p != last_p:
            h["prices"][today] = p
        c = load(DATA / "cabins" / f"{j['id']}.json", None)
        if c and c["fetched"].startswith(today):
            h["free"][today] = {k: s.get("free") for k, s in c["subcategories"].items()}
        if h["prices"] or h["free"]:
            save(f, h)


# --- Ablauf -----------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="nur N Reisen (Test)")
    ap.add_argument("--minutes", type=float, default=60, help="Zeitbudget gesamt")
    ap.add_argument("--delay", type=float, default=0.3, help="Pause zwischen Anfragen je Strang (s)")
    ap.add_argument("--detail-delay", type=float, default=0.3, help="Pause zwischen Detailabrufen (s)")
    ap.add_argument("--conc", type=int, default=3, help="gleichzeitige Anfragen (maßvoll halten)")
    ap.add_argument("--only-cabins", action="store_true", help="Details nicht erneuern, nur Kabinen zählen")
    args = ap.parse_args()

    t0 = time.time()
    deadline = t0 + args.minutes * 60
    now = dt.datetime.now(BERLIN)
    today = now.date().isoformat()
    watch = set(load(ROOT / "merkliste.json", {"reisen": []}).get("reisen", []))
    prev = {j["id"]: j for j in load(DATA / "catalog.json", {"journeys": []}).get("journeys", [])}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_context(locale="de-DE", viewport={"width": 1400, "height": 900}).new_page()
        page.goto("https://aida.de/", wait_until="domcontentloaded", timeout=90000)
        page.wait_for_timeout(4000)
        r = page.goto("https://aida.de/buchung/last-minute-kreuzfahrten",
                      wait_until="domcontentloaded", timeout=90000)
        page.wait_for_timeout(6000)
        if not r or r.status != 200:
            sys.exit(f"aida.de nicht erreichbar (Status {r.status if r else '-'})")
        aida = Aida(page, args.delay)

        # 1) Katalog
        journeys = {}
        res = aida.catalog() or {}
        for item in res.get("cruiseItems", []):
            for v in item.get("cruiseItemVariant", []):
                j = parse_catalog_item(item, v)
                journeys.setdefault(j["id"], j)
        # nach Abreise sortieren, damit --limit die nächsten Reisen nimmt
        ids = sorted(journeys, key=lambda k: journeys[k]["start"])[: args.limit or None]
        total = res.get("resultsTotal") or 0
        log(f"Katalog: {len(journeys)} Abfahrten (gemeldet: {total})")
        if not journeys or len(journeys) < 0.95 * total or (not args.limit and len(journeys) < 0.8 * len(prev)):
            sys.exit(f"Katalog unvollständig ({len(journeys)} von {total}, vorher {len(prev)}) – nichts überschrieben")

        # 2) Details + Preise je Abfahrt: fehlende und älteste zuerst, bis 75 % des Zeitbudgets.
        #    Nicht erneuerte Reisen behalten den letzten Stand (stale) und kommen morgen zuerst.
        detail_deadline = t0 if args.only_cabins else t0 + args.minutes * 60 * 0.75
        order = sorted(ids, key=lambda k: (prev.get(k, {}).get("detailAt", ""), journeys[k]["start"]))
        done = 0
        aida.delay = args.detail_delay
        for k in range(0, len(order), 12):
            chunk = order[k:k + 12]
            fetched = (aida.parallel([aida.req_detail(j) for j in chunk], args.conc)
                       if time.time() < detail_deadline else [None] * len(chunk))
            for jid, d in zip(chunk, fetched):
                if d:
                    journeys[jid].update(parse_detail(d), detailAt=now.isoformat(timespec="minutes"))
                    done += 1
                elif jid in prev:  # nicht erneuert -> letzten Stand behalten
                    for key in ("region", "itinerary", "categories", "mapImage", "detailAt"):
                        if key in prev[jid]:
                            journeys[jid][key] = prev[jid][key]
                    if not args.only_cabins:
                        journeys[jid]["stale"] = True
            if fetched[0] is not None and (k // 12) % 10 == 9:
                log(f"Details {done}/{len(ids)} – {aida.calls} Anfragen, {(time.time()-t0)/60:.0f} min")
        aida.delay = args.delay
        log(f"Details erneuert: {done}/{len(ids)} Abfahrten, {(time.time()-t0)/60:.0f} min")

        # 3) Schiffspläne (einmalig je Schiff/Variante)
        for ship, var in sorted({(journeys[j]["ship"], journeys[j]["shipVariation"]) for j in ids}):
            f = DATA / "ships" / f"{ship}-{var}.json"
            if f.exists():
                continue
            plan = aida.ship_plan(ship, var)
            if plan:
                save(f, {"ship": ship, "variation": var, "fetched": today, "cabins": parse_ship_plan(plan)})
                log(f"Schiffsplan {ship}-{var}: {len(plan)} Kabinen")

        # 4) Freie Kabinen: Merkliste zuerst, dann reihum (älteste Zählung zuerst)
        def last_counted(jid):
            return load(DATA / "cabins" / f"{jid}.json", {}).get("fetched", "")
        order = sorted(ids, key=lambda j: (j not in watch, last_counted(j), journeys[j]["start"]))
        counted = 0
        for k in range(0, len(order), 3):
            chunk = [jid for jid in order[k:k + 3] if jid in watch or time.time() < deadline - 120]
            if not chunk:
                break
            subs_list = [parse_subcategories(r) for r in
                         aida.parallel([aida.req_subcategories(jid) for jid in chunk], args.conc)]
            reqs, keys = [], []
            for jid, subs in zip(chunk, subs_list):
                for code in subs or {}:
                    j = journeys[jid]
                    reqs.append(aida.req_cabin_list(jid, j["start"], j["end"], code))
                    keys.append((jid, code))
            lists = dict(zip(keys, aida.parallel(reqs, args.conc)))
            for jid, subs in zip(chunk, subs_list):
                if subs is None:
                    continue
                for code, s in subs.items():
                    cabins, states = parse_cabin_list(lists.get((jid, code))) or (None, None)
                    s["free"] = len(cabins) if cabins is not None else None
                    s["cabins"] = cabins
                    s["states"] = states
                save(DATA / "cabins" / f"{jid}.json", {"id": jid, "fetched": now.isoformat(timespec="minutes"),
                                                      "tariff": "PREMIUM", "subcategories": subs})
                counted += 1
                if counted % 100 == 0:
                    log(f"Kabinen {counted} Abfahrten – {aida.calls} Anfragen, {(time.time()-t0)/60:.0f} min")
        log(f"Freie Kabinen gezählt: {counted} Abfahrten")
        browser.close()

    # 5) Speichern, Verlauf, Änderungen
    result = [journeys[j] for j in ids]
    for j in result:
        c = load(DATA / "cabins" / f"{j['id']}.json", None)
        if c:
            j["freeCabins"] = sum(s.get("free") or 0 for s in c["subcategories"].values())
            j["freeCountedAt"] = c["fetched"]
            # False = buchbar, aber keine Wunschkabine mehr wählbar (Kabine wird zugeteilt)
            j["cabinChoice"] = any(s.get("states") for s in c["subcategories"].values())
    save(DATA / "catalog.json", {"updated": now.isoformat(timespec="minutes"), "adults": ADULTS,
                                 "journeys": result})
    if not args.only_cabins:  # Änderungen nur aus vollen Läufen
        save(DATA / "changes" / f"{today}.json",
             build_changes(prev, {j["id"]: j for j in result}, today, partial=bool(args.limit)))
    update_history(result, today)
    save(DATA / "meta.json", {"lastRun": today, "updated": now.isoformat(timespec="minutes"),
                              "journeys": len(result), "calls": aida.calls, "errors": aida.errors,
                              "minutes": round((time.time() - t0) / 60, 1), "detailsRefreshed": done,
                              "cabinsCounted": counted})
    log(f"Fertig: {aida.calls} Anfragen, {aida.errors} Fehler, {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()

# Testlauf: Ist aida.de von GitHub-Servern aus mit einem normalen Browser erreichbar?
from playwright.sync_api import sync_playwright

URLS = [
    "https://aida.de/",
    "https://aida.de/buchung/last-minute-kreuzfahrten",
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page(locale="de-DE")
    for url in URLS:
        try:
            r = page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)
            print(f"{r.status if r else '-'}  {page.title()[:70]}  <- {url}")
        except Exception as e:
            print(f"FEHLER  {str(e)[:100]}  <- {url}")
    browser.close()

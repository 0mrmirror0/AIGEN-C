import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests

MONTHS = {
    'January': 'gennaio', 'February': 'febbraio', 'March': 'marzo', 'April': 'aprile',
    'May': 'maggio', 'June': 'giugno', 'July': 'luglio', 'August': 'agosto',
    'September': 'settembre', 'October': 'ottobre', 'November': 'novembre', 'December': 'dicembre',
}

def format_date(raw: str) -> str:
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', raw or '')
    if m:
        return f'{m.group(3)}/{m.group(2)}/{m.group(1)}'
    m = re.match(r'([A-Za-z]+)\s+(\d{1,2})', raw or '')
    if m:
        return f"{int(m.group(2))} {MONTHS.get(m.group(1), m.group(1))}"
    return 'News'

def clean_html(s: str) -> str:
    s = re.sub(r'<br\s*/?>', ' ', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = re.sub(r'https?://\S+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def from_telegram_html(limit=3):
    r = requests.get('https://t.me/s/AIGEN_C', headers={'User-Agent':'Mozilla/5.0'}, timeout=25)
    r.raise_for_status()
    items=[]
    for m in re.finditer(r'<div class="tgme_widget_message_wrap.*?(?=<div class="tgme_widget_message_wrap|</main>)', r.text, re.S):
        block=m.group(0)
        tm=re.search(r'<div class="tgme_widget_message_text[^>]*>(.*?)</div>', block, re.S)
        lm=re.search(r'<a class="tgme_widget_message_date" href="([^"]+)"', block)
        dm=re.search(r'<time datetime="([^"]+)"', block)
        if not (tm and lm):
            continue
        text=clean_html(tm.group(1))
        if len(text)<30:
            continue
        items.append({'title': format_date(dm.group(1) if dm else ''), 'text': text[:220]+('…' if len(text)>220 else ''), 'url': html.unescape(lm.group(1))})
    return list(reversed(items[-limit:]))

items = from_telegram_html()
Path('news.json').write_text(json.dumps({'updatedAt': datetime.now(timezone.utc).isoformat(), 'items': items}, ensure_ascii=False, indent=2) + '\n')
print(f'Wrote {len(items)} items')

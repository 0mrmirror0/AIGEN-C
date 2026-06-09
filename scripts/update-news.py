import hashlib
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests

CHANNEL = 'AIGEN_C'
FEED_URL = f'https://t.me/s/{CHANNEL}'
MEDIA_DIR = Path('assets/news/telegram')
USER_AGENT = 'Mozilla/5.0 (compatible; AIGEN-C-news-updater/1.0)'

MONTHS = {
    'January': 'gennaio', 'February': 'febbraio', 'March': 'marzo', 'April': 'aprile',
    'May': 'maggio', 'June': 'giugno', 'July': 'luglio', 'August': 'agosto',
    'September': 'settembre', 'October': 'ottobre', 'November': 'novembre', 'December': 'dicembre',
}

EXT_BY_TYPE = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
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

def post_id_from_url(url: str) -> str:
    m = re.search(r'/(\d+)(?:\?|$)', url or '')
    return m.group(1) if m else hashlib.sha1(url.encode()).hexdigest()[:10]

def media_candidates(block: str):
    candidates = []

    # Telegram public pages expose photos and video thumbnails as CSS background images.
    for m in re.finditer(r"background-image:url\('([^']+)'\)", block):
        url = html.unescape(m.group(1))
        start = max(0, m.start() - 500)
        context = block[start:m.start()]
        media_type = 'video' if 'video' in context.lower() else 'image'
        candidates.append({'type': media_type, 'sourceUrl': url})

    # Fallback for poster attributes if Telegram changes video markup.
    for m in re.finditer(r'<video[^>]+poster="([^"]+)"', block):
        candidates.append({'type': 'video', 'sourceUrl': html.unescape(m.group(1))})

    # De-duplicate while preserving order.
    seen = set()
    unique = []
    for item in candidates:
        if item['sourceUrl'] in seen:
            continue
        seen.add(item['sourceUrl'])
        unique.append(item)
    return unique

def download_media(item: dict, post_id: str):
    source = item['sourceUrl']
    try:
        r = requests.get(source, headers={'User-Agent': USER_AGENT}, timeout=25)
        r.raise_for_status()
    except requests.RequestException as exc:
        print(f'Skip media for post {post_id}: {exc}')
        return None

    ctype = (r.headers.get('content-type') or '').split(';', 1)[0].lower()
    ext = EXT_BY_TYPE.get(ctype)
    if not ext:
        parsed_ext = Path(urlparse(source).path).suffix.lower()
        ext = parsed_ext if parsed_ext in {'.jpg', '.jpeg', '.png', '.webp', '.gif'} else '.jpg'

    digest = hashlib.sha1(r.content).hexdigest()[:10]
    target_dir = MEDIA_DIR / post_id
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f'{item["type"]}-{digest}{ext}'
    if not target.exists():
        target.write_bytes(r.content)

    return {
        'type': item['type'],
        'url': '/' + target.as_posix(),
    }

def from_telegram_html(limit=3):
    r = requests.get(FEED_URL, headers={'User-Agent': USER_AGENT}, timeout=25)
    r.raise_for_status()
    raw_items=[]
    for m in re.finditer(r'<div class="tgme_widget_message_wrap.*?(?=<div class="tgme_widget_message_wrap|</main>)', r.text, re.S):
        block=m.group(0)
        tm=re.search(r'<div class="tgme_widget_message_text js-message_text"[^>]*>(.*?)</div>', block, re.S)
        lm=re.search(r'<a class="tgme_widget_message_date" href="([^"]+)"', block)
        dm=re.search(r'<time datetime="([^"]+)"', block)
        if not (tm and lm):
            continue
        text=clean_html(tm.group(1))
        if len(text)<30:
            continue

        url = html.unescape(lm.group(1))
        raw_items.append({
            'title': format_date(dm.group(1) if dm else ''),
            'text': text[:220]+('…' if len(text)>220 else ''),
            'url': url,
            'postId': post_id_from_url(url),
            'candidates': media_candidates(block),
        })

    items=[]
    for raw in reversed(raw_items[-limit:]):
        candidates = raw.pop('candidates')
        post_id = raw.pop('postId')
        if candidates:
            media = download_media(candidates[0], post_id)
            if media:
                raw['media'] = media
        items.append(raw)
    return items

items = from_telegram_html()
Path('news.json').write_text(json.dumps({'updatedAt': datetime.now(timezone.utc).isoformat(), 'items': items}, ensure_ascii=False, indent=2) + '\n')
print(f'Wrote {len(items)} items')

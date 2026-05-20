import email.utils
import html
import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import requests


def clean_text(s: str) -> str:
    s = re.sub(r'<br\s*/?>', ' ', s or '')
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = re.sub(r'https?://\S+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def format_date(pub_date: str) -> str:
    try:
        dt = email.utils.parsedate_to_datetime(pub_date)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.strftime('%d/%m/%Y')
    except Exception:
        return 'X'


def normalize_link(link: str) -> str:
    link = (link or '').replace('https://nitter.net/', 'https://x.com/')
    link = link.replace('#m', '')
    return link


def fetch_x_items(limit: int = 3):
    r = requests.get('https://nitter.net/AIGEN_C/rss', headers={'User-Agent': 'Mozilla/5.0'}, timeout=25)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    items = []
    for item in root.findall('./channel/item'):
        title = clean_text(item.findtext('title') or '')
        desc = clean_text(item.findtext('description') or '')
        # Nitter descriptions can include quoted/reposted text. Prefer the item title as the concise post text.
        text = title or desc
        if len(text) < 10:
            continue
        items.append({
            'title': format_date(item.findtext('pubDate') or ''),
            'text': text[:220] + ('…' if len(text) > 220 else ''),
            'url': normalize_link(item.findtext('link') or 'https://x.com/AIGEN_C'),
        })
        if len(items) >= limit:
            break
    return items

items = fetch_x_items()
Path('x-news.json').write_text(json.dumps({'updatedAt': datetime.now(timezone.utc).isoformat(), 'items': items}, ensure_ascii=False, indent=2) + '\n')
print(f'Wrote {len(items)} X items')

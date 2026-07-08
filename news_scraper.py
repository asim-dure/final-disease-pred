"""
Fetches new posts from each source in news_sources.SOURCES -- either via a
WordPress REST API (most sources) or NCDC's sitrep-listing page (its own
HTML structure, not WordPress). Never raises -- a single unreachable/
suspended/redesigned source (e.g. NTBLCP, confirmed down at implementation
time) must never break the rest of the pipeline; it just logs a warning and
contributes zero posts for that run.
"""
import re
import logging
from datetime import datetime, timezone

import requests

log = logging.getLogger("news_scraper")

TIMEOUT = 15

_NCDC_ENTRY_RE = re.compile(
    r"""<a class='black-text' href="([^"]+\.pdf)" download="([^"]+)">.*?<h4>([^<]+)</h4>""",
    re.S,
)
_NCDC_FILENAME_RE = re.compile(r"_(\d{2})(\d{2})(\d{2})_(\d+)\.pdf$")


def _strip_html(html: str) -> str:
    """WordPress REST API content/excerpt fields are raw HTML -- reduce to
    plain text before handing to the LLM (cheaper, and avoids the model
    getting distracted by markup)."""
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&[a-zA-Z#0-9]+;", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def fetch_new_posts(source: dict, since_iso: str | None, max_posts: int = 20) -> list[dict]:
    """Returns a list of {id, title, content_text, link, published_at,
    source_id, source_label} for posts published after since_iso (or the
    most recent `max_posts` posts if since_iso is None -- first run).
    Returns [] (not an exception) on any network/parse failure."""
    params = {"per_page": max_posts, "orderby": "date", "order": "desc"}
    if since_iso:
        params["after"] = since_iso
    # Optional per-source WordPress query params (e.g. restrict a general news
    # site to its Health category so the pipeline doesn't LLM-classify politics/
    # sport). Merged verbatim into the REST query -- see news_sources.SOURCES.
    extra = source.get("wp_params")
    if isinstance(extra, dict):
        params.update(extra)

    try:
        resp = requests.get(source["wp_api_base"], params=params, timeout=TIMEOUT,
                             headers={"User-Agent": "FMOH-EWS-NewsMonitor/1.0"})
        resp.raise_for_status()
        posts = resp.json()
    except requests.exceptions.RequestException as e:
        log.warning(f"[{source['id']}] unreachable ({e.__class__.__name__}: {e}) -- skipping this run, will retry next run")
        return []
    except ValueError as e:
        log.warning(f"[{source['id']}] returned non-JSON response ({e}) -- site may have changed/be down -- skipping")
        return []

    if not isinstance(posts, list):
        log.warning(f"[{source['id']}] unexpected response shape (not a list) -- skipping")
        return []

    out = []
    for p in posts:
        try:
            title = _strip_html(p.get("title", {}).get("rendered", ""))
            content = _strip_html(p.get("content", {}).get("rendered", "")) \
                or _strip_html(p.get("excerpt", {}).get("rendered", ""))
            if not title:
                continue
            out.append({
                "id": f"{source['id']}:{p.get('id')}",
                "title": title,
                "content_text": content[:6000],  # cap -- LLM prompt budget, not a data limit
                "link": p.get("link", ""),
                "published_at": p.get("date", ""),
                "source_id": source["id"],
                "source_label": source["label"],
            })
        except (AttributeError, TypeError, KeyError) as e:
            log.warning(f"[{source['id']}] skipping one malformed post entry: {e}")
            continue
    return out


def _extract_pdf_text(pdf_url: str, max_pages: int = 3, max_chars: int = 5000) -> str:
    """Downloads and extracts text from the first few pages of an NCDC
    sitrep PDF -- this is where the real, week-specific epidemiological
    detail lives (case counts, deaths, CFR, affected states/LGAs, trend vs
    prior year), which is what makes each week's alert genuinely distinct
    instead of identical boilerplate. Returns "" (never raises) on any
    download/parse failure -- caller falls back to a generic description."""
    try:
        from pypdf import PdfReader
        import io
        resp = requests.get(pdf_url, timeout=TIMEOUT, headers={"User-Agent": "Mozilla/5.0 (FMOH-EWS-NewsMonitor/1.0)"})
        resp.raise_for_status()
        reader = PdfReader(io.BytesIO(resp.content))
        text = ""
        for page in reader.pages[:max_pages]:
            text += (page.extract_text() or "") + "\n"
            if len(text) >= max_chars:
                break
        return text[:max_chars].strip()
    except Exception as e:
        log.warning(f"PDF text extraction failed for {pdf_url}: {e}")
        return ""


def fetch_ncdc_sitreps(source: dict) -> list[dict]:
    """NCDC's /diseases/sitreps page lists downloadable PDF situation
    reports as plain HTML anchors -- not WordPress, not an API, NCDC-
    specific markup (confirmed live during implementation: currently shows
    weekly Lassa fever sitreps). Each PDF's filename encodes the report
    date (DDMMYY) and week number, e.g.
    "An update of Lassa fever outbreak in Nigeria_060626_22.pdf".

    Real PDF text (case counts, deaths, CFR, affected states) is extracted
    via _extract_pdf_text() so each week's content is genuinely distinct,
    not a repeated generic note -- confirmed during implementation that
    NCDC's PDFs contain real structured epi tables, not scanned images."""
    try:
        resp = requests.get(source["sitreps_url"], timeout=TIMEOUT,
                             headers={"User-Agent": "Mozilla/5.0 (FMOH-EWS-NewsMonitor/1.0)"})
        resp.raise_for_status()
        html = resp.text
    except requests.exceptions.RequestException as e:
        log.warning(f"[{source['id']}] unreachable ({e.__class__.__name__}: {e}) -- skipping this run, will retry next run")
        return []

    out = []
    for pdf_url, filename, title in _NCDC_ENTRY_RE.findall(html):
        title = title.strip()
        m = _NCDC_FILENAME_RE.search(filename)
        published_at, week_label = "", ""
        if m:
            dd, mm, yy = m.group(1), m.group(2), m.group(3)
            week_label = f"Week {m.group(4)}"
            try:
                published_at = datetime(2000 + int(yy), int(mm), int(dd), tzinfo=timezone.utc).isoformat()
            except ValueError:
                pass
        full_pdf_url = f"https://ncdc.gov.ng{pdf_url}"
        pdf_text = _extract_pdf_text(full_pdf_url)
        content_text = pdf_text if pdf_text else (
            f"NCDC (Nigeria Centre for Disease Control) published an official situation report: "
            f"\"{title}\", {week_label}, dated {published_at[:10] if published_at else 'date unknown'}. "
            f"Full epidemiological detail could not be extracted from the PDF this run -- "
            f"treat this as confirmation NCDC is actively tracking this disease, not as a source of figures."
        )
        out.append({
            "id": f"{source['id']}:{filename}",
            "title": f"{title} ({week_label})".strip(),
            "content_text": content_text,
            "link": full_pdf_url,
            "published_at": published_at,
            "source_id": source["id"],
            "source_label": source["label"],
        })
    return out


def fetch_all(sources: list[dict], cursors: dict[str, str]) -> list[dict]:
    """cursors: {source_id: last_seen_iso_date_or_None}. Returns the combined
    list of new posts across every source, each still tagged with source_id
    so the caller can update cursors per-source after successful processing.
    Per-source dispatch: WordPress sites use the `after` cursor to avoid
    re-fetching old posts; NCDC's sitrep page has no such param (it's not an
    API) so it returns its full current listing every run -- duplicate
    LLM-extraction cost is avoided downstream in news_pipeline.py by
    filtering against already-stored alert ids before calling extract()."""
    all_posts = []
    for src in sources:
        if "wp_api_base" in src:
            since = cursors.get(src["id"])
            posts = fetch_new_posts(src, since)
            log.info(f"[{src['id']}] {len(posts)} new post(s) since {since or 'beginning'}")
        elif "sitreps_url" in src:
            posts = fetch_ncdc_sitreps(src)
            log.info(f"[{src['id']}] {len(posts)} sitrep(s) found in current listing")
        else:
            log.warning(f"[{src['id']}] has no recognized fetch method (wp_api_base/sitreps_url) -- skipping")
            posts = []
        all_posts.extend(posts)
    return all_posts

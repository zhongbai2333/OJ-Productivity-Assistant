import base64
import hashlib
import json
import mimetypes
import re
import sys
import time
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import parse_qs, urljoin, urlparse

import bs4
import requests
import urllib3
from bs4.element import NavigableString, Tag

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://2024.jdoj.tech/"

SECTION_ALIASES: Dict[str, List[str]] = {
    "description": ["题目描述", "Description"],
    "input": ["输入", "Input"],
    "output": ["输出", "Output"],
    "sample_input": ["样例输入", "Sample Input", "Sample Inputs", "Sample"],
    "sample_output": ["样例输出", "Sample Output", "Sample Outputs", "Samples"],
    "hint": ["提示", "Hint", "HINT"],
    "source": ["来源/分类", "Source/Category", "Source"],
}

JUDGE_STATUS = {
    0: "等待",
    1: "等待重判",
    2: "编译中",
    3: "运行并评判",
    4: "正确",
    5: "格式错误",
    6: "答案错误",
    7: "时间超限",
    8: "内存超限",
    9: "输出超限",
    10: "运行错误",
    11: "编译错误",
    12: "编译成功",
    13: "运行完成",
    14: "自动评测通过，等待人工确认",
    15: "提交中",
    16: "远程等待",
    17: "远程判题",
}

AUTH_REQUIRED_ERROR = "AUTH_REQUIRED"

MAX_EMBED_IMAGE_SIZE = 2 * 1024 * 1024  # 约 2 MiB，避免过大的内嵌图片
_IMAGE_DATA_CACHE: Dict[str, Optional[str]] = {}

ALLOWED_RICH_TAGS: Set[str] = {
    "p",
    "br",
    "img",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "pre",
    "code",
    "blockquote",
    "sup",
    "sub",
    "a",
    "hr",
    "div",
    "span",
}

ALLOWED_RICH_ATTRS: Dict[str, Set[str]] = {
    "img": {"src", "alt", "title"},
    "a": {"href", "title", "target", "rel"},
    "table": {"border"},
    "th": {"colspan", "rowspan", "scope"},
    "td": {"colspan", "rowspan", "scope"},
    "tr": set(),
    "code": set(),
    "pre": set(),
    "p": set(),
    "div": set(),
    "span": set(),
    "ul": set(),
    "ol": set(),
    "li": set(),
    "strong": set(),
    "em": set(),
    "b": set(),
    "i": set(),
    "u": set(),
    "blockquote": set(),
    "sup": set(),
    "sub": set(),
    "hr": set(),
    "thead": set(),
    "tbody": set(),
    "tfoot": set(),
}

RICH_CONTENT_MARKERS: Tuple[str, ...] = (
    "<img",
    "<table",
    "<iframe",
    "<sup",
    "<sub",
    "<math",
    "<svg",
)


def _normalize_newlines(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _normalize_paragraph(value: str) -> str:
    text = _normalize_newlines(value)
    if "<img" in text:
        return text
    text = text.replace("\xa0", " ")
    raw_lines = [line.replace("\xa0", " ") for line in text.split("\n")]
    normalized: List[str] = []
    blank_pending = False
    for raw_line in raw_lines:
        candidate = raw_line.rstrip()
        if candidate:
            normalized.append(candidate)
            blank_pending = False
        elif normalized and not blank_pending:
            normalized.append("")
            blank_pending = True
    while normalized and not normalized[-1]:
        normalized.pop()
    return "\n".join(normalized)


def _normalize_sample(value: str) -> str:
    text = _normalize_newlines(value)
    lines = [line.replace("\xa0", " ").rstrip("\r") for line in text.split("\n")]
    normalized: List[str] = []
    blank_pending = False
    for line in lines:
        if line != "":
            normalized.append(line)
            blank_pending = False
        elif normalized and not blank_pending:
            normalized.append("")
            blank_pending = True
    while normalized and not normalized[-1]:
        normalized.pop()
    return "\n".join(normalized)


def _ensure_authenticated(
    response: requests.Response, soup: Optional[bs4.BeautifulSoup] = None
) -> None:
    final_url = (response.url or "").lower()
    if "login.php" in final_url:
        raise PermissionError(AUTH_REQUIRED_ERROR)
    if soup is None:
        return
    login_form = soup.select_one('form[action*="login.php"]')
    if login_form is not None:
        raise PermissionError(AUTH_REQUIRED_ERROR)


def _configure_io():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


_configure_io()


def _build_session(cookies: Optional[Dict[str, str]] = None) -> requests.Session:
    session = requests.Session()
    session.verify = False
    if cookies:
        requests.utils.add_dict_to_cookiejar(session.cookies, cookies)
    return session


def login(username, secret, is_hashed=False):
    session = _build_session()

    csrf_url = urljoin(BASE_URL, "csrf.php")
    login_url = urljoin(BASE_URL, "login.php")

    response = session.get(csrf_url, timeout=10)
    response.raise_for_status()

    soup = bs4.BeautifulSoup(response.text, "html.parser")
    _ensure_authenticated(response, soup)
    csrf_input = soup.find("input", attrs={"name": "csrf"})
    if csrf_input is None or not csrf_input.get("value"):
        raise ValueError("Unable to locate CSRF token in response")

    csrf_token = csrf_input["value"]

    password_hash = (
        secret if is_hashed else hashlib.md5(secret.encode("utf-8")).hexdigest()
    )

    payload = {
        "user_id": username,
        "password": password_hash,
        "submit": "Submit",
        "csrf": csrf_token,
    }

    login_response = session.post(login_url, data=payload, timeout=10)
    login_response.raise_for_status()
    return session, session.cookies.get_dict()


def _extract_page_number(href):
    full_url = urljoin(BASE_URL, href)
    query = urlparse(full_url).query
    page_values = parse_qs(query).get("page")
    if not page_values:
        return None
    try:
        return int(page_values[0])
    except (TypeError, ValueError):
        return None


def fetch_problemset(session, start_page=1, max_pages=None):
    page = start_page
    fetched = 0
    results = {}

    while True:
        page_url = urljoin(BASE_URL, f"problemset.php?page={page}")
        response = session.get(page_url, timeout=10)
        response.raise_for_status()

        soup = bs4.BeautifulSoup(response.text, "html.parser")
        _ensure_authenticated(response, soup)
        rows = soup.select("table.ui.very.basic.center.aligned.table tbody tr")

        problems = []
        for row in rows:
            columns = row.find_all("td")
            if len(columns) < 5:
                continue

            status_span = columns[0].find("span", class_="status")
            status_classes = status_span.get("class", []) if status_span else []
            is_accepted = "accepted" in status_classes

            problem_id = columns[1].get_text(strip=True)

            title_link = columns[2].find("a")
            title = (
                title_link.get_text(strip=True)
                if title_link
                else columns[2].get_text(strip=True)
            )
            problem_url = (
                urljoin(BASE_URL, title_link["href"])
                if title_link and title_link.get("href")
                else None
            )

            solved = submitted = None
            solved_submitted_text = columns[3].get_text(strip=True)
            if "/" in solved_submitted_text:
                solved_text, submitted_text = solved_submitted_text.split("/", 1)
                try:
                    solved = int(solved_text)
                except ValueError:
                    solved = solved_text
                try:
                    submitted = int(submitted_text)
                except ValueError:
                    submitted = submitted_text

            acceptance = None
            acceptance_bar = columns[4].find("div", class_="progress-bar")
            if acceptance_bar:
                acceptance_text = acceptance_bar.get_text(strip=True).rstrip("%")
                try:
                    acceptance = float(acceptance_text)
                except ValueError:
                    acceptance = acceptance_bar.get_text(strip=True)

            problems.append(
                {
                    "problem_id": problem_id,
                    "title": title,
                    "url": problem_url,
                    "is_accepted": is_accepted,
                    "solved": solved,
                    "submitted": submitted,
                    "acceptance": acceptance,
                }
            )

        results[page] = problems
        fetched += 1

        if max_pages is not None and fetched >= max_pages:
            break

        next_link = soup.select_one("a#page_next")
        if not next_link or "disabled" in next_link.get("class", []):
            break

        next_href = next_link.get("href")
        next_page = _extract_page_number(next_href) if next_href else None
        if next_page is None or next_page == page:
            break

        page = next_page

    return results


def _collect_labels(soup: bs4.BeautifulSoup) -> Dict[str, str]:
    metadata: Dict[str, str] = {}
    for span in soup.select("div.padding span.ui.label"):
        text = span.get_text(strip=True)
        if "：" in text:
            key, value = text.split("：", 1)
            metadata[key] = value
    return metadata


def _match_segment(tag) -> bool:
    if getattr(tag, "name", None) != "div":
        return False
    classes = tag.get("class", [])
    required = {"ui", "bottom", "attached", "segment"}
    return required.issubset(set(classes))


def _sanitize_title(raw_title: str) -> str:
    cleaned = raw_title.replace("：", " ")
    tokens = [tok for tok in cleaned.split() if tok not in {"复制", "Copy"}]
    if not tokens:
        return raw_title.strip()
    return " ".join(tokens)


def _collect_sections(soup: bs4.BeautifulSoup) -> Dict[str, str]:
    sections: Dict[str, str] = {}
    for header in soup.select("div.padding h4.ui"):
        raw_title = header.get_text(" ", strip=True)
        title = _sanitize_title(raw_title)
        if not title:
            continue

        sibling = header
        segment = None
        while True:
            sibling = sibling.next_sibling
            if sibling is None:
                break
            if isinstance(sibling, str):
                continue
            if _match_segment(sibling):
                segment = sibling
                break

        if segment is None:
            continue

        html = segment.decode_contents()
        sections[title] = html

    return sections


def _absolutize_resources(soup: bs4.BeautifulSoup, base_url: str) -> None:
    for tag in soup.find_all("img"):
        src = tag.get("src")
        data_src = tag.get("data-src")
        candidate = src or data_src
        if not candidate:
            continue
        absolute = urljoin(base_url, candidate)
        if src != absolute:
            tag["src"] = absolute
        if data_src:
            tag["data-src"] = urljoin(base_url, data_src)


def _guess_mime_type(url: str, content_type: Optional[str]) -> Optional[str]:
    if content_type:
        mime = content_type.split(";", 1)[0].strip()
        if mime:
            return mime
    guessed, _ = mimetypes.guess_type(url)
    return guessed


def _fetch_image_as_data_url(session: requests.Session, url: str) -> Optional[str]:
    cached = _IMAGE_DATA_CACHE.get(url)
    if cached is not None:
        return cached
    try:
        response = session.get(url, timeout=10)
        response.raise_for_status()
        content = response.content
    except requests.RequestException:
        _IMAGE_DATA_CACHE[url] = None
        return None
    if not content or len(content) > MAX_EMBED_IMAGE_SIZE:
        _IMAGE_DATA_CACHE[url] = None
        return None
    mime_type = (
        _guess_mime_type(url, response.headers.get("content-type"))
        or "application/octet-stream"
    )
    if not mime_type.startswith("image/"):
        _IMAGE_DATA_CACHE[url] = None
        return None
    encoded = base64.b64encode(content).decode("ascii")
    data_url = f"data:{mime_type};base64,{encoded}"
    _IMAGE_DATA_CACHE[url] = data_url
    return data_url


def _embed_protected_images(
    soup: bs4.BeautifulSoup, session: requests.Session, base_url: str
) -> None:
    for tag in soup.find_all("img"):
        src = tag.get("src")
        if not src:
            continue
        if src.startswith("data:"):
            continue
        absolute = urljoin(base_url, src)
        embedded = _fetch_image_as_data_url(session, absolute)
        if embedded:
            tag["src"] = embedded
            for attr in ("data-src", "srcset", "data-original", "data-lazy-src"):
                if attr in tag.attrs:
                    del tag[attr]


def _sanitize_rich_content(html: str) -> str:
    fragment = bs4.BeautifulSoup(html, "html.parser")

    for garbage in fragment.find_all(["script", "style"]):
        garbage.decompose()

    for tag in fragment.find_all(True):
        name = tag.name.lower()
        if name == "font":
            tag.unwrap()
            continue
        if name not in ALLOWED_RICH_TAGS:
            tag.unwrap()
            continue
        allowed_attrs = ALLOWED_RICH_ATTRS.get(name, set())
        for attr in list(tag.attrs.keys()):
            if attr not in allowed_attrs:
                del tag.attrs[attr]
        if name == "img" and not tag.get("src"):
            tag.decompose()
        if name == "span" and not tag.attrs:
            tag.unwrap()

    for div in fragment.find_all("div"):
        if div.attrs:
            div.attrs = {}
        if not div.find(["div", "table", "ul", "ol", "pre", "blockquote"]):
            div.name = "p"

    for text_node in fragment.find_all(string=True):
        if isinstance(text_node, NavigableString):
            new_text = text_node.replace("\xa0", " ")
            if new_text != text_node:
                text_node.replace_with(new_text)

    for tag in fragment.find_all("p"):
        has_image = tag.find("img") is not None
        if not tag.get_text(strip=True) and not has_image:
            tag.decompose()
            continue
        if has_image:
            meaningful_children = []
            for child in list(tag.children):
                if isinstance(child, NavigableString) and not child.strip():
                    child.extract()
                    continue
                meaningful_children.append(child)
            if meaningful_children and all(
                getattr(child, "name", None) == "img" for child in meaningful_children
            ):
                tag.unwrap()

    for br in fragment.find_all("br"):
        sibling = br.next_sibling
        while isinstance(sibling, Tag) and sibling.name == "br":
            next_sibling = sibling.next_sibling
            sibling.decompose()
            sibling = next_sibling

    for br in list(fragment.find_all("br")):
        prev_text = br.previous_sibling
        while isinstance(prev_text, NavigableString) and not prev_text.strip():
            prev_text = prev_text.previous_sibling
        next_text = br.next_sibling
        while isinstance(next_text, NavigableString) and not next_text.strip():
            next_text = next_text.next_sibling
        if prev_text is None or (
            isinstance(prev_text, Tag)
            and prev_text.name in {"section", "div", "p"}
            and not prev_text.get_text(strip=True)
        ):
            br.decompose()
        elif next_text is None or (
            isinstance(next_text, Tag)
            and next_text.name in {"section", "div", "p"}
            and not next_text.get_text(strip=True)
        ):
            br.decompose()

    for span in fragment.find_all("span"):
        if not span.attrs:
            span.unwrap()

    body = fragment.body or fragment
    sanitized = body.decode_contents()
    sanitized = re.sub(
        r"(?:\s*<br\s*/?>\s*){3,}", "<br /><br />", sanitized, flags=re.IGNORECASE
    )
    sanitized = re.sub(r"\n{3,}", "\n\n", sanitized)
    return sanitized.strip()


def _extract_problem_header(soup: bs4.BeautifulSoup) -> Dict[str, Optional[str]]:
    header = soup.select_one("div.padding .ui.center.aligned.grid h1.ui.header")
    raw_title = header.get_text(strip=True) if header else ""
    problem_id = None
    problem_title = raw_title
    if ":" in raw_title:
        left, right = raw_title.split(":", 1)
        problem_id = left.strip()
        problem_title = right.strip()
    return {"problem_id": problem_id, "title": problem_title, "raw_title": raw_title}


def fetch_problem(session, problem_id):
    problem_url = urljoin(BASE_URL, f"problem.php?id={problem_id}")
    response = session.get(problem_url, timeout=10)
    response.raise_for_status()

    soup = bs4.BeautifulSoup(response.text, "html.parser")
    private_notice = soup.select_one("div.ui.negative.icon.message")
    if private_notice is not None:
        sanitized_notice = _sanitize_rich_content(str(private_notice))
        header = private_notice.select_one(".header")
        header_text = header.get_text("\n", strip=True) if header else private_notice.get_text("\n", strip=True)
        message_text = _normalize_paragraph(header_text)
        contest_links = []
        for link in private_notice.select('a[href*="contest.php"]'):
            href = link.get("href")
            if not href:
                continue
            contest_links.append(
                {
                    "name": link.get_text(strip=True) or href,
                    "url": urljoin(problem_url, href),
                }
            )
        return {
            "problem_id": str(problem_id),
            "title": None,
            "raw_title": None,
            "metadata": {},
            "description": None,
            "input": None,
            "output": None,
            "sample_input": None,
            "sample_output": None,
            "hint": None,
            "source": None,
            "tags": [],
            "raw_sections": {},
            "url": problem_url,
            "hasExternalResources": False,
            "is_private": True,
            "private_notice": sanitized_notice,
            "private_message": message_text,
            "private_contests": contest_links,
        }
    _absolutize_resources(soup, problem_url)
    _embed_protected_images(soup, session, problem_url)

    header_info = _extract_problem_header(soup)
    metadata = _collect_labels(soup)
    sections = _collect_sections(soup)
    tags: List[str] = [a.get_text(strip=True) for a in soup.select("#show_tag_div a")]

    def _get_section_value(key: str):
        aliases = SECTION_ALIASES.get(key, [])
        for alias in aliases:
            value = sections.get(alias)
            if value:
                return value
        return None

    def _clean_value(key: str, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        html = value
        fragment = bs4.BeautifulSoup(html, "html.parser")
        text_content = fragment.get_text("\n", strip=False)
        if key in {"sample_input", "sample_output"}:
            return _normalize_sample(text_content)
        normalized = _normalize_paragraph(text_content)
        html_lower = html.lower()
        if any(marker in html_lower for marker in RICH_CONTENT_MARKERS):
            return _sanitize_rich_content(html)
        return normalized

    raw_sections: Dict[str, str] = {}
    for title, value in sections.items():
        if value is None:
            continue
        fragment = bs4.BeautifulSoup(value, "html.parser")
        plain_text = fragment.get_text("\n", strip=False)
        html_lower = value.lower()
        if any(marker in html_lower for marker in RICH_CONTENT_MARKERS):
            raw_sections[title] = _sanitize_rich_content(value)
        else:
            raw_sections[title] = _normalize_paragraph(plain_text)

    has_external_resources = any(
        "<img" in value.lower() for value in sections.values() if value
    )

    problem_data = {
        "problem_id": header_info.get("problem_id") or str(problem_id),
        "title": header_info.get("title"),
        "metadata": metadata,
        "description": _clean_value("description", _get_section_value("description")),
        "input": _clean_value("input", _get_section_value("input")),
        "output": _clean_value("output", _get_section_value("output")),
        "sample_input": _clean_value(
            "sample_input", _get_section_value("sample_input")
        ),
        "sample_output": _clean_value(
            "sample_output", _get_section_value("sample_output")
        ),
        "hint": _clean_value("hint", _get_section_value("hint")),
        "source": _clean_value("source", _get_section_value("source")),
        "tags": tags,
        "raw_sections": raw_sections,
        "url": problem_url,
        "hasExternalResources": has_external_resources,
    }

    return problem_data


def fetch_status_list(session, user_id, limit=20):
    status_url = urljoin(BASE_URL, "status.php")
    params = {"user_id": user_id}
    response = session.get(status_url, params=params, timeout=10)
    response.raise_for_status()

    soup = bs4.BeautifulSoup(response.text, "html.parser")
    _ensure_authenticated(response, soup)
    return _parse_status_entries(soup, limit)


def _parse_status_entries(soup: bs4.BeautifulSoup, limit: Optional[int] = None):
    table = soup.select_one("table#result-tab") or soup.select_one("table#table")
    if table is None:
        for candidate in soup.find_all("table"):
            headers = [th.get_text(strip=True) for th in candidate.find_all("th")]
            if any(h in {"提交编号", "用户", "题目编号", "结果"} for h in headers):
                table = candidate
                break
    if table is None:
        return []

    tbody = table.find("tbody") or table

    entries: List[Dict[str, Optional[str]]] = []
    for row in tbody.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 8:
            continue

        if len(cells) >= 10:
            idx_solution = 0
            idx_user = 1
            idx_nickname = 2
            idx_problem = 3
            idx_result = 4
            idx_memory = 5
            idx_time = 6
            idx_language = 7
            idx_code_length = 8
            idx_submitted_at = 9
        else:
            idx_solution = None
            idx_user = 0
            idx_nickname = 1
            idx_problem = 2
            idx_result = 3
            idx_memory = 4
            idx_time = 5
            idx_language = 6
            idx_code_length = 7
            idx_submitted_at = 8

        solution_id = None
        solution_id_text = None
        if idx_solution is not None:
            solution_id_text = cells[idx_solution].get_text(strip=True)
            if solution_id_text:
                try:
                    solution_id = int(solution_id_text)
                except ValueError:
                    solution_id = None

        result_cell = cells[idx_result]
        result_span = result_cell.find("span", attrs={"result": True})
        result_code = None
        if result_span is not None:
            try:
                result_code = int(result_span.get("result"))
            except (TypeError, ValueError):
                result_code = None

        result_text = result_cell.get_text(strip=True) or None

        if solution_id is None:
            solution_id = _extract_solution_id_from_cell(result_cell)
            if solution_id is not None:
                solution_id_text = str(solution_id)

        entry = {
            "solution_id": solution_id,
            "solution_id_text": solution_id_text,
            "user": cells[idx_user].get_text(strip=True) or None,
            "nickname": cells[idx_nickname].get_text(strip=True) or None,
            "problem_id": cells[idx_problem].get_text(strip=True) or None,
            "result_code": result_code,
            "result_text": result_text,
            "memory": cells[idx_memory].get_text(strip=True) or None,
            "time": cells[idx_time].get_text(strip=True) or None,
            "language": cells[idx_language].get_text(" ", strip=True) or None,
            "code_length": cells[idx_code_length].get_text(strip=True) or None,
            "submitted_at": cells[idx_submitted_at].get_text(strip=True) or None,
        }

        if entry["memory"] in {"---", ""}:
            entry["memory"] = None
        if entry["time"] in {"---", ""}:
            entry["time"] = None

        entries.append(entry)
        if limit and len(entries) >= limit:
            break

    return entries


def _extract_solution_id_from_cell(cell: Tag) -> Optional[int]:
    for link in cell.find_all("a", href=True):
        match = re.search(r"sid=\s*(\d+)", link["href"])
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                continue
    return None


def _status_entry_key(
    entry: Dict[str, Optional[str]],
) -> Tuple[
    Optional[int],
    Optional[str],
    Optional[str],
    Optional[str],
    Optional[str],
    Optional[str],
    Optional[str],
    Optional[str],
]:
    return (
        entry.get("solution_id"),
        entry.get("submitted_at"),
        entry.get("result_text"),
        entry.get("memory"),
        entry.get("time"),
        entry.get("problem_id"),
        entry.get("language"),
        entry.get("code_length"),
    )


def _status_entry_sort_key(entry: Dict[str, Optional[str]]) -> Tuple[int, str]:
    solution_id = entry.get("solution_id")
    submitted_at = entry.get("submitted_at") or ""
    solution_order = solution_id if isinstance(solution_id, int) else -1
    return (solution_order, submitted_at)


def _prepare_submit_payload(
    session, problem_id, language, source_code, contest_problem_id
):
    submit_page_url = urljoin(BASE_URL, f"submitpage.php?id={problem_id}")
    response = session.get(submit_page_url, timeout=10)
    response.raise_for_status()

    soup = bs4.BeautifulSoup(response.text, "html.parser")
    _ensure_authenticated(response, soup)
    form = soup.find("form", id="submit_code")
    if form is None:
        form = soup.find("form", attrs={"action": "submit.php"})
    if form is None:
        raise ValueError("无法在提交页面找到提交表单")

    payload: Dict[str, str] = {}

    for input_tag in form.find_all("input"):
        name = input_tag.get("name")
        if not name:
            continue
        input_type = (input_tag.get("type") or "").lower()
        if input_type in {"checkbox", "radio"} and not input_tag.has_attr("checked"):
            continue
        payload[name] = input_tag.get("value", "")

    for textarea in form.find_all("textarea"):
        name = textarea.get("name")
        if not name:
            continue
        payload[name] = textarea.text or ""

    for select in form.find_all("select"):
        name = select.get("name")
        if not name:
            continue
        option = select.find("option", selected=True) or select.find("option")
        payload[name] = option.get("value", "") if option else ""

    payload["id"] = str(problem_id)
    payload["language"] = str(language)
    payload["source"] = source_code

    if contest_problem_id is not None:
        payload["problem_id"] = str(contest_problem_id)

    return payload


def submit_solution(
    session, user_id, problem_id, source_code, language=6, contest_problem_id=0
):
    pre_entries = fetch_status_list(session, user_id, limit=20)
    seen_keys = {_status_entry_key(entry) for entry in pre_entries}

    payload = _prepare_submit_payload(
        session, problem_id, language, source_code, contest_problem_id
    )

    submit_url = urljoin(BASE_URL, "submit.php")
    headers = {"Referer": urljoin(BASE_URL, f"submitpage.php?id={problem_id}")}
    response = session.post(submit_url, data=payload, timeout=10, headers=headers)
    response.raise_for_status()

    soup = bs4.BeautifulSoup(response.text, "html.parser")
    entries = _parse_status_entries(soup, limit=5)
    new_entry = _find_new_submission(entries, seen_keys)
    if new_entry is not None:
        return new_entry

    for attempt in range(20):
        time.sleep(0.5 * (attempt + 1))
        status_entries = fetch_status_list(session, user_id, limit=20)
        new_entry = _find_new_submission(status_entries, seen_keys)
        if new_entry is not None:
            return new_entry

    raise ValueError("新提交记录未在状态列表中出现")


def _find_new_submission(
    entries: List[Dict[str, Optional[str]]],
    seen_keys: Set[
        Tuple[
            Optional[int],
            Optional[str],
            Optional[str],
            Optional[str],
            Optional[str],
            Optional[str],
            Optional[str],
            Optional[str],
        ]
    ],
) -> Optional[Dict[str, Optional[str]]]:
    if not entries:
        return None

    for entry in sorted(entries, key=_status_entry_sort_key, reverse=True):
        key = _status_entry_key(entry)
        if key not in seen_keys:
            seen_keys.add(key)
            return entry
    return None


def query_submission_result(session, solution_id):
    status_url = urljoin(BASE_URL, "status-ajax.php")
    response = session.get(status_url, params={"solution_id": solution_id}, timeout=10)
    response.raise_for_status()

    raw = response.text.strip()
    if not raw:
        raise ValueError("Empty response from status-ajax endpoint")

    parts = [part.strip() for part in raw.split(",")]
    if not parts:
        raise ValueError("Malformed status-ajax response")

    try:
        result_code = int(parts[0])
    except ValueError as exc:
        raise ValueError(
            f"Invalid result code in status-ajax response: {parts[0]}"
        ) from exc

    memory = parts[1] if len(parts) > 1 and parts[1] else None
    time_used = parts[2] if len(parts) > 2 and parts[2] else None
    extra = (
        parts[3] if len(parts) > 3 and parts[3] and parts[3].lower() != "none" else None
    )
    ac_rate = parts[4] if len(parts) > 4 and parts[4] else None

    return {
        "solution_id": solution_id,
        "result_code": result_code,
        "result_text": JUDGE_STATUS.get(result_code, "未知"),
        "memory": memory,
        "time": time_used,
        "extra": extra,
        "ac_rate": ac_rate,
        "raw": raw,
    }


def poll_submission(
    session, solution_id, max_attempts=12, initial_delay=1.0, backoff=1.5
):
    delay = initial_delay
    last_status = None
    for _ in range(max_attempts):
        status = query_submission_result(session, solution_id)
        last_status = status
        if status["result_code"] >= 4:
            return status
        time.sleep(delay)
        delay *= backoff
    return last_status


def _handle_action(request: Dict[str, Any]) -> Dict[str, Any]:
    action = request.get("action")
    if not action:
        raise ValueError("Missing action in request")

    if action == "login":
        username = request.get("username")
        password = request.get("password")
        password_hash = request.get("password_hash")
        if not username:
            raise ValueError("username is required")
        if password:
            session, cookies = login(username, password, is_hashed=False)
        elif password_hash:
            session, cookies = login(username, password_hash, is_hashed=True)
        else:
            raise ValueError("password or password_hash is required")
        return {"cookies": cookies}

    cookies = request.get("cookies")
    session = _build_session(cookies)

    if action == "fetch_problemset":
        start_page = request.get("start_page", 1)
        max_pages = request.get("max_pages")
        return {
            "problemset": fetch_problemset(
                session, start_page=start_page, max_pages=max_pages
            )
        }

    if action == "fetch_problem":
        problem_id = request.get("problem_id")
        if problem_id is None:
            raise ValueError("problem_id is required")
        return {"problem": fetch_problem(session, problem_id=problem_id)}

    if action == "fetch_status":
        user_id = request.get("user_id")
        if not user_id:
            raise ValueError("user_id is required")
        limit = request.get("limit", 20)
        return {"status": fetch_status_list(session, user_id=user_id, limit=limit)}

    if action == "submit_solution":
        user_id = request.get("user_id")
        problem_id = request.get("problem_id")
        source_code = request.get("source_code")
        language = request.get("language", 6)
        contest_problem_id = request.get("contest_problem_id", 0)
        if not user_id or problem_id is None or source_code is None:
            raise ValueError(
                "user_id, problem_id, and source_code are required for submission"
            )
        submission = submit_solution(
            session,
            user_id=user_id,
            problem_id=problem_id,
            source_code=source_code,
            language=language,
            contest_problem_id=contest_problem_id,
        )
        return {"submission": submission}

    if action == "poll_submission":
        solution_id = request.get("solution_id")
        if solution_id is None:
            raise ValueError("solution_id is required")
        max_attempts = request.get("max_attempts", 12)
        initial_delay = request.get("initial_delay", 1.0)
        backoff = request.get("backoff", 1.5)
        status = poll_submission(
            session,
            solution_id=solution_id,
            max_attempts=max_attempts,
            initial_delay=initial_delay,
            backoff=backoff,
        )
        return {"status": status}

    raise ValueError(f"Unsupported action: {action}")


def _main():
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"ok": False, "error": "Empty request"}, ensure_ascii=False))
        return
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(
            json.dumps(
                {"ok": False, "error": f"Invalid JSON: {exc}"}, ensure_ascii=False
            )
        )
        return

    try:
        result = _handle_action(request)
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))


if __name__ == "__main__":
    _main()

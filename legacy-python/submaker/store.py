"""工作檔（每支影片一份，SPEC §4.3）與共用的取代規則清單（SPEC §4.6）。

全部放在 work/，不進 git。
"""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "work"
RULES_FILE = ROOT / "rules.json"
KEEP_FILE = ROOT / "keep_repeats.json"  # 疊詞保留清單（SPEC §4.6.1）

# SPEC §4.6 的預設內容
DEFAULT_RULES = [
    {"find": "哎", "replace": "欸", "mode": "all", "note": ""},
    {"find": "誒", "replace": "欸", "mode": "all", "note": "簡體「诶」經 OpenCC 會轉成「誒」"},
    {"find": "裏", "replace": "裡", "mode": "all", "note": "異體字"},
    {"find": "里", "replace": "裡", "mode": "confirm", "note": "「公里」「鄰里」、地名的「里」是正確用法"},
]

# SPEC §4.7 的預設樣式
PRESETS = {
    "landscape": {"label": "橫式長影片", "font_size": 70, "y": -415},
    "portrait": {"label": "直式短影片", "font_size": 55, "y": -250},
}


def work_id(video_path: str) -> str:
    return hashlib.sha1(video_path.encode("utf-8")).hexdigest()[:12]


def work_dir(wid: str) -> Path:
    if not wid.isalnum():
        raise ValueError("工作檔代號不正確")
    return ROOT / wid


def _write_json(path: Path, data) -> None:
    # 先寫暫存檔再改名，存到一半中斷也不會留下壞掉的檔案
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def load_work(wid: str) -> dict | None:
    f = work_dir(wid) / "work.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def save_work(wid: str, work: dict) -> None:
    _write_json(work_dir(wid) / "work.json", work)


def load_rules() -> list[dict]:
    if RULES_FILE.exists():
        return json.loads(RULES_FILE.read_text(encoding="utf-8"))
    return [dict(r) for r in DEFAULT_RULES]


def save_rules(rules: list[dict]) -> None:
    _write_json(RULES_FILE, rules)


def load_keep() -> list[str]:
    from .cleanup import DEFAULT_KEEP
    if KEEP_FILE.exists():
        return json.loads(KEEP_FILE.read_text(encoding="utf-8"))
    return list(DEFAULT_KEEP)


def save_keep(words: list[str]) -> None:
    _write_json(KEEP_FILE, words)

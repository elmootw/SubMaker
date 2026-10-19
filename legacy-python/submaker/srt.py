"""讀取 .srt：判斷編碼（SPEC §4.1）、解析成字幕清單。"""
import re

TIME_LINE = re.compile(
    r"(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})"
)


def decode(raw: bytes) -> tuple[str, str]:
    """回傳 (文字, 判斷出的編碼)。"""
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig"), "UTF-8 BOM"
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16"), "UTF-16"
    try:
        return raw.decode("utf-8"), "UTF-8"
    except UnicodeDecodeError:
        pass
    try:
        # gb18030 是 GBK 的超集，GBK 檔一定能解
        return raw.decode("gb18030"), "GBK"
    except UnicodeDecodeError:
        raise ValueError("無法判斷字幕檔編碼（試過 UTF-8、UTF-16、GBK）")


def _ms(h, m, s, frac) -> int:
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(frac.ljust(3, "0"))


def parse(text: str) -> list[dict]:
    """回傳 [{start_ms, end_ms, text}]，依檔案順序。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    items = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.split("\n")
        for i, line in enumerate(lines):
            m = TIME_LINE.search(line)
            if m:
                g = m.groups()
                body = "\n".join(l.strip() for l in lines[i + 1:]).strip()
                items.append({
                    "start_ms": _ms(*g[:4]),
                    "end_ms": _ms(*g[4:]),
                    "text": body,
                })
                break
    if not items:
        raise ValueError("檔案裡找不到任何字幕時間軸，確定是 .srt 嗎？")
    return items

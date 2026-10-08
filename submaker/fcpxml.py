"""匯出 .fcpxml（SPEC §4.8、§5）。

結構沿用實測成功的 fcpxml 1.8；樣式取自使用者在 FCP 做的原生樣本。
匯出時只替換：位置的 Y 值、fontSize、文字內容與 name。
"""
import xml.etree.ElementTree as ET
from fractions import Fraction

EFFECT_NAME = "自訂事件"  # Custom.moti 的 zh_TW 名稱；不可用簡體的「自定」
NAME_SUFFIX = " - " + EFFECT_NAME
EFFECT_UID = ".../Titles.localized/Build In:Out.localized/Custom.localized/Custom.moti"

TEXT_STYLE = ('font="Source Han Sans TW" fontSize="{size}" fontColor="0.993628 0.987079 0.99997 1" '
              'bold="1" strokeColor="0 0 0 1" strokeWidth="-4" shadowColor="0 0 0 1" '
              'shadowOffset="10 315" kerning="1.24" alignment="center"')


def _attr(s: str) -> str:
    # 屬性值裡的換行要寫成 &#10;，否則 XML 讀進來會變成空白，name 就和文字對不上
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("\n", "&#10;").replace("\t", "&#9;"))


def _text(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _num(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else f"{v:g}"


def _time(frames: int, fps_num: int, fps_den: int) -> str:
    t = Fraction(frames * fps_den, fps_num)
    return f"{t.numerator}s" if t.denominator == 1 else f"{t.numerator}/{t.denominator}s"


def _parse_time(s: str) -> Fraction:
    return Fraction(s[:-1])


def build(work: dict) -> str:
    v, style, subs = work["video"], work["style"], work["subtitles"]
    num, den = v["fps_num"], v["fps_den"]
    t = lambda f: _time(f, num, den)
    total = v["duration_frames"]
    # 59.94、29.97 這類 NTSC 影格率，FCP 原生專案用 DF
    tc_format = "DF" if den == 1001 else "NDF"
    size, y = _num(style["font_size"]), _num(style["y"])

    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE fcpxml>",
        "",
        '<fcpxml version="1.8">',
        "  <resources>",
        f'    <format id="r1" frameDuration="{_time(1, num, den)}" width="{v["width"]}" '
        f'height="{v["height"]}" colorSpace="1-1-1 (Rec. 709)"/>',
        f'    <effect id="r2" name="{EFFECT_NAME}" uid="{EFFECT_UID}"/>',
        "  </resources>",
        '  <event name="SubMaker">',
        f'    <project name="{_attr(work["name"])}">',
        f'      <sequence duration="{t(total)}" format="r1" tcStart="0s" tcFormat="{tc_format}" '
        'audioLayout="stereo" audioRate="48k">',
        "        <spine>",
        f'          <gap name="間隔" offset="0s" duration="{t(total)}">',
    ]
    for i, s in enumerate(subs, 1):
        text = s["text"]
        out += [
            f'<title name="{_attr(text + NAME_SUFFIX)}" lane="1" offset="{t(s["start"])}" '
            f'ref="r2" duration="{t(s["end"] - s["start"])}">',
            f'<param name="位置" key="9999/10199/10201/1/100/101" value="0 {y}"/>',
            '<param name="對齊方式" key="9999/10199/10201/2/354/1002961760/401" value="1 (置中)"/>',
            '<param name="Out Sequencing" key="9999/10199/10201/4/10233/201/202" value="0 (至)"/>',
            "<text>",
            f'  <text-style ref="ts{i}">{_text(text)}</text-style>',
            "</text>",
            f'<text-style-def id="ts{i}">',
            f"  <text-style {TEXT_STYLE.format(size=size)}/>",
            "</text-style-def>",
            "</title>",
        ]
    out += [
        "          </gap>",
        "        </spine>",
        "      </sequence>",
        "    </project>",
        "  </event>",
        "</fcpxml>",
        "",
    ]
    return "\n".join(out)


def check_subtitles(subs: list[dict], total_frames: int) -> list[str]:
    """編輯中的字幕檢查（SPEC §4.4），回傳問題清單。前端也做同樣的檢查。"""
    problems = []
    for i, s in enumerate(subs, 1):
        if not s["text"].strip():
            problems.append(f"第 {i} 條沒有文字")
        if s["start"] < 0:
            problems.append(f"第 {i} 條起點小於 0")
        if s["end"] <= s["start"]:
            problems.append(f"第 {i} 條起點沒有早於終點")
        if s["end"] > total_frames:
            problems.append(f"第 {i} 條超出影片長度")
        if i < len(subs) and subs[i]["start"] < s["end"]:
            problems.append(f"第 {i} 條和第 {i + 1} 條時間重疊")
    return problems


def verify(xml: str, work: dict) -> list[str]:
    """匯出前自我檢查（SPEC §5 第 4 點）：把產生的 XML 讀回來逐條驗證。"""
    v, subs = work["video"], work["subtitles"]
    frame = Fraction(v["fps_den"], v["fps_num"])
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        return [f"XML 格式錯誤：{e}"]
    problems = []
    titles = root.findall(".//title")
    if len(titles) != len(subs):
        problems.append(f"字幕條數不符：應有 {len(subs)} 條，XML 裡有 {len(titles)} 條")
    seq_end = _parse_time(root.find(".//sequence").get("duration"))
    prev_end = Fraction(0)
    for i, (el, s) in enumerate(zip(titles, subs), 1):
        text = el.find("./text/text-style").text or ""
        if text != s["text"]:
            problems.append(f"第 {i} 條文字和編輯內容不一致")
        if el.get("name") != text + NAME_SUFFIX:
            problems.append(f"第 {i} 條 name 不等於「文字 + ' - {EFFECT_NAME}'」，FCP 標籤會不同步")
        start, dur = _parse_time(el.get("offset")), _parse_time(el.get("duration"))
        if (start / frame).denominator != 1 or (dur / frame).denominator != 1:
            problems.append(f"第 {i} 條時間沒有對齊影格")
        if dur <= 0:
            problems.append(f"第 {i} 條長度不是正數")
        if start < prev_end:
            problems.append(f"第 {i} 條和前一條時間重疊")
        if start + dur > seq_end:
            problems.append(f"第 {i} 條超出影片長度")
        prev_end = start + dur
    return problems

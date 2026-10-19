"""自動整理（SPEC §4.6.1）。

依序：刪語助詞與笑聲 → 刪口吃疊字 → 數量改阿拉伯數字 → 中英數之間加空格
→ 英文開頭大寫 → 超過 18 字自動拆句。每一處改動都記進 log，給「查看」清單使用。
"""
import re

CJK = "㐀-䶿一-鿿"

# ───────── 1. 語助詞、笑聲 ─────────

FILLER = re.compile(r"嗯+|呃+|哈{2,}")


def _tidy(t: str) -> str:
    return re.sub(r"[ 　]{2,}", " ", t).strip()


# ───────── 2. 口吃疊字 ─────────

# 相鄰重複的 1～4 個中文字（取最短的單位：「這個這個」的單位是「這個」）
REPEAT = re.compile(f"([{CJK}]{{1,4}}?)\\1+")

# 疊詞保留清單的預設內容（SPEC §4.6.1）；所有影片共用，可在「取代規則」視窗修改
DEFAULT_KEEP = [
    "剛剛", "謝謝", "拜拜", "奶奶", "爺爺", "媽媽", "爸爸", "哥哥", "姐姐", "姊姊", "弟弟", "妹妹",
    "姑姑", "叔叔", "伯伯", "舅舅", "婆婆", "公公", "寶寶", "看看", "試試", "想想", "聽聽", "走走",
    "等等", "常常", "慢慢", "好好", "天天", "人人", "漸漸", "偷偷", "往往", "紛紛", "默默", "輕輕",
    "久久", "星星", "啾啾", "非常非常", "對對對", "一一",
]


def repeat_unit(word: str) -> str | None:
    """「剛剛」→「剛」、「非常非常」→「非常」；不是疊字就回傳 None。"""
    m = REPEAT.fullmatch(word.strip())
    return m.group(1) if m else None


def keep_units(keep: list[str]) -> set[str]:
    return {u for u in (repeat_unit(w) for w in keep) if u}


# ───────── 3. 數量改阿拉伯數字 ─────────

MEASURES = sorted(
    "個 人 位 次 遍 下 天 日 年 月 號 週 點 分 分鐘 秒 小時 歲 塊 元 倍 件 張 隻 台 部 集 場 本 條 顆 "
    "杯 碗 份 種 家 輛 間 層 樓 頁 公里 公尺 公分 公斤 度 圈 雙 套 箱 包 瓶 支 把 根 片 首 句 段".split(),
    key=len, reverse=True)
CN_DIGITS = "零一二兩三四五六七八九"
CN_NUM = f"[{CN_DIGITS}十百千萬]+"
# 前面是「第、幾、上、數、好、成、多」或另一個中文數字時不改（序數、概數）
NUMBER = re.compile(f"(?<![第幾上數好成多{CN_DIGITS}十百千萬])({CN_NUM})(?=({'|'.join(MEASURES)}))")
PERCENT = re.compile(f"百分之({CN_NUM})")
# 兩個不同的個位數字相連＝概數（兩三、三四、七八）
APPROX = re.compile(f"[{CN_DIGITS[1:]}][{CN_DIGITS[1:]}]")
# 注意不能直接用 CN_DIGITS 編號：它多了「兩」，會讓三以後全部偏一位
_D = {c: i for i, c in enumerate("零一二三四五六七八九")} | {"兩": 2}


def cn2int(s: str) -> int | None:
    """中文數字轉整數（萬以內的一般寫法），看不懂就回傳 None。"""
    total, section, digit = 0, 0, None
    for ch in s:
        if ch in _D:
            if digit is not None and ch != "零":
                return None  # 兩個數字相連（概數或寫法不明）
            digit = _D[ch] if ch != "零" else None
        elif ch in "十百千":
            unit = {"十": 10, "百": 100, "千": 1000}[ch]
            section += (digit if digit is not None else 1) * unit
            digit = None
        elif ch == "萬":
            total = (section + (digit or 0)) * 10000
            section, digit = 0, None
        else:
            return None
    return total + section + (digit or 0)


# ───────── 4、5. 空格、英文大寫 ─────────

SPACE_L = re.compile(f"([{CJK}])([A-Za-z0-9])")
SPACE_R = re.compile(f"([A-Za-z0-9%])([{CJK}])")
ENGLISH_RUN = re.compile(r"(?<![A-Za-z])[A-Za-z][A-Za-z'\-]*")


# ───────── 6. 字數與拆句 ─────────

MAX_WIDTH = 18
CONJ = ("但是", "可是", "然後", "所以", "因為", "如果", "而且", "不過", "就是", "結果")
PARTICLES = tuple("啊吧呢嗎啦喔欸耶了")
PUNCT = set("，。、？！；：,.?!;:…")


def width(t: str) -> float:
    """中文與全形符號算 1，英文字母、數字、半形符號算 0.5，空格不算。"""
    w = 0.0
    for ch in t:
        if ch in " 　\n":
            continue
        w += 0.5 if ord(ch) < 0x2E80 else 1
    return w


def _boundaries(text: str, segment) -> list[int]:
    """可以斷開的位置：詞與詞之間（不切開中文詞、英文單字、數字）。"""
    pos, out = 0, []
    for tok in segment(text):
        pos += len(tok)
        out.append(pos)
    return [b for b in out if 0 < b < len(text)]


def _split_text(text: str, segment) -> list[str]:
    if width(text) <= MAX_WIDTH:
        return [text]
    best, best_ok = None, False
    for b in _boundaries(text, segment):
        left, right = text[:b].rstrip(), text[b:].lstrip()
        if not left or not right:
            continue
        wl, wr = width(left), width(right)
        score = -abs(wl - wr)
        if text[b - 1] in PUNCT or text[b - 1] == " " or text[b] == " ":
            score += 6
        if right.startswith(CONJ):
            score += 4
        if left.endswith(PARTICLES):
            score += 4
        ok = wl <= MAX_WIDTH and wr <= MAX_WIDTH
        # 兩邊都不超過 18 字的優先；都超過時取最平均的，再各自往下拆
        if best is None or (ok, score) > (best_ok, best[0]):
            best, best_ok = (score, left, right), ok
    if best is None:
        return [text]  # 找不到可以斷的地方（例如一整串沒有空格的英文）
    return _split_text(best[1], segment) + _split_text(best[2], segment)


def _quietest(peaks: bytes | None, est: int, lo: int, hi: int, fps: float) -> int:
    """在估計的影格前後 0.4 秒內，找聲音最小的時刻（講話的停頓）。lo～hi 是可以選的範圍。"""
    if not peaks or hi <= lo:
        return max(lo, min(hi, est))
    win = round(0.4 * fps)
    cand = range(max(lo, est - win), min(hi, est + win) + 1)
    if not cand:
        return max(lo, min(hi, est))

    def loudness(f):  # 以該格為中心、前後 50ms 的平均峰值
        c = round(f / fps * 100)
        seg = peaks[max(0, c - 5):c + 5]
        return sum(seg) / len(seg) if seg else 0

    # 一樣安靜時選離估計點近的
    return min(cand, key=lambda f: (loudness(f), abs(f - est)))


# ───────── 主流程 ─────────

def run(subs: list[dict], keep: list[str], next_id: int, fps: float,
        peaks: bytes | None, segment) -> tuple[list[dict], list[dict], int]:
    """回傳（整理後的字幕, 改動紀錄, 新的 next_id）。segment(text) 回傳斷詞結果。"""
    log = []
    units = keep_units(keep)
    out = []

    for s in subs:
        s = dict(s)
        sid = s["id"]

        def note(rule, before, after, **extra):
            log.append({"rule": rule, "sid": sid, "before": before, "after": after, **extra})

        # 1. 語助詞、笑聲
        t = _tidy(FILLER.sub("", s["text"]))
        if t != s["text"]:
            note("語助詞", s["text"], t)
        if not t:
            log[-1]["dropped"] = True  # 刪完變空白：整條刪除
            continue

        # 2. 口吃疊字（保留清單裡的不刪）
        def fix_repeat(m):
            unit = m.group(1)
            if unit in units:
                return m.group(0)
            note("疊字", m.group(0), unit, pos=m.start())
            return unit
        t = REPEAT.sub(fix_repeat, t)

        # 3. 數量改阿拉伯數字
        def fix_percent(m):
            n = cn2int(m.group(1))
            if n is None:
                return m.group(0)
            note("數字", m.group(0), f"{n}%")
            return f"{n}%"
        t = PERCENT.sub(fix_percent, t)

        def fix_number(m):
            cn = m.group(1)
            if cn == "一" or APPROX.search(cn):
                return cn
            n = cn2int(cn)
            if n is None:
                return cn
            note("數字", cn + m.group(2), f"{n}{m.group(2)}")
            return str(n)
        t = NUMBER.sub(fix_number, t)

        # 4. 中文和英文、數字之間加空格
        spaced = SPACE_R.sub(r"\1 \2", SPACE_L.sub(r"\1 \2", t))
        if spaced != t:
            note("空格", t, spaced)
            t = spaced

        # 5. 每段英文的第一個字，全是小寫才把開頭改大寫
        def cap(m):
            w = m.group(0)
            prev = t[:m.start()].rstrip()
            starts_run = not prev or not re.search(r"[A-Za-z]$", prev)
            if starts_run and w.islower():
                note("大寫", w, w[0].upper() + w[1:])
                return w[0].upper() + w[1:]
            return w
        t = ENGLISH_RUN.sub(cap, t)

        s["text"] = t

        # 6. 超過 18 字自動拆成多條
        parts = _split_text(t, segment)
        if len(parts) == 1:
            out.append(s)
            continue
        weights = [max(width(p), 0.5) for p in parts]
        total_w, dur = sum(weights), s["end"] - s["start"]
        # 每段至少 0.3 秒；字幕本身太短排不下時，改成平均分配，切點才不會超出範圍或前後顛倒
        min_len = max(1, min(round(0.3 * fps), dur // len(parts)))
        cuts, acc = [], 0.0
        for k, w in enumerate(weights[:-1]):
            acc += w
            est = s["start"] + round(dur * acc / total_w)
            lo = (cuts[-1] if cuts else s["start"]) + min_len
            hi = s["end"] - min_len * (len(parts) - 1 - k)
            cuts.append(_quietest(peaks, est, lo, hi, fps))
        bounds = [s["start"]] + cuts + [s["end"]]
        for k, p in enumerate(parts):
            piece = dict(s, text=p, start=bounds[k], end=bounds[k + 1])
            if k:
                piece["id"], piece["orig"] = next_id, ""
                next_id += 1
            out.append(piece)
        note("拆句", t, "｜".join(parts))

    return out, log, next_id

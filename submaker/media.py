"""影片資訊（ffprobe）與預覽檔轉檔（SPEC §4.1、§5 第 3 點）。"""
import json
import subprocess
from array import array
from fractions import Fraction
from pathlib import Path

# 瀏覽器（Safari）可直接播放的編碼；其他編碼要轉預覽檔
PLAYABLE_CODECS = {"h264", "hevc"}


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise ValueError(f"ffprobe 讀不了這個檔案：{out.stderr.strip()[:200]}")
    data = json.loads(out.stdout)
    videos = [s for s in data["streams"] if s.get("codec_type") == "video"
              and not s.get("disposition", {}).get("attached_pic")]
    if not videos:
        raise ValueError("檔案裡沒有影像軌")
    v = videos[0]  # 多條影像軌時只用第一條

    # 影格率一律保留分數，不可四捨五入（59.94 = 60000/1001）
    rate = Fraction(v.get("r_frame_rate") or v["avg_frame_rate"])
    if rate <= 0:
        rate = Fraction(v["avg_frame_rate"])
    width, height = int(v["width"]), int(v["height"])
    rotation = 0
    for sd in v.get("side_data_list", []):
        if "rotation" in sd:
            rotation = int(sd["rotation"])
    if abs(rotation) % 180 == 90:
        width, height = height, width

    duration = float(data["format"].get("duration") or v.get("duration") or 0)
    if duration <= 0:
        raise ValueError("讀不到影片長度")
    return {
        "width": width,
        "height": height,
        "fps_num": rate.numerator,
        "fps_den": rate.denominator,
        "duration_frames": round(duration * rate),
        "codec": v.get("codec_name", ""),
        "video_streams": len(videos),
        "audio_streams": sum(1 for s in data["streams"] if s.get("codec_type") == "audio"),
        "playable": v.get("codec_name") in PLAYABLE_CODECS,
    }


def start_preview(src: Path, dst: Path) -> subprocess.Popen:
    """開始轉一份瀏覽器可播的 H.264 預覽檔（先寫到暫存檔），原檔不動。
    只縮小畫面、不改影格率與長度，字幕時間才會和原檔一致。
    進度從 stdout 的 out_time_us= 讀；由呼叫端負責在中斷時停掉程序。"""
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
           "-vf", "scale=-2:'min(1080,ih)'", "-c:v", "h264_videotoolbox", "-b:v", "8M",
           "-c:a", "aac", "-b:a", "160k", "-progress", "pipe:1", "-nostats", str(preview_tmp(dst))]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def preview_tmp(dst: Path) -> Path:
    return dst.with_suffix(".part.mp4")


def finish_preview(proc: subprocess.Popen, dst: Path) -> None:
    """ffmpeg 結束後呼叫：成功就把暫存檔改名成正式預覽檔，失敗就清掉暫存檔。"""
    tmp = preview_tmp(dst)
    if proc.wait() != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("預覽檔轉檔失敗：" + proc.stderr.read().strip()[:200])
    tmp.rename(dst)


def stop_preview(proc: subprocess.Popen, dst: Path) -> None:
    """中途停止（例如使用者關掉網頁），清掉暫存檔。"""
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    preview_tmp(dst).unlink(missing_ok=True)


# ───────── 聲音波形（SPEC §4.3.3） ─────────
# 解成 4000Hz 單聲道 16-bit，每 40 個取樣取一個峰值 = 每秒 100 點，存成 0~255 的位元組

PEAK_RATE = 4000
PEAKS_PER_SEC = 100
_BIN = PEAK_RATE // PEAKS_PER_SEC


def start_peaks(src: Path) -> subprocess.Popen:
    cmd = ["ffmpeg", "-v", "error", "-i", str(src), "-map", "0:a:0", "-vn",
           "-ac", "1", "-ar", str(PEAK_RATE), "-f", "s16le", "-"]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


class PeakBuilder:
    """一段一段餵入原始取樣，算出峰值。"""

    def __init__(self):
        self.peaks = bytearray()
        self.samples = 0
        self._rest = b""

    def feed(self, chunk: bytes) -> None:
        buf = self._rest + chunk
        usable = len(buf) // (_BIN * 2) * (_BIN * 2)
        self._rest = buf[usable:]
        a = array("h")
        a.frombytes(buf[:usable])
        self.samples += len(a)
        for i in range(0, len(a), _BIN):
            seg = a[i:i + _BIN]
            p = max(max(seg), -min(seg))
            self.peaks.append(min(255, p * 255 // 32767))

    def finish(self) -> bytes:
        if len(self._rest) >= 2:
            a = array("h")
            a.frombytes(self._rest[:len(self._rest) // 2 * 2])
            self.peaks.append(min(255, max(max(a), -min(a)) * 255 // 32767))
        return bytes(self.peaks)

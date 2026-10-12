"""SubMaker 本機網站後端。執行：.venv/bin/python app.py，再用 Safari 開 http://127.0.0.1:8765"""
import json
import mimetypes
from pathlib import Path
from urllib.parse import quote, unquote

import opencc
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from submaker import fcpxml, media, srt, store

HERE = Path(__file__).resolve().parent
app = FastAPI()
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
converter = opencc.OpenCC("s2twp")  # SPEC §4.2：台灣用字


@app.middleware("http")
async def no_stale_pages(request: Request, call_next):
    # 沒有這個標頭時，Safari 會沿用快取裡的舊 app.js，重新整理也拿不到新程式。
    # no-cache 是每次都向伺服器確認，沒變就回 304 繼續用快取
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _ndjson(gen):
    return StreamingResponse((json.dumps(x, ensure_ascii=False) + "\n" for x in gen),
                             media_type="application/x-ndjson")


def _need_work(wid: str) -> dict:
    work = store.load_work(wid)
    if work is None:
        raise HTTPException(404, "找不到這支影片的工作檔，請重新開啟影片")
    return work


@app.get("/")
def index():
    return FileResponse(HERE / "static" / "index.html")


@app.get("/api/presets")
def presets():
    return store.PRESETS


# Safari 不讓網頁使用使用者自行安裝的字型，所以由後端直接提供字型檔，
# 預覽才會和 FCP 用同一個思源黑體 TW 粗體
FONT_DIRS = [Path.home() / "Library/Fonts", Path("/Library/Fonts")]


@app.get("/api/font")
def font():
    for d in FONT_DIRS:
        for f in sorted(d.glob("SourceHanSansTW-Bold.*")):
            return FileResponse(f, media_type="font/otf")
    raise HTTPException(404, "找不到思源黑體 TW 粗體字型檔（SourceHanSansTW-Bold）")


@app.post("/api/open")
async def open_video(req: Request):
    raw = (await req.json()).get("path", "").strip().strip("'\"")
    path = Path(raw).expanduser()
    if not raw or not path.is_file():
        raise HTTPException(400, f"找不到影片檔：{raw}")
    path = path.resolve()
    try:
        info = media.probe(path)
    except ValueError as e:
        raise HTTPException(400, str(e))

    wid = store.work_id(str(path))
    work = store.load_work(wid)
    if work is None:
        preset = "portrait" if info["height"] > info["width"] else "landscape"
        p = store.PRESETS[preset]
        work = {
            "name": path.stem,
            "video_path": str(path),
            "preset": preset,
            "style": {"font_size": p["font_size"], "y": p["y"]},
            "srt_name": None,
            "next_id": 1,
            "subtitles": [],
        }
    work["video"] = info  # 影片資訊每次都重讀，以實際檔案為準
    store.save_work(wid, work)
    has_preview = (store.work_dir(wid) / "preview.mp4").exists()
    return {"id": wid, "work": work, "has_preview": has_preview}


@app.get("/api/video/{wid}")
def video(wid: str):
    work = _need_work(wid)
    preview = store.work_dir(wid) / "preview.mp4"
    path = preview if preview.exists() else Path(work["video_path"])
    if not path.is_file():
        raise HTTPException(404, "影片檔不見了")
    mime = mimetypes.guess_type(path.name)[0] or "video/mp4"
    return FileResponse(path, media_type=mime)  # 支援 Range，Safari 才能拖動


@app.post("/api/preview/{wid}")
def preview(wid: str):
    """瀏覽器播不了原檔時，轉一份預覽檔（SPEC §4.1）。"""
    work = _need_work(wid)
    v = work["video"]
    seconds = v["duration_frames"] * v["fps_den"] / v["fps_num"]
    dst = store.work_dir(wid) / "preview.mp4"

    async def run():
        proc = media.start_preview(Path(work["video_path"]), dst)
        finished = False
        try:
            while line := await run_in_threadpool(proc.stdout.readline):
                if line.startswith("out_time_us="):
                    try:
                        p = min(int(line.split("=")[1]) / 1e6 / seconds, 1.0)
                    except ValueError:
                        continue
                    yield json.dumps({"progress": round(p, 3)}) + "\n"
            try:
                await run_in_threadpool(media.finish_preview, proc, dst)
                yield json.dumps({"done": True}) + "\n"
            except RuntimeError as e:
                yield json.dumps({"error": str(e)}, ensure_ascii=False) + "\n"
            finished = True
        finally:
            # 網頁斷線時伺服器會取消這個工作，在這裡把 ffmpeg 一起停掉，不然會在背景一直轉
            if not finished:
                media.stop_preview(proc, dst)
    return StreamingResponse(run(), media_type="application/x-ndjson")


@app.post("/api/peaks/{wid}")
def make_peaks(wid: str):
    """產生聲音資料（audio.pcm，SPEC §4.3.0）與波形（peaks.u8，§4.3.3）。
    有預覽檔就從預覽檔解，比原檔小很多。"""
    work = _need_work(wid)
    v = work["video"]
    if not v.get("audio_streams"):
        raise HTTPException(400, "這支影片沒有聲音")
    seconds = v["duration_frames"] * v["fps_den"] / v["fps_num"]
    d = store.work_dir(wid)
    preview = d / "preview.mp4"
    src = preview if preview.exists() else Path(work["video_path"])

    async def run():
        proc = media.start_audio(src)
        tmp = d / "audio.pcm.part"
        ok = False
        try:
            with open(tmp, "wb") as pcm:
                builder, last = media.AudioBuilder(pcm), -1.0
                # 每次讀約 10 秒的聲音
                while chunk := await run_in_threadpool(proc.stdout.read, media.AUDIO_RATE * 2 * 10):
                    await run_in_threadpool(builder.feed, chunk)
                    p = min(builder.samples / (seconds * media.AUDIO_RATE), 1.0)
                    if p - last >= 0.01:
                        last = p
                        yield json.dumps({"progress": round(p, 3)}) + "\n"
            if await run_in_threadpool(proc.wait) != 0:
                msg = proc.stderr.read().decode("utf-8", "replace").strip()[:200]
                yield json.dumps({"error": "聲音處理失敗：" + msg}, ensure_ascii=False) + "\n"
                return
            tmp.rename(d / "audio.pcm")
            (d / "peaks.u8").write_bytes(builder.finish())
            ok = True
            yield json.dumps({"done": True}) + "\n"
        finally:
            if proc.poll() is None:  # 網頁斷線時停掉 ffmpeg
                proc.kill()
                proc.wait()
            if not ok:
                tmp.unlink(missing_ok=True)
    return StreamingResponse(run(), media_type="application/x-ndjson")


@app.get("/api/peaks/{wid}")
def get_peaks(wid: str):
    d = store.work_dir(wid)
    # 波形和聲音資料要一起有；舊版只有波形時也重新產生
    if not (d / "peaks.u8").exists() or not (d / "audio.pcm").exists():
        raise HTTPException(404, "還沒有聲音資料")
    return FileResponse(d / "peaks.u8", media_type="application/octet-stream")


AUDIO_CHUNK_SEC = 20


@app.get("/api/audio/{wid}/{k}")
def audio_chunk(wid: str, k: int):
    """第 k 段聲音（每段 20 秒），WAV 格式，給 Web Audio 播放（SPEC §4.3.0）。"""
    f = store.work_dir(wid) / "audio.pcm"
    if not f.exists() or k < 0:
        raise HTTPException(404, "沒有聲音資料")
    size = AUDIO_CHUNK_SEC * media.AUDIO_RATE * 2
    with open(f, "rb") as fh:
        fh.seek(k * size)
        data = fh.read(size)
    if not data:
        raise HTTPException(404, "超出影片長度")
    return Response(media.wav_header(len(data)) + data, media_type="audio/wav")


@app.post("/api/srt/{wid}")
async def load_srt(wid: str, req: Request):
    """讀入 srt 並自動簡轉繁，邊轉邊回報進度（SPEC §4.1、§4.2）。"""
    work = _need_work(wid)
    raw = await req.body()
    name = unquote(req.headers.get("x-filename", "subtitle.srt"))
    try:
        text, encoding = srt.decode(raw)
        items = srt.parse(text)
    except ValueError as e:
        raise HTTPException(400, str(e))
    num, den = work["video"]["fps_num"], work["video"]["fps_den"]
    to_frame = lambda ms: round(ms * num / (den * 1000))  # 對齊到最近的影格

    def run():
        total, subs = len(items), []
        for i, it in enumerate(items, 1):
            start = to_frame(it["start_ms"])
            subs.append({
                "id": i,
                "start": start,
                "end": max(to_frame(it["end_ms"]), start + 1),
                "text": converter.convert(it["text"]),
                "orig": it["text"],  # 簡體原文，只存不顯示
            })
            if i % 20 == 0 or i == total:
                yield {"progress": i, "total": total}
        # 轉完自動套用「直接全換」的規則；「逐條確認」的不動（SPEC §4.2、§4.6）
        applied = []
        for r in store.load_rules():
            if r["mode"] != "all" or not r["find"]:
                continue
            n = 0
            for s in subs:
                n += s["text"].count(r["find"])
                s["text"] = s["text"].replace(r["find"], r["replace"])
            applied.append({"find": r["find"], "replace": r["replace"], "count": n})
        work.update(subtitles=subs, next_id=total + 1, srt_name=name)
        store.save_work(wid, work)
        yield {"done": True, "encoding": encoding, "applied": applied, "work": work}
    return _ndjson(run())


@app.put("/api/work/{wid}")
async def save_work(wid: str, req: Request):
    """自動存檔。只接受前端可以編輯的欄位，影片資訊以後端為準。"""
    work = _need_work(wid)
    body = await req.json()
    for key in ("subtitles", "style", "preset", "next_id"):
        if key in body:
            work[key] = body[key]
    store.save_work(wid, work)
    return {"ok": True}


@app.get("/api/rules")
def get_rules():
    return store.load_rules()


@app.put("/api/rules")
async def put_rules(req: Request):
    rules = await req.json()
    clean = [{"find": r["find"], "replace": r.get("replace", ""),
              "mode": "confirm" if r.get("mode") == "confirm" else "all",
              "note": r.get("note", "")} for r in rules if r.get("find")]
    store.save_rules(clean)
    return clean


@app.post("/api/export/{wid}")
def export(wid: str):
    """匯出 .fcpxml；先檢查字幕，產生後再讀回來驗證，任何一項不過就不匯出（SPEC §5）。"""
    work = _need_work(wid)
    problems = fcpxml.check_subtitles(work["subtitles"], work["video"]["duration_frames"])
    if not work["subtitles"]:
        problems.append("沒有任何字幕")
    if problems:
        raise HTTPException(400, {"problems": problems})
    xml = fcpxml.build(work)
    problems = fcpxml.verify(xml, work)
    if problems:
        raise HTTPException(500, {"problems": problems})
    (store.work_dir(wid) / "export.fcpxml").write_text(xml, encoding="utf-8")
    filename = quote(work["name"] + ".fcpxml")
    return Response(xml.encode("utf-8"), media_type="application/xml",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"})


if __name__ == "__main__":
    # 只開放本機連線：這個後端可以讀取本機任意影片路徑
    uvicorn.run(app, host="127.0.0.1", port=8765)

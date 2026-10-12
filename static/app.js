"use strict";
// SubMaker 前端。規格見 SPEC.md；註解裡的 §x.x 指的是 SPEC 章節。

const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), stage = $("stage"), list = $("list");

const S = {
  wid: null,
  work: null,      // 後端的工作檔：video、preset、style、subtitles、next_id
  presets: {},
  sel: -1,         // 選取中的字幕
  playing: -1,     // 播放頭所在的字幕
  undo: [], redo: [],
  editSnap: null,  // 正在編輯文字的那條，開始編輯前的快照
  problems: [],
};
const subs = () => S.work.subtitles;

// ───────── 影格與時間碼 ─────────
// 時間一律存成「第幾格」的整數，所以天生對齊影格（§4.4）

const fps = () => S.work.video.fps_num / S.work.video.fps_den;
const nominal = () => Math.round(fps());
const isDF = () => S.work.video.fps_den === 1001; // 29.97、59.94 和 FCP 一樣用 drop-frame
const dropPerMin = () => nominal() / 15;          // 29.97 掉 2 格、59.94 掉 4 格

function framesToTC(f) {
  const R = nominal();
  if (isDF()) {
    const D = dropPerMin(), per10 = R * 600 - D * 9, perMin = R * 60 - D;
    const d = Math.floor(f / per10), m = f % per10;
    f += D * 9 * d + (m > D ? D * Math.floor((m - D) / perMin) : 0);
  }
  const ff = f % R, ss = Math.floor(f / R) % 60, mm = Math.floor(f / (R * 60)) % 60, hh = Math.floor(f / (R * 3600));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}${isDF() ? ";" : ":"}${p(ff)}`;
}

function tcToFrames(str) {
  const parts = str.trim().split(/[:;.,]/).map((x) => x.trim());
  if (!parts.length || parts.length > 4 || parts.some((x) => !/^\d+$/.test(x))) return null;
  while (parts.length < 4) parts.unshift("0");
  const [hh, mm, ss, ff] = parts.map(Number), R = nominal();
  if (ff >= R || ss >= 60 || mm >= 60) return null;
  let f = ((hh * 60 + mm) * 60 + ss) * R + ff;
  if (isDF()) {
    const mins = hh * 60 + mm;
    f -= dropPerMin() * (mins - Math.floor(mins / 10));
  }
  return f;
}

const frameToSec = (f) => (f * S.work.video.fps_den) / S.work.video.fps_num;
const curFrame = () => Math.min(Math.floor(playheadSec() * fps() + 1e-3), S.work.video.duration_frames - 1);

function seekFrame(f) {
  f = Math.max(0, Math.min(f, S.work.video.duration_frames - 1));
  const sec = frameToSec(f) + 0.25 / fps(); // 落在該格中間，避免浮點誤差跳到前一格
  if (AUD.playing) restartAudio(sec);
  else { video.currentTime = sec; prefetchAudio(sec); }
  draw(f); drawWave(f);
}

// ───────── 聲音播放（§4.3.0） ─────────
// Safari 的影片元件按下播放後，聲音要晚約 0.3 秒才出來（實測中位數 284ms）。
// 所以聲音改用 Web Audio 播放：後端把聲音切成每段 20 秒的 WAV，事先載入播放頭附近的片段，
// 按下播放立即出聲。影片元件靜音只負責畫面，播放中一切時間以聲音為準

const CHUNK_SEC = 20, MAX_CHUNKS = 12;
const AUD = {
  ctx: null, ready: false, wid: null,
  chunks: new Map(),  // 段號 → AudioBuffer（Promise）
  playing: false, session: 0, sources: [],
  anchorCtx: 0, anchorSec: 0, nextK: 0,
};

function audioCtx() {
  if (!AUD.ctx) AUD.ctx = new AudioContext();
  return AUD.ctx;
}

// 目前「聽到的」位置（秒）：播放中看聲音時鐘並扣掉喇叭輸出延遲，暫停時看影片位置
function playheadSec() {
  if (!AUD.playing) return video.currentTime;
  const c = AUD.ctx, heard = c.currentTime - AUD.anchorCtx - (c.outputLatency || 0);
  return AUD.anchorSec + Math.max(0, heard);
}

const isPlaying = () => AUD.playing || !video.paused;

function getChunk(k) {
  if (!AUD.chunks.has(k)) {
    const wid = AUD.wid;
    const p = fetch(`/api/audio/${wid}/${k}`)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((b) => audioCtx().decodeAudioData(b));
    p.catch(() => AUD.chunks.delete(k));
    AUD.chunks.set(k, p);
    // 只留最近用到的幾段，避免長片吃太多記憶體
    while (AUD.chunks.size > MAX_CHUNKS) AUD.chunks.delete(AUD.chunks.keys().next().value);
  }
  return AUD.chunks.get(k);
}

function prefetchAudio(sec) {
  if (!AUD.ready) return;
  const k = Math.floor(sec / CHUNK_SEC);
  getChunk(k).catch(() => {});
  getChunk(k + 1).catch(() => {});
}

// 把第 k 段排在聲音時鐘上正確的時間點播放；來晚了就從中間接上
function scheduleChunk(k, buf) {
  const c = AUD.ctx, when = AUD.anchorCtx + (k * CHUNK_SEC - AUD.anchorSec);
  const src = c.createBufferSource();
  src.buffer = buf; src.connect(c.destination);
  const late = c.currentTime - when;
  if (late > 0) { if (late < buf.duration) src.start(c.currentTime, late); }
  else src.start(when);
  AUD.sources.push(src);
  src.onended = () => (AUD.sources = AUD.sources.filter((x) => x !== src));
}

function stopAudio() {
  AUD.session++;
  for (const s of AUD.sources) { try { s.stop(); } catch {} }
  AUD.sources = [];
}

async function playerPlay() {
  if (!S.work) return;
  if (!AUD.ready) { video.muted = false; video.play(); return; } // 聲音資料還沒好：先用影片本身的聲音
  const c = audioCtx();
  c.resume(); // 必須在使用者按鍵的當下呼叫
  const pos = video.currentTime, k = Math.floor(pos / CHUNK_SEC), session = ++AUD.session;
  let buf;
  try { buf = await getChunk(k); } catch { AUD.ready = false; video.muted = false; video.play(); return; }
  if (session !== AUD.session) return; // 等待期間又按了暫停或跳轉
  AUD.anchorCtx = c.currentTime + 0.01; AUD.anchorSec = pos; AUD.nextK = k + 1; AUD.playing = true;
  scheduleChunk(k, buf);
  video.muted = true; video.play();
  $("playBtn").textContent = "❚❚";
}

function playerPause() {
  if (AUD.playing) {
    const pos = playheadSec();
    stopAudio(); AUD.playing = false;
    video.pause(); video.currentTime = pos;
    prefetchAudio(pos);
  } else {
    AUD.session++; // 取消還在等待載入的播放
    video.pause();
  }
  $("playBtn").textContent = "▶";
}

function restartAudio(sec) {
  stopAudio(); AUD.playing = false;
  video.currentTime = sec;
  playerPlay();
}

// 每格呼叫：提前載入並排好下一段；畫面和聲音差太多就對齊；播到結尾就停
function audioTick() {
  if (!AUD.playing) return;
  const now = playheadSec(), total = frameToSec(S.work.video.duration_frames);
  if (now >= total) { playerPause(); return; }
  if (AUD.nextK * CHUNK_SEC - now < 8) {
    const k = AUD.nextK++, session = AUD.session;
    getChunk(k).then((buf) => { if (session === AUD.session) scheduleChunk(k, buf); }).catch(() => {});
  }
  if (!video.seeking && Math.abs(video.currentTime - now) > 0.15) video.currentTime = now;
}

function resetAudio(wid) {
  stopAudio(); AUD.playing = false; AUD.ready = false; AUD.wid = wid; AUD.chunks.clear();
}

// ───────── 共用 ─────────

async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (raw) { opt.body = raw.body; Object.assign(opt.headers, raw.headers); }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const res = await fetch(url, opt);
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.detail?.problems ? j.detail.problems.join("\n") : (j.detail || msg);
    } catch {}
    throw new Error(msg);
  }
  return res;
}

// 逐行讀 NDJSON 進度
async function readStream(res, onItem) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", last = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) { last = JSON.parse(line); onItem(last); }
    }
  }
  return last;
}

function message(text) { $("msgBody").textContent = text; $("msgDlg").showModal(); }

function busy(text, value, count) {
  $("busy").hidden = text === null;
  if (text === null) return;
  $("busyText").textContent = text;
  $("busyBar").value = value; $("busyCount").textContent = count || "";
}

const isTyping = () => {
  const a = document.activeElement;
  return a && (a.tagName === "TEXTAREA" || a.tagName === "SELECT" ||
    (a.tagName === "INPUT" && !["button", "range", "checkbox"].includes(a.type)));
};

// ───────── 開啟影片（§4.1） ─────────

async function openVideo(path) {
  try {
    const res = await api("POST", "/api/open", { path });
    const data = await res.json();
    S.wid = data.id; S.work = data.work; S.undo = []; S.redo = []; S.sel = -1; S.playing = -1;
    try { localStorage.setItem("submaker.lastPath", path); } catch {}
    $("pathInput").value = S.work.video_path;
    for (const id of ["srtBtn", "presetSel", "sizeInput", "yInput", "resetStyleBtn", "findBtn", "rulesBtn", "exportBtn", "playBtn", "seek"])
      $(id).disabled = false;
    WAVE.peaks = null; WAVE.status = ""; setSpan(0);
    resetAudio(S.wid); video.muted = false;
    $("stageHint").hidden = true;
    $("seek").max = S.work.video.duration_frames - 1;
    $("dur").textContent = framesToTC(S.work.video.duration_frames);
    const v = S.work.video;
    $("info").textContent = `${v.width}×${v.height} · ${(v.fps_num / v.fps_den).toFixed(3).replace(/\.?0+$/, "")} fps · ${v.codec}` +
      (v.video_streams > 1 ? `（${v.video_streams} 條影像軌，只用第一條）` : "");
    document.title = `${S.work.name} — SubMaker`;
    loadVideoSrc(data.has_preview);
    syncStyleInputs(); renderList(); draw();
  } catch (e) {
    message("開啟影片失敗：\n" + e.message);
  }
}

let triedPreview = false;
function loadVideoSrc(hasPreview) {
  triedPreview = hasPreview;
  video.removeAttribute("src"); video.load(); // 先停掉上一支影片的讀取
  // 不是 H.264／HEVC（例如 ProRes）就先轉預覽檔再播；4K ProRes 讓 Safari 直接播會嚴重卡頓（§4.1）
  if (!hasPreview && !S.work.video.playable) onVideoUnplayable(); // 轉完預覽檔後再算波形
  else { video.src = `/api/video/${S.wid}?v=${Date.now()}`; loadPeaks(); }
}

async function onVideoUnplayable() {
  if (triedPreview || !S.wid) {
    message("這支影片在瀏覽器裡播不了，預覽檔也失敗了。");
    return;
  }
  triedPreview = true;
  try {
    const title = "產生預覽檔中（原檔不動，每支影片只需轉一次）", t0 = Date.now();
    busy(title, 0, "");
    const res = await api("POST", `/api/preview/${S.wid}`);
    const last = await readStream(res, (x) => {
      if (x.progress === undefined) return;
      let eta = "";
      if (x.progress > 0.01) {
        const left = Math.round(((Date.now() - t0) / x.progress) * (1 - x.progress) / 1000);
        eta = `，約剩 ${Math.floor(left / 60)} 分 ${String(left % 60).padStart(2, "0")} 秒`;
      }
      busy(title, x.progress, `${Math.round(x.progress * 100)}%${eta}`);
    });
    if (last?.error) throw new Error(last.error);
    video.src = `/api/video/${S.wid}?v=${Date.now()}`;
    loadPeaks();
  } catch (e) {
    message("產生預覽檔失敗：\n" + e.message);
  } finally { busy(null); }
}

video.addEventListener("error", () => { if (video.src) onVideoUnplayable(); });
video.addEventListener("loadedmetadata", () => {
  if (!video.videoWidth) onVideoUnplayable(); // 只有聲音沒有畫面，視同播不了
  layoutOverlay();
});

// ───────── 載入 srt 與簡轉繁（§4.1、§4.2） ─────────

$("srtBtn").onclick = () => {
  if (subs().length && !confirm("重新載入 .srt 會取代目前所有字幕，而且無法復原。要繼續嗎？")) return;
  $("srtFile").value = "";
  $("srtFile").click();
};

$("srtFile").onchange = async () => {
  const file = $("srtFile").files[0];
  if (!file) return;
  try {
    busy("轉換中", 0, "");
    const res = await api("POST", `/api/srt/${S.wid}`, undefined, {
      body: await file.arrayBuffer(),
      headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
    });
    const last = await readStream(res, (x) => {
      if (x.total) busy("轉換中", x.progress / x.total, `${x.progress} / ${x.total}`);
    });
    if (!last?.done) throw new Error("轉換沒有完成");
    S.work = last.work; S.undo = []; S.redo = []; S.sel = -1;
    renderList(); draw();
    // 載入時自動套用了哪些「直接全換」規則（§4.2）
    const done = (last.applied || []).filter((a) => a.count);
    message(`已載入 ${subs().length} 條字幕（${last.encoding}），並轉成繁體。\n\n` +
      (done.length ? "自動套用的取代規則：\n" + done.map((a) => `　${a.find} → ${a.replace}：${a.count} 處`).join("\n")
        : "「直接全換」的規則沒有找到可以取代的地方。") +
      "\n\n「逐條確認」的規則（例如 里→裡）請從「取代規則」手動套用。");
  } catch (e) {
    message("載入字幕失敗：\n" + e.message);
  } finally { busy(null); }
};

// ───────── 樣式預設（§4.7） ─────────

function syncStyleInputs() {
  const sel = $("presetSel");
  sel.innerHTML = "";
  for (const [k, p] of Object.entries(S.presets)) sel.add(new Option(`${p.label}（${p.font_size}／Y ${p.y}）`, k));
  sel.value = S.work.preset;
  $("sizeInput").value = S.work.style.font_size;
  $("yInput").value = S.work.style.y;
}

function setStyle(preset, style) {
  snapshot();
  S.work.preset = preset; S.work.style = style;
  syncStyleInputs(); changed(); draw();
}

$("presetSel").onchange = () => {
  const p = S.presets[$("presetSel").value];
  setStyle($("presetSel").value, { font_size: p.font_size, y: p.y });
};
$("resetStyleBtn").onclick = () => {
  const p = S.presets[S.work.preset];
  setStyle(S.work.preset, { font_size: p.font_size, y: p.y });
};
for (const [id, key] of [["sizeInput", "font_size"], ["yInput", "y"]]) {
  $(id).addEventListener("input", () => {
    const n = Number($(id).value);
    if ($(id).value === "" || !isFinite(n) || (key === "font_size" && n <= 0)) return;
    S.work.style[key] = n; draw();
  });
  $(id).addEventListener("focus", () => { S.styleSnap = JSON.stringify(state()); });
  $(id).addEventListener("change", () => {
    if (S.styleSnap && S.styleSnap !== JSON.stringify(state())) { pushUndo(S.styleSnap); changed(); }
    S.styleSnap = null; syncStyleInputs();
  });
}

// ───────── 字幕預覽（§4.3.1） ─────────
// FCP 的字級、位置以「畫面高 1080」為單位（§9），所以 1 單位 = 顯示高度 / 1080 個像素。
// 位置 Y 是第一行文字的基線相對畫面中心的距離（往上為正），多行往下排。

const STYLE = { stroke: 4, shadowDist: 10, shadowAngle: 315, kerning: 1.24 }; // 對應 §5 樣式範本
let rect = { x: 0, y: 0, w: 0, h: 0 };

function layoutOverlay() {
  if (!S.work) return;
  const vw = S.work.video.width, vh = S.work.video.height;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const k = Math.min(sw / vw, sh / vh);
  rect = { w: vw * k, h: vh * k, x: (sw - vw * k) / 2, y: (sh - vh * k) / 2 };
  const dpr = window.devicePixelRatio || 1;
  Object.assign(overlay.style, { left: rect.x + "px", top: rect.y + "px", width: rect.w + "px", height: rect.h + "px" });
  overlay.width = Math.round(rect.w * dpr); overlay.height = Math.round(rect.h * dpr);
  drawnKey = null; // 設定畫布尺寸會清空內容，即使數字一樣，所以一定要重畫
  draw();
}
new ResizeObserver(layoutOverlay).observe(stage);

const scratch = document.createElement("canvas");
let drawnKey = null; // 上次畫的內容；沒變就不重畫

function draw(frame) {
  const f = S.work ? frame ?? curFrame() : 0;
  const i = S.work ? subs().findIndex((s) => s.start <= f && f < s.end) : -1;
  const text = i >= 0 ? subs()[i].text : "";
  // 同一條字幕在顯示期間內容不變。全螢幕下畫一次約 16ms，等於 59.94fps 一整格的時間，
  // 每格都重畫會讓播放嚴重卡頓，所以只在文字、樣式或畫面大小改變時才畫
  const key = S.work && rect.h && text
    ? [text, S.work.style.font_size, S.work.style.y, overlay.width, overlay.height].join("|") : "";
  if (key === drawnKey) return;
  drawnKey = key;

  const ctx = overlay.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!key) return;

  const dpr = overlay.width / rect.w;
  const u = (rect.h / 1080) * dpr; // 1 個 FCP 單位在畫布上的像素
  const { font_size, y } = S.work.style;
  const lines = subs()[i].text.split("\n");

  // 先在暫存畫布畫描邊＋文字，再整體加陰影貼上，陰影才不會疊兩層
  scratch.width = overlay.width; scratch.height = overlay.height;
  const c = scratch.getContext("2d");
  c.font = `700 ${font_size * u}px SubMakerPreview, "Source Han Sans TW", sans-serif`;
  if ("letterSpacing" in c) c.letterSpacing = `${STYLE.kerning * u}px`;
  c.textAlign = "center"; c.textBaseline = "alphabetic";
  c.lineJoin = "round"; c.strokeStyle = "#000"; c.lineWidth = STYLE.stroke * 2 * u;
  c.fillStyle = "rgb(253,252,255)";
  const m = c.measureText("字");
  const lineH = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) || font_size * u * 1.448;
  const cx = overlay.width / 2, base = overlay.height / 2 - y * u;
  lines.forEach((t, k) => c.strokeText(t, cx, base + k * lineH));
  lines.forEach((t, k) => c.fillText(t, cx, base + k * lineH));

  const a = (STYLE.shadowAngle * Math.PI) / 180;
  ctx.shadowColor = "#000";
  ctx.shadowOffsetX = Math.cos(a) * STYLE.shadowDist * u;
  ctx.shadowOffsetY = -Math.sin(a) * STYLE.shadowDist * u; // FCP 的角度往上為正，畫布往下為正
  ctx.shadowBlur = u;
  ctx.drawImage(scratch, 0, 0);
}

document.fonts.load("700 70px SubMakerPreview").then((fs) => {
  if (!fs.length) message("預覽用的思源黑體 TW 粗體沒有載入，字幕預覽的大小和換行可能和 FCP 不同。");
  drawnKey = null; // 字型換了要重畫
  draw();
});

// ───────── 聲音波形（§4.3.3） ─────────
// 以播放頭為中心顯示前後 WAVE.span 秒；字幕方塊疊在波形上，拖曳左右邊緣可改起訖時間

const wave = $("wave"), wc = $("waveCanvas");
const SPANS = [2, 5, 10, 20, 30, 60];
const WAVE = { peaks: null, max: 1, span: 10, status: "", drag: null };
const EDGE_PX = 6; // 游標離方塊邊緣幾個像素內算「抓到邊緣」

function layoutWave() {
  const dpr = window.devicePixelRatio || 1;
  wc.width = Math.round(wave.clientWidth * dpr); wc.height = Math.round(wave.clientHeight * dpr);
  drawWave();
}
new ResizeObserver(layoutWave).observe(wave);

const waveT0 = (f) => frameToSec(f) - WAVE.span / 2;             // 畫面左緣的秒數
const secAtX = (x, f) => waveT0(f) + (x / wave.clientWidth) * WAVE.span;  // x 是 CSS 像素
const xAtSec = (sec, f) => ((sec - waveT0(f)) / WAVE.span) * wave.clientWidth;
const frameAtX = (x, f) => Math.round(secAtX(x, f) * fps());

function drawWave(frame) {
  const ctx = wc.getContext("2d"), W = wc.width, H = wc.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!S.work || !W) return;
  const f = frame ?? curFrame(), dpr = W / wave.clientWidth;
  const t0 = waveT0(f), t1 = t0 + WAVE.span;

  // 字幕方塊
  ctx.font = `${12 * dpr}px -apple-system, "PingFang TC", sans-serif`;
  ctx.textBaseline = "top";
  subs().forEach((s, i) => {
    const a = frameToSec(s.start), b = frameToSec(s.end);
    if (b < t0 || a > t1) return;
    const x1 = xAtSec(a, f) * dpr, x2 = xAtSec(b, f) * dpr;
    const bad = S.problems.includes(i), sel = i === S.sel;
    ctx.fillStyle = bad ? "rgba(255,107,107,.28)" : sel ? "rgba(91,108,255,.38)" : "rgba(120,140,170,.22)";
    ctx.fillRect(x1, 0, x2 - x1, H);
    ctx.fillStyle = bad ? "#ff6b6b" : sel ? "#8f9bff" : "#7d8aa3";
    ctx.fillRect(x1, 0, 2 * dpr, H); ctx.fillRect(x2 - 2 * dpr, 0, 2 * dpr, H); // 可拖曳的邊緣
    ctx.save();
    ctx.beginPath(); ctx.rect(x1 + 4 * dpr, 0, Math.max(0, x2 - x1 - 8 * dpr), H); ctx.clip();
    ctx.fillStyle = "#e8e8ea";
    ctx.fillText(s.text.split("\n")[0], x1 + 5 * dpr, 4 * dpr);
    ctx.restore();
  });

  // 波形：每個 CSS 像素取該範圍內的最大峰值，畫成上下對稱的長條。
  // 用 fillRect 而不是一條多段路徑再 stroke：全螢幕下 stroke 每格約 100ms，fillRect 不到 1ms
  if (WAVE.peaks) {
    const p = WAVE.peaks, mid = H / 2 + 8 * dpr, scale = (H / 2 - 18 * dpr) / WAVE.max;
    const cw = wave.clientWidth, perPx = WAVE.span * 100 / cw, base = t0 * 100, bw = Math.max(1, Math.floor(dpr));
    ctx.fillStyle = "#4fc3a1";
    for (let x = 0; x < cw; x++) {
      const i0 = Math.floor(base + x * perPx), i1 = Math.max(i0 + 1, Math.floor(base + (x + 1) * perPx));
      let m = 0;
      for (let k = Math.max(0, i0); k < Math.min(p.length, i1); k++) if (p[k] > m) m = p[k];
      if (!m) continue;
      const h = Math.max(1, Math.round(m * scale));
      ctx.fillRect(Math.round(x * dpr), mid - h, bw, h * 2);
    }
  } else if (WAVE.status) {
    ctx.fillStyle = "#9a9aa2"; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.fillText(WAVE.status, W / 2, H / 2 + 8 * dpr); ctx.textAlign = "start";
  }

  // 播放頭固定在正中央
  ctx.fillStyle = "#ffcc33"; ctx.fillRect(W / 2 - dpr / 2, 0, dpr, H);
}

async function loadPeaks() {
  const wid = S.wid;
  WAVE.peaks = null; WAVE.status = "讀取聲音波形…"; drawWave();
  try {
    let res = await fetch(`/api/peaks/${wid}`);
    if (res.status === 404) {
      const job = await api("POST", `/api/peaks/${wid}`);
      const last = await readStream(job, (x) => {
        if (x.progress !== undefined && S.wid === wid) { WAVE.status = `計算聲音波形中 ${Math.round(x.progress * 100)}%`; drawWave(); }
      });
      if (last?.error) throw new Error(last.error);
      res = await fetch(`/api/peaks/${wid}`);
    }
    if (!res.ok) throw new Error((await res.json()).detail || res.status);
    if (S.wid !== wid) return; // 計算中換了影片
    WAVE.peaks = new Uint8Array(await res.arrayBuffer());
    WAVE.max = WAVE.peaks.reduce((m, v) => (v > m ? v : m), 1); // 以整支影片最大聲為滿格
    WAVE.status = "";
    // 波形和聲音資料一起產生，有波形就代表可以用 Web Audio 播放了（§4.3.0）
    // 正在用影片本身的聲音播放時不打斷，下次按播放才改走 Web Audio
    AUD.ready = true; prefetchAudio(video.currentTime);
    if (!isPlaying()) video.muted = true;
  } catch (e) {
    if (S.wid === wid) WAVE.status = String(e.message || e);
  }
  drawWave();
}

// 找游標下的字幕方塊與邊緣；相鄰兩條共用邊界時，取離游標較近的那一邊
function hitWave(x) {
  const f = curFrame();
  let best = null;
  subs().forEach((s, i) => {
    const x1 = xAtSec(frameToSec(s.start), f), x2 = xAtSec(frameToSec(s.end), f);
    for (const [key, ex] of [["start", x1], ["end", x2]]) {
      const d = Math.abs(x - ex);
      if (d <= EDGE_PX && (!best || !best.key || d < best.d || (d === best.d && (key === "start") === (x > ex))))
        best = { i, key, d };
    }
    if (!best && x > x1 && x < x2) best = { i, key: null, d: Infinity };
  });
  return best;
}

// 三種拖曳：邊緣＝改起點或終點；方塊中間＝整條移動；其他地方＝拖動時間（播放頭跟著走）。
// 按下後移動不到 CLICK_PX 算點擊：跳到點擊的位置
const CLICK_PX = 3;

wc.addEventListener("pointerdown", (e) => {
  if (!S.work) return;
  e.preventDefault();
  document.activeElement?.blur?.(); // 讓快捷鍵（空白鍵、Cmd+Z）在拖完後立刻可用
  wc.setPointerCapture(e.pointerId);
  const h = hitWave(e.offsetX), f0 = curFrame();
  const mode = h?.key ? "edge" : h ? "block" : "pan";
  const s = h ? subs()[h.i] : null;
  WAVE.drag = { mode, i: h?.i, key: h?.key, x0: e.offsetX, f0, moved: false,
    snap: JSON.stringify(state()), from: s && { start: s.start, end: s.end } };
  if (mode === "edge") { playerPause(); select(h.i, false); }
});

wc.addEventListener("pointermove", (e) => {
  if (!S.work) return;
  const d = WAVE.drag;
  if (!d) {
    const h = hitWave(e.offsetX);
    wc.style.cursor = h?.key ? "ew-resize" : h ? "move" : "grab";
    return;
  }
  const dx = e.offsetX - d.x0;
  if (!d.moved) {
    if (Math.abs(dx) < CLICK_PX) return;
    d.moved = true;
    playerPause();
    if (d.mode === "block") select(d.i, false);
    if (d.mode === "pan") wc.style.cursor = "grabbing";
  }
  const all = subs(), total = S.work.video.duration_frames;
  const dFrames = Math.round((dx / wave.clientWidth) * WAVE.span * fps());
  if (d.mode === "pan") {
    seekFrame(d.f0 - dFrames); // 往左拖＝往後面的時間走
    return;
  }
  const s = all[d.i];
  if (d.mode === "edge") {
    // 不能拖過相鄰字幕、不能超出影片，起點至少比終點早 1 格（已經重疊的維持原狀，不會跳動）
    const fr = frameAtX(e.offsetX, d.f0);
    if (d.key === "start") {
      const lo = Math.min(d.i > 0 ? all[d.i - 1].end : 0, d.from.start);
      s.start = Math.max(lo, Math.min(fr, s.end - 1));
    } else {
      const hi = Math.max(d.i < all.length - 1 ? all[d.i + 1].start : total, d.from.end);
      s.end = Math.min(hi, Math.max(fr, s.start + 1));
    }
  } else {
    // 整條移動、長度不變；同樣不能越過相鄰字幕或超出影片
    const lo = Math.min(0, (d.i > 0 ? all[d.i - 1].end : 0) - d.from.start);
    const hi = Math.max(0, (d.i < all.length - 1 ? all[d.i + 1].start : total) - d.from.end);
    const k = Math.max(lo, Math.min(hi, dFrames));
    s.start = d.from.start + k; s.end = d.from.end + k;
  }
  fillTimes(rowEl(d.i), s);
  drawnKey = null; draw(); drawWave();
});

function endDrag(e, cancelled) {
  const d = WAVE.drag;
  if (!d) return;
  WAVE.drag = null;
  wc.style.cursor = "";
  if (!d.moved) {
    // 點擊：點方塊選取該條，然後跳到點擊的位置（點在邊緣只選取）
    if (!cancelled && d.mode !== "edge") {
      if (d.mode === "block") select(d.i, false);
      seekFrame(frameAtX(e.offsetX, d.f0));
    }
    return;
  }
  if (d.mode !== "pan") {
    const s = subs()[d.i];
    if (s.start !== d.from.start || s.end !== d.from.end) { pushUndo(d.snap); changed(); validate(); } // 放開後算一步復原
  }
  drawWave();
}
wc.addEventListener("pointerup", (e) => endDrag(e, false));
wc.addEventListener("pointercancel", (e) => endDrag(e, true));

function setSpan(dir) {
  const k = Math.max(0, Math.min(SPANS.length - 1, SPANS.indexOf(WAVE.span) + dir));
  WAVE.span = SPANS[k];
  $("zoomTxt").textContent = `${WAVE.span} 秒`;
  $("zoomIn").disabled = k === 0; $("zoomOut").disabled = k === SPANS.length - 1;
  drawWave();
}
$("zoomIn").onclick = () => setSpan(-1);
$("zoomOut").onclick = () => setSpan(1);

// ───────── 播放 ─────────

function togglePlay() { if (!S.work) return; isPlaying() ? playerPause() : playerPlay(); }
$("playBtn").onclick = togglePlay;
video.addEventListener("play", () => ($("playBtn").textContent = "❚❚"));
video.addEventListener("pause", () => ($("playBtn").textContent = "▶"));
video.addEventListener("seeked", () => draw());
$("seek").addEventListener("input", () => seekFrame(Number($("seek").value)));

let lastFrame = -1;
function tick() {
  requestAnimationFrame(tick);
  if (!S.work) return;
  audioTick();
  const f = curFrame();
  if (f === lastFrame) return;
  lastFrame = f;
  $("tc").textContent = framesToTC(f);
  if (document.activeElement !== $("seek")) $("seek").value = f;
  draw(f); drawWave(f);
  // 播放頭所在的字幕反白；沒在編輯字幕時，選取也跟著走並捲到可見位置（§4.3）。
  // 只看游標是否在字幕清單裡：停在字級、路徑等欄位時也要照常跟著走
  const i = subs().findIndex((s) => s.start <= f && f < s.end);
  if (i !== S.playing) {
    rowEl(S.playing)?.classList.remove("playing");
    S.playing = i;
    rowEl(i)?.classList.add("playing");
    if (i >= 0 && isPlaying() && !list.contains(document.activeElement)) select(i, false);
  }
}
requestAnimationFrame(tick);

// ───────── 字幕清單（§4.3、§4.4） ─────────

const rowEl = (i) => {
  const el = i >= 0 ? list.children[i] : null;
  return el && el.classList.contains("row") ? el : null;
};

function renderList() {
  list.innerHTML = "";
  if (!S.work) return;
  if (!subs().length) {
    list.innerHTML = '<div class="empty">還沒有字幕。按上方「載入 .srt」。</div>';
  }
  const frag = document.createDocumentFragment();
  subs().forEach((s, i) => frag.appendChild(buildRow(s, i)));
  list.appendChild(frag);
  $("listTitle").textContent = `字幕 ${subs().length} 條` + (S.work.srt_name ? `（${S.work.srt_name}）` : "");
  validate();
  if (S.sel >= subs().length) S.sel = subs().length - 1;
  rowEl(S.sel)?.classList.add("sel");
  S.playing = -1; lastFrame = -1; // 讓 tick 重新標出播放中的那條
  fitAll();
}

function fit(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }

// 打字時只在需要變高時調整；把高度先設成 auto 會讓整份清單重新排版（900 條約 40ms）。
// 變矮的情況等離開文字框時再用 fit() 處理
function grow(ta) { if (ta.scrollHeight > ta.clientHeight) ta.style.height = ta.scrollHeight + 2 + "px"; }

// 先全部重設、再一次讀完高度、最後全部寫回，整個清單只排版一次。
// 逐個 fit() 會讓瀏覽器每條都重新排版，900 條要 20 秒
function fitAll() {
  const tas = [...list.querySelectorAll("textarea")];
  for (const ta of tas) ta.style.height = "auto";
  const hs = tas.map((ta) => ta.scrollHeight);
  tas.forEach((ta, i) => (ta.style.height = hs[i] + 2 + "px"));
}

function buildRow(s, i) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <div class="idx"></div>
    <div class="times">
      <input class="mono start" spellcheck="false"><button class="now" data-k="start" title="設為目前播放位置（I）">用目前位置</button>
      →
      <input class="mono end" spellcheck="false"><button class="now" data-k="end" title="設為目前播放位置（O）">用目前位置</button>
      <span class="durTxt"></span>
    </div>
    <textarea rows="1" spellcheck="false"></textarea>
    <div class="acts">
      <button class="split" title="在文字游標的位置拆成兩條">拆句</button>
      <button class="merge" title="和下一條合併成一條">與下一條合併</button>
    </div>
    <div class="errTxt"></div>`;
  row.querySelector(".idx").textContent = i + 1;
  const ta = row.querySelector("textarea");
  ta.value = s.text;
  fillTimes(row, s);

  // 選到不同的一條就跳到它的起點，預覽才看得到正在改的字幕
  row.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    const i = idxOf(row);
    select(i, i !== S.sel || !e.target.closest("input, textarea"));
  });
  ta.addEventListener("focus", () => { S.editSnap = JSON.stringify(state()); select(idxOf(row), false); });
  ta.addEventListener("input", () => {
    if (S.editSnap) { pushUndo(S.editSnap); S.editSnap = null; } // 一次編輯算一步復原
    subs()[idxOf(row)].text = ta.value;
    grow(ta); changed(); draw(); validate();
  });
  ta.addEventListener("blur", () => { S.editSnap = null; fit(ta); });

  for (const k of ["start", "end"]) {
    const inp = row.querySelector("." + k);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
      if (e.key === "Escape") { e.preventDefault(); fillTimes(row, subs()[idxOf(row)]); inp.blur(); }
    });
    inp.addEventListener("change", () => {
      const i2 = idxOf(row), f = tcToFrames(inp.value);
      if (f === null) { message(`時間格式不正確：${inp.value}\n格式是 時:分:秒${isDF() ? ";" : ":"}格`); fillTimes(row, subs()[i2]); return; }
      setTime(i2, k, f);
    });
  }
  row.querySelectorAll(".now").forEach((b) => (b.onclick = () => setTime(idxOf(row), b.dataset.k, curFrame())));
  // 文字框失去焦點後仍保留游標位置，按下拆句時直接讀
  row.querySelector(".split").onclick = () => splitAt(idxOf(row), ta.selectionStart);
  row.querySelector(".merge").onclick = () => mergeNext(idxOf(row));
  return row;
}

const idxOf = (row) => Array.prototype.indexOf.call(list.children, row);

function fillTimes(row, s) {
  row.querySelector(".start").value = framesToTC(s.start);
  row.querySelector(".end").value = framesToTC(s.end);
  row.querySelector(".durTxt").textContent = `${(frameToSec(s.end - s.start)).toFixed(2)} 秒`;
}

function select(i, seek) {
  if (i < 0 || i >= subs().length) return;
  if (S.sel !== i) {
    rowEl(S.sel)?.classList.remove("sel");
    S.sel = i;
    rowEl(i).classList.add("sel");
  }
  rowEl(i).scrollIntoView({ block: "nearest" });
  if (seek) seekFrame(subs()[i].start);
  else drawWave();
}

function setTime(i, key, f) {
  if (i < 0) return;
  snapshot();
  subs()[i][key] = f;
  fillTimes(rowEl(i), subs()[i]);
  changed(); validate(); draw();
}

// 拆句：在游標位置拆成兩條，時間依字數比例分配（§4.4）
function splitAt(i, caret) {
  const s = subs()[i];
  if (!(caret > 0 && caret < s.text.length)) {
    message("請先在文字裡點一下要拆開的位置，再按「拆句」。");
    return;
  }
  const left = s.text.slice(0, caret).replace(/\s+$/, ""), right = s.text.slice(caret).replace(/^\s+/, "");
  if (!left || !right) { message("拆開後有一邊沒有文字，請換個位置。"); return; }
  if (s.end - s.start < 2) { message("這條只有 1 格長，沒辦法再拆。"); return; }
  const mid = Math.min(s.end - 1, Math.max(s.start + 1,
    s.start + Math.round(((s.end - s.start) * left.length) / (left.length + right.length))));
  snapshot();
  subs().splice(i, 1,
    { ...s, end: mid, text: left },
    { ...s, id: S.work.next_id++, start: mid, text: right });
  changed(); renderList(); select(i + 1, true);
}

// 合併：和下一條合併，時間取前一條起點到後一條終點（§4.4）
function mergeNext(i) {
  if (i >= subs().length - 1) { message("這是最後一條，後面沒有可以合併的。"); return; }
  const a = subs()[i], b = subs()[i + 1];
  snapshot();
  subs().splice(i, 2, { ...a, end: b.end, text: a.text + b.text, orig: (a.orig || "") + (b.orig || "") });
  changed(); renderList(); select(i, true);
}

// 檢查（§4.4）：起點早於終點、不重疊、不超出影片長度。和後端 fcpxml.check_subtitles 同一套規則
function validate() {
  const total = S.work.video.duration_frames, all = subs();
  S.problems = [];
  all.forEach((s, i) => {
    const errs = [];
    if (!s.text.trim()) errs.push("沒有文字");
    if (s.start < 0) errs.push("起點小於 0");
    if (s.end <= s.start) errs.push("起點沒有早於終點");
    if (s.end > total) errs.push("超出影片長度");
    if (i + 1 < all.length && all[i + 1].start < s.end) errs.push("和下一條時間重疊");
    // 只改有變化的，避免每次打字都讓整份清單重新排版
    const row = rowEl(i), msg = errs.join("、");
    if (row && row._err !== msg) {
      row._err = msg;
      row.classList.toggle("bad", errs.length > 0);
      row.querySelector(".errTxt").textContent = msg;
    }
    if (errs.length) S.problems.push(i);
  });
  const btn = $("problemBtn");
  btn.hidden = !S.problems.length;
  btn.textContent = `${S.problems.length} 條有問題，跳到下一條`;
  drawWave();
}

$("problemBtn").onclick = () => {
  const next = S.problems.find((i) => i > S.sel) ?? S.problems[0];
  if (next !== undefined) select(next, true);
};

// ───────── 復原、重做（§4.3） ─────────

const state = () => ({ subtitles: subs(), style: S.work.style, preset: S.work.preset, next_id: S.work.next_id });
function pushUndo(snap) { S.undo.push(snap); if (S.undo.length > 300) S.undo.shift(); S.redo = []; }
function snapshot() { pushUndo(JSON.stringify(state())); }
function restore(snap) {
  Object.assign(S.work, JSON.parse(snap));
  syncStyleInputs(); changed(); renderList(); draw();
}
function undo() { if (S.undo.length) { S.redo.push(JSON.stringify(state())); restore(S.undo.pop()); } }
function redo() { if (S.redo.length) { S.undo.push(JSON.stringify(state())); restore(S.redo.pop()); } }

// ───────── 自動存檔（§4.3） ─────────

let saveTimer = null, saving = Promise.resolve();
function changed() {
  drawWave();
  setSaveStatus("尚未儲存");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}
function save() {
  clearTimeout(saveTimer); saveTimer = null;
  const body = state();
  saving = saving.then(async () => {
    setSaveStatus("儲存中…");
    try { await api("PUT", `/api/work/${S.wid}`, body); setSaveStatus(saveTimer ? "尚未儲存" : "已自動儲存"); }
    catch (e) { setSaveStatus("儲存失敗：" + e.message, true); }
  });
  return saving;
}
function setSaveStatus(t, err) { $("saveStatus").textContent = t; $("saveStatus").classList.toggle("err", !!err); }
window.addEventListener("beforeunload", () => {
  if (saveTimer && S.wid) {
    fetch(`/api/work/${S.wid}`, { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(state()) });
  }
});

// ───────── 快捷鍵（§4.3.2） ─────────
// 游標不在輸入框時才作用；正在輸入時按鍵就是打字，按 Esc 結束編輯

document.addEventListener("keydown", (e) => {
  if (!S.work) return;
  if (document.querySelector("dialog[open]")) return;
  if (isTyping()) {
    if (e.key === "Escape") { e.preventDefault(); document.activeElement.blur(); }
    return;
  }
  // 剛按過的按鈕還留著焦點時，空白鍵會同時觸發按鈕，先把焦點拿掉
  if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur();
  const cmd = e.metaKey || e.ctrlKey;
  const step = e.shiftKey ? nominal() : 1;
  let done = true;
  if (e.key === " ") togglePlay();
  else if (e.key === "ArrowLeft" && !cmd) { playerPause(); seekFrame(curFrame() - step); }
  else if (e.key === "ArrowRight" && !cmd) { playerPause(); seekFrame(curFrame() + step); }
  else if (e.key === "ArrowUp" && !cmd) jumpSub(-1);
  else if (e.key === "ArrowDown" && !cmd) jumpSub(1);
  else if (e.key === "Enter" && S.sel >= 0) {
    const ta = rowEl(S.sel).querySelector("textarea");
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  else if (!cmd && (e.key === "i" || e.key === "I")) setTime(S.sel, "start", curFrame());
  else if (!cmd && (e.key === "o" || e.key === "O")) setTime(S.sel, "end", curFrame());
  else if (cmd && e.key.toLowerCase() === "z") e.shiftKey ? redo() : undo();
  else if (cmd && e.key.toLowerCase() === "f") openFind();
  else done = false;
  if (done) e.preventDefault();
});

// ↑／↓：跳到上一條／下一條字幕的起點
function jumpSub(dir) {
  const f = curFrame(), all = subs();
  let i;
  if (dir > 0) i = all.findIndex((s) => s.start > f);
  else { i = -1; all.forEach((s, k) => { if (s.start < f) i = k; }); }
  if (i >= 0) { playerPause(); select(i, true); }
}

// ───────── 尋找與取代（§4.5）、取代規則（§4.6） ─────────
// hits: [{i, pos, len, repl, label, on}]，套用時同一條字幕從後往前改，位置才不會跑掉

let hits = [], hitMode = "find";

function findHits(needle, repl, label, on) {
  const out = [];
  if (!needle) return out;
  subs().forEach((s, i) => {
    let p = s.text.indexOf(needle);
    while (p >= 0) { out.push({ i, pos: p, len: needle.length, repl, label, on }); p = s.text.indexOf(needle, p + needle.length); }
  });
  return out;
}

function applyHits(selected) {
  if (!selected.length) return 0;
  snapshot();
  const byRow = new Map();
  for (const h of selected) (byRow.get(h.i) || byRow.set(h.i, []).get(h.i)).push(h);
  let n = 0;
  for (const [i, hs] of byRow) {
    let t = subs()[i].text, limit = Infinity;
    for (const h of hs.sort((a, b) => b.pos - a.pos)) {
      if (h.pos + h.len > limit) continue; // 和已套用的重疊，略過
      t = t.slice(0, h.pos) + h.repl + t.slice(h.pos + h.len);
      limit = h.pos; n++;
    }
    subs()[i].text = t;
  }
  changed(); renderList(); draw();
  return n;
}

function openFind() {
  hitMode = "find";
  $("findTitle").textContent = "尋找與取代";
  $("findInputs").hidden = false;
  $("findDlg").showModal();
  if (S.sel >= 0) {
    const ta = rowEl(S.sel)?.querySelector("textarea");
    const picked = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : "";
    if (picked && !picked.includes("\n")) $("findText").value = picked;
  }
  $("findText").focus(); $("findText").select();
  refreshFind();
}
$("findBtn").onclick = openFind;

function refreshFind() {
  if (hitMode === "find") hits = findHits($("findText").value, $("replText").value, "", true);
  renderHits();
}
$("findText").addEventListener("input", refreshFind);
$("replText").addEventListener("input", refreshFind);

function renderHits() {
  const box = $("findList");
  box.innerHTML = "";
  for (const h of hits) {
    const t = subs()[h.i].text;
    const el = document.createElement("label");
    el.className = "hit";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = h.on; cb.onchange = () => { h.on = cb.checked; countHits(); };
    const where = document.createElement("span");
    where.className = "where mono"; where.textContent = `#${h.i + 1} ${framesToTC(subs()[h.i].start)}`;
    where.onclick = (e) => { e.preventDefault(); select(h.i, true); };
    const ctx = document.createElement("span");
    ctx.className = "ctx";
    const mk = (tag, s) => { const n = document.createElement(tag); n.textContent = s; return n; };
    ctx.append(t.slice(Math.max(0, h.pos - 15), h.pos), mk("mark", t.substr(h.pos, h.len)), mk("ins", h.repl),
      t.slice(h.pos + h.len, h.pos + h.len + 15));
    el.append(cb, where);
    if (h.label) { const r = mk("span", h.label); r.className = "rule"; el.append(r); }
    el.append(ctx);
    box.appendChild(el);
  }
  if (!hits.length) box.innerHTML = `<div class="empty">${hitMode === "find" && !$("findText").value ? "輸入要找的字" : "沒有符合的地方"}</div>`;
  countHits();
}

function countHits() {
  const on = hits.filter((h) => h.on).length;
  $("findCount").textContent = `找到 ${hits.length} 處，勾選 ${on} 處`;
  $("applyCheckedBtn").textContent = `套用勾選的（${on}）`;
  $("applyCheckedBtn").disabled = !on;
  $("applyAllBtn").disabled = !hits.length;
}

$("checkAllBtn").onclick = () => { hits.forEach((h) => (h.on = true)); renderHits(); };
$("uncheckAllBtn").onclick = () => { hits.forEach((h) => (h.on = false)); renderHits(); };
$("applyCheckedBtn").onclick = () => afterApply(applyHits(hits.filter((h) => h.on)));
$("applyAllBtn").onclick = () => afterApply(applyHits(hits));

function afterApply(n) {
  if (hitMode === "find") refreshFind();
  else { hits = []; renderHits(); }
  $("findCount").textContent = `已取代 ${n} 處（可以用 Cmd+Z 復原）`;
}

// 取代規則
let rules = [];
const MODES = { all: "直接全換", confirm: "逐條確認" };

async function openRules() {
  rules = await (await api("GET", "/api/rules")).json();
  renderRules();
  $("rulesStatus").textContent = "";
  $("rulesDlg").showModal();
}
$("rulesBtn").onclick = openRules;

function renderRules() {
  const tb = $("rulesTable").tBodies[0];
  tb.innerHTML = "";
  rules.forEach((r, i) => {
    const tr = tb.insertRow();
    const inp = (key) => {
      const x = document.createElement("input");
      x.value = r[key]; x.oninput = () => (r[key] = x.value);
      tr.insertCell().appendChild(x);
    };
    inp("find"); inp("replace");
    const sel = document.createElement("select");
    for (const [k, v] of Object.entries(MODES)) sel.add(new Option(v, k));
    sel.value = r.mode; sel.onchange = () => (r.mode = sel.value);
    tr.insertCell().appendChild(sel);
    inp("note");
    const del = document.createElement("button");
    del.textContent = "刪除"; del.onclick = () => { rules.splice(i, 1); renderRules(); };
    tr.insertCell().appendChild(del);
  });
}

$("addRuleBtn").onclick = () => { rules.push({ find: "", replace: "", mode: "all", note: "" }); renderRules(); };

async function saveRules() {
  rules = await (await api("PUT", "/api/rules", rules)).json();
  renderRules();
  $("rulesStatus").textContent = "已儲存";
}
$("saveRulesBtn").onclick = () => saveRules().catch((e) => message("儲存規則失敗：\n" + e.message));

// 一鍵套用：「直接全換」的規則立刻套用；「逐條確認」的列出來，預設不勾，由使用者逐條勾選
$("applyRulesBtn").onclick = async () => {
  try { await saveRules(); } catch (e) { message("儲存規則失敗：\n" + e.message); return; }
  const direct = rules.filter((r) => r.mode === "all");
  let n = 0;
  if (direct.length) {
    snapshot();
    for (const r of direct) {
      for (const s of subs()) {
        const parts = s.text.split(r.find);
        n += parts.length - 1;
        s.text = parts.join(r.replace);
      }
    }
    if (n) { changed(); renderList(); draw(); } else S.undo.pop();
  }
  const confirmHits = rules.filter((r) => r.mode === "confirm")
    .flatMap((r) => findHits(r.find, r.replace, `${r.find}→${r.replace}`, false));
  $("rulesDlg").close();
  if (!confirmHits.length) { message(`規則套用完成：直接取代 ${n} 處，沒有需要逐條確認的地方。`); return; }
  hitMode = "rules"; hits = confirmHits;
  $("findTitle").textContent = `逐條確認（已直接取代 ${n} 處，下面請勾選要取代的）`;
  $("findInputs").hidden = true;
  $("findDlg").showModal();
  renderHits();
};

// ───────── 匯出（§4.8、§5） ─────────

$("exportBtn").onclick = async () => {
  if (S.problems.length) {
    message(`還有 ${S.problems.length} 條字幕有問題（清單上紅色標示），修正後才能匯出。`);
    return;
  }
  try {
    await save();
    const res = await api("POST", `/api/export/${S.wid}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${S.work.name}.fcpxml`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    message(`已匯出 ${subs().length} 條字幕：${S.work.name}.fcpxml\n\n匯入 FCP 後，全選字幕複製，從正式專案時間軸的最開頭貼上。`);
  } catch (e) {
    message("匯出失敗：\n" + e.message);
  }
};

// ───────── 啟動 ─────────

$("openForm").onsubmit = (e) => { e.preventDefault(); if ($("pathInput").value.trim()) openVideo($("pathInput").value.trim()); };

// 把檔案拖到路徑欄：Safari 拿不到完整路徑，只能提示
$("pathInput").addEventListener("drop", (e) => {
  const t = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list");
  if (t) {
    e.preventDefault();
    $("pathInput").value = decodeURIComponent(t.replace(/^file:\/\//, "").trim());
  }
});

(async () => {
  S.presets = await (await api("GET", "/api/presets")).json();
  let last = null;
  try { last = localStorage.getItem("submaker.lastPath"); } catch {}
  if (last) { $("pathInput").value = last; openVideo(last); } // 重開瀏覽器接著做（§4.3）
})();

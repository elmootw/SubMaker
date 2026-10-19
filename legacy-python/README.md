# legacy-python：v1 Python 版（保留作為標準答案與退路）

SubMaker v1.x 的本機網頁版，2026-10-19 起由 Swift 原生 App（v2）取代。
保留下來有兩個用途：

1. **標準答案**：Swift 版的 fcpxml 產生、自動整理等規則，用同樣的輸入和這份 Python 版比對結果
2. **退路**：如果 Swift 版做不下去，改回 SPEC v2.0 §8 原本建議的 Python 方案時直接沿用

## 已驗證過的部分

| 檔案 | 內容 | 驗證 |
|---|---|---|
| `submaker/fcpxml.py` | 產生 fcpxml 1.8、匯出前自我檢查 | 使用者影片 2305 條通過 FCP 內建 `FCPXMLv1_8.dtd`；匯入 FCP 位置、時間正確（2026-10-19） |
| `submaker/cleanup.py` | 自動整理 6 條規則 | 35 個例子（含不該改的反例）＋使用者字幕 2305 條試跑 |
| `submaker/srt.py` | 讀 srt、判斷編碼 | UTF-8、UTF-8 BOM、GBK |
| `submaker/media.py` | ffprobe 讀影片資訊（影格率保留分數）、聲音與波形 | 4K ProRes 29.97、HEVC 59.94、H.264 30 |
| `static/app.js` 的 `draw()` | 字幕預覽繪製（以畫面高 1080 為基準） | 與 FCP 截圖比對，差距在量測誤差內 |

## 執行

在 SubMaker 根目錄已有 `.venv`（套件見 `requirements.txt`）：

```bash
cd legacy-python && ../.venv/bin/python app.py
```

再用 Safari 打開 http://127.0.0.1:8765 。工作資料在 `legacy-python/work/`（不進 git）。

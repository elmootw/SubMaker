# SubMaker

本機用的影片字幕校正工具。

## 目的

把影片的字幕校正好，匯出 `.fcpxml`，**直接匯入 Final Cut Pro 使用，不需要再手動修**。
匯入後，使用者會全選字幕、複製，貼到正式的剪輯時間軸上做後製。

SubMaker 只處理字幕，不剪影片，也不改影片長度。

## 使用流程

1. 指定影片檔路徑，載入簡體中文 `.srt` 字幕檔
2. 自動轉成繁體中文（台灣用字），畫面上顯示轉換進度
3. 一邊看影片一邊校正：改文字、調整起訖時間、拆句、合併、全部取代
4. 匯出 `.fcpxml`，匯入 FCP

第二階段：只提供影片，由 SubMaker 自動聽寫出字幕，之後的流程相同。

## 啟動

第一次使用先安裝：

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

之後每次：

```bash
.venv/bin/python app.py
```

再用 Safari 打開 http://127.0.0.1:8765 。只接受本機連線。

需要系統已安裝 `ffmpeg` 與思源黑體 TW 粗體（`SourceHanSansTW-Bold`）。

## 文件

- [SPEC.md](SPEC.md)：功能規格、驗收條件、匯出規則、待定事項（**以這份為準**）

## 狀態

第一階段完成，等待在 FCP 實測（見 SPEC §9「尚未在 FCP 實測的變數」）。

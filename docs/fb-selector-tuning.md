# Quy trình dò DOM & sửa selector Facebook

Khi Facebook đổi giao diện, việc đăng nhập / đăng bài có thể hỏng vì các **selector**
trong [`src/main/automation/fb-selectors.ts`](../src/main/automation/fb-selectors.ts)
không còn khớp DOM mới. File này là **runbook** để dò lại DOM thật và sửa nhanh.

> Nguyên tắc vàng: **đừng đoán selector** — mở đúng trang/dialog bằng chính profile
> đã đăng nhập của khách, **dump DOM thật ra**, rồi viết selector theo cái nhìn thấy.
> Toàn bộ FB-knowledge nằm gọn trong 1 file `fb-selectors.ts`.

---

## 0. Khi nào cần làm

- Đăng bài báo `COMPOSER_NOT_FOUND`, `POST_NOT_READY`, hoặc treo.
- Đăng nhập treo / sai trạng thái.
- Mở **thư mục log** (Cài đặt → Nhật ký) đọc file `app-YYYY-MM-DD.log` để biết bước nào hỏng:
  - `composer opened` không xuất hiện → hỏng ở **mở ô soạn** (`composerEntry`/`composerTextbox`).
  - có `composer opened` nhưng `POST_NOT_READY` → text/ảnh không vào được (gõ sai ô, hoặc input ảnh sai).
  - `submit clicked` rồi `failed` → nút Đăng sai, hoặc FB chặn (xem `reason`).

## 1. Chuẩn bị

```bash
# 1a. Dừng app dev để giải phóng profile (Chromium chỉ cho 1 tiến trình mở 1 profile).
pkill -9 -f electron-vite; pkill -9 -f "MacOS/Electron"; sleep 3

# 1b. Lấy URL nhóm + profile từ DB (đổi đường dẫn nếu khác máy).
DB=~/Library/Application\ Support/fb-auto-post/fb-auto-post.db
sqlite3 "$DB" "SELECT id, name, url FROM groups WHERE active=1;"
sqlite3 "$DB" "SELECT id, username, profile_dir FROM accounts WHERE active=1;"
```

> Profile của account `id=N` nằm ở `~/Library/Application Support/fb-auto-post/profiles/N`
> (Windows: `%AppData%\fb-auto-post\profiles\N`). Sửa đường dẫn trong 2 script dưới nếu cần.

## 2. Dump DOM thật

[`scripts/inspect-composer.mts`](../scripts/inspect-composer.mts) mở nhóm bằng profile
đã đăng nhập, click ô soạn bài, rồi in ra **chỉ các phần tử trong dialog** (textbox,
input file, các nút có aria-label).

```bash
npx tsx scripts/inspect-composer.mts "<group-url>" 2>&1 | grep -E "opened|DIALOG|tag" | head -60
```

Đọc kết quả, tìm các phần tử chủ chốt. **Ví dụ DOM tiếng Việt (06/2026):**

| Vai trò | Phần tử thật |
|---|---|
| Ô soạn (entry, ở feed) | `div[role="button"]` text **"Bạn viết gì đi..."** — KHÔNG có aria-label |
| Ô nhập nội dung (trong dialog) | `div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]`, `aria-placeholder="Bạn viết gì đi..."`, **không aria-label** |
| Input ảnh (trong dialog) | `input[type="file"][accept*="image"]` |
| Nút thêm ảnh | `[aria-label="Ảnh/video"]` |
| Nút Đăng | `div[role="button"][aria-label="Đăng"]` — `aria-disabled="true"` cho tới khi có nội dung |

## 3. Bẫy thường gặp (rút ra từ lần dò 06/2026)

1. **Ô "Viết bình luận" ≠ ô soạn bài.** Cả hai đều là `[role="textbox"][contenteditable]`.
   → Selector ô nhập **PHẢI giới hạn trong dialog**: `div[role="dialog"] div[role="textbox"][contenteditable="true"]`.
   Nếu không, `.first()` chọn nhầm ô comment ở feed → gõ vào nhầm chỗ → dialog trống → nút Đăng không bật.
2. **Entry composer khớp theo TEXT, không theo aria-label.** `aria-label*="viết"` khớp nhầm
   "Viết bình luận", "Lựa chọn khác cho bài viết"... → dùng `:has-text("Bạn viết gì")`.
3. **Phải GÕ PHÍM, không `.fill()`.** FB dùng Lexical editor, chỉ bật nút Đăng khi nhận
   sự kiện bàn phím thật → `textbox.click()` rồi `page.keyboard.type(text, {delay})`.
   `.fill()` / `pressSequentially` đôi khi không kích hoạt → nút Đăng kẹt `disabled`.
4. **Nút Đăng `aria-disabled="true"` cho tới khi sẵn sàng.** Đây chính là tín hiệu
   "bài sẵn sàng" (text đã nhận + ảnh upload xong) — **chờ nó hết disabled rồi mới bấm**,
   đừng bấm ngay (Playwright sẽ treo 20s vì element "not enabled").
5. **Song ngữ:** thêm cả biến thể tiếng Anh lẫn tiếng Việt cho mọi selector/text khớp
   theo chữ. Ưu tiên hook độc lập ngôn ngữ (`name`/`id`/`role`/`type=file`/URL).

## 4. Kiểm chứng TRƯỚC khi sửa app

[`scripts/test-composer.mts`](../scripts/test-composer.mts) chạy đúng chuỗi thao tác
(mở → gõ → đính ảnh → kiểm nút Đăng) nhưng **KHÔNG bấm Đăng** (tránh spam nhóm). Sửa
selector trong script nếu DOM đổi, rồi:

```bash
npx tsx scripts/test-composer.mts "<group-url>"
```

Mong đợi:
```
textbox text after typing: "Test nội dung..."   ← gõ được
setInputFiles ok                                 ← đính ảnh được
t+2s  Post aria-disabled=null  >>> POST BUTTON ENABLED
```
Khi thấy `POST BUTTON ENABLED` ⇒ selector + cách thao tác đã đúng.

## 5. Cập nhật app

1. Sửa các giá trị trong `src/main/automation/fb-selectors.ts` cho khớp DOM mới.
2. Nếu đổi cách thao tác (vd cách gõ, cách đính ảnh), sửa `src/main/automation/poster.ts`
   (hàm `postCell`) — đây là nơi duy nhất điều khiển composer.
3. `npm run typecheck && npm run build` → xanh.
4. Khởi động lại app: `npm run dev`.
5. Thử đăng 1 bài vào 1 nhóm. Đọc log xác nhận: `composer opened → submit clicked → success`.

## 6. Tham chiếu nhanh các selector hiện tại

Xem trực tiếp [`fb-selectors.ts`](../src/main/automation/fb-selectors.ts). Các khoá quan trọng:
`composerEntry`, `composerTextbox`, `composerImageInput`, `composerSubmit`, `loggedInMarkers`,
`emailInput`/`passwordInput`/`loginButton`, và các mảng text `*Text` (banned/limited/rateLimit/duplicate…).

---

## 7. Quy trình dò DOM cho ĐĂNG NHẬP

Phần đăng nhập đa phần **độc lập ngôn ngữ** nên ít khi phải dò: "đã đăng nhập" được
suy luận bằng cách **không thấy form đăng nhập** (ô email+mật khẩu) và không phải
checkpoint/2FA ⇒ OK. Form login dùng `input[name="email"]` / `input[name="pass"]` rất
ổn định. Chỉ cần dò lại khi: login treo, nhận sai trạng thái, hoặc FB đổi trang
**OTP/2FA/checkpoint/xác minh ảnh**.

### 7.1 Dump DOM đăng nhập / challenge

[`scripts/inspect-login.mts`](../scripts/inspect-login.mts) mở `facebook.com` bằng
profile và in: **URL** (+ pattern nào khớp), **tất cả `input`** (name/type/autocomplete/
placeholder), **các nút auth** (login/continue/mã…), **text trong alert/dialog**, và
**kết quả `classify()` thật của app**.

```bash
# Dừng app trước. profileId mặc định = 1.
pkill -9 -f electron-vite; pkill -9 -f "MacOS/Electron"; sleep 3
npx tsx scripts/inspect-login.mts 1
```

- Nếu session còn sống → in `classify()` = `OK` (đã đăng nhập), không có form login.
- **Muốn xem form login:** dùng một profile chưa đăng nhập (vd account mới), hoặc đăng
  xuất thủ công trong cửa sổ trình duyệt mà script mở (nó để mở 40s), rồi chạy lại.
- **Muốn xem OTP/checkpoint:** chạy script **ngay lúc** màn hình challenge đang hiện
  (login thật rồi FB chặn) — script sẽ dump đúng DOM của trang đó.

### 7.2 Khớp với code

Đối chiếu dump với các khoá trong `fb-selectors.ts` và logic trong
[`challenge-detect.ts`](../src/main/automation/challenge-detect.ts):

| Trạng thái | Dò ở đâu |
|---|---|
| Form đăng nhập | `emailInput`, `passwordInput`, `loginButton` (theo `name`/`id` — ổn định) |
| OTP / 2FA | URL pattern `FB_URL_PATTERNS.twoFactor` + `otpInput` (`input[name="approvals_code"]` / `autocomplete="one-time-code"`) |
| Checkpoint | URL pattern `FB_URL_PATTERNS.checkpoint` (`/checkpoint/`) |
| Captcha / xác minh ảnh | `captcha`, `photoId` |
| "Continue as <Tên>" (đăng nhập lại) | `savedLoginChooser` |
| Sai mật khẩu / bị khóa / hạn chế | mảng text `badCredentialsText` / `bannedText` / `limitedText` (lấy từ phần "ALERT/DIALOG TEXT") |

### 7.3 Bẫy login cần nhớ

1. **Đừng dựa vào aria-label tiếng Anh để nhận "đã đăng nhập"** — FB tiếng Việt dùng
   nhãn khác. Logic hiện tại suy luận theo **vắng mặt form login** (độc lập ngôn ngữ),
   đừng phá nó.
2. **OTP/checkpoint nhận diện ưu tiên theo URL** (ổn định hơn DOM). Lấy mẫu URL thật từ
   dump rồi cập nhật `FB_URL_PATTERNS` nếu FB đổi.
3. **Không tự giải OTP/captcha.** Khi attended, app mở cửa sổ cho người giải tay rồi
   poll lại — chỉ cần `classify()` nhận ĐÚNG là OTP/checkpoint để kích hoạt luồng này.
4. Thêm text mới vào mảng `*Text` ở **cả EN + VI**; copy nguyên văn (đã lowercase) từ
   phần "ALERT/DIALOG TEXT" của dump cho khớp chính xác.

### 7.4 Kiểm chứng

Chạy lại `inspect-login.mts` và xem dòng **LIVE classify() RESULT** đã trả về đúng
trạng thái mong đợi chưa (vd đang ở trang OTP thì phải ra `OTP`, đã đăng nhập thì `OK`).
Đúng rồi mới sửa app → `typecheck && build` → `npm run dev` → thử login lại, đọc log:
`login: account N @ <url> → <kind>` và `result=OK`.

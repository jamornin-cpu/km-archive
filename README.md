# Archive — Document/Media Library on Google Drive

A static web app (no server, no build step) that lists, previews, and uploads
files to a Google Drive folder. Google Drive is the only database — this app
has no backend of its own.

Works for: documents (PDF/Word/Sheets), images, video, and any other file
type. Subfolders are supported for organizing categories.

---

## 1. Google Cloud setup (one-time, ~5 min)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create
   a new project (or use an existing one).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (or Internal if you use Google Workspace).
   - Fill in app name, support email.
   - Scopes: add `.../auth/drive`.
   - Test users: add every Google account that should be able to sign in
     (required while the app is "Testing" / unverified — fine for internal
     use with up to 100 users; no verification needed).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: add every URL you'll open this app
     from, e.g.:
     - `http://localhost:5500` (for local testing)
     - `https://your-project.vercel.app` (your real deployment URL)
   - No redirect URI needed (this app uses the token flow, not the code
     flow).
   - Copy the generated **Client ID**.

## 2. Configure the app

Open `config.js` and paste your Client ID:

```js
window.APP_CONFIG = {
  CLIENT_ID: "123456789-xxxxxxxx.apps.googleusercontent.com",
  SCOPE: "https://www.googleapis.com/auth/drive",
  ROOT_FOLDER_ID: "",   // optional, see below
};
```

**`ROOT_FOLDER_ID`** — recommended. Create a folder in Drive named e.g.
"Archive", open it, and copy the ID from the URL:
`https://drive.google.com/drive/folders/<THIS_PART>`. Paste it in. This locks
the app to that one folder tree instead of browsing all of My Drive.
Leave blank to browse the whole My Drive.

**`DEPARTMENTS`** — the home screen. On every sign-in, the app checks this
folder for a subfolder matching each name in the list; anything missing is
created automatically (existing folders are matched by name and reused —
safe to re-run, never duplicates). Edit the list to add, remove, or rename
departments; the home screen and colored tab cards update to match:

```js
DEPARTMENTS: [
  "แผนกออกแบบ",
  "แผนกประเมินราคา",
  "แผนกก่อสร้าง",
  "แผนกเทคนิควิศวกรรม",
  "แผนกตรวจสอบคุณภาพ",
  "แผนกสนับสนุนการก่อสร้าง",
],
```

Each department is a **real Drive folder** — files uploaded while inside it
go directly into that folder, so the structure is visible and usable from
Drive itself too, not just from this app.

## 3. Run it locally

No build step — just serve the folder statically:

```bash
npx serve .
# or
python3 -m http.server 5500
```

Open the URL it prints, and add that exact origin to the Authorized
JavaScript origins list in step 1 if it isn't there already.

## 4. Deploy for real

Because this is fully static (`index.html`, `styles.css`, `app.js`,
`config.js`), any static host works:

**Vercel**
```bash
npm i -g vercel
vercel --prod
```

**Netlify** — drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop),
or `netlify deploy --prod`.

**GitHub Pages** — push this folder to a repo, enable Pages on the branch.

After deploying, take the live URL and add it to **Authorized JavaScript
origins** in the Google Cloud OAuth client (step 1) — Google will reject
sign-in from any origin not on that list.

## 5. Using it on mobile

This app is a **PWA (Progressive Web App)** — same code, installable to a
phone's home screen like a native app, no app store needed.

**Android (Chrome/Edge):** open the deployed URL → a browser banner or an
in-app **"⭳ Install"** button appears in the top bar → tap it → the app is
added to the home screen and opens full-screen, with its own icon.

**iPhone/iPad (Safari):** iOS doesn't support automatic install prompts, so
the app shows a one-time banner: tap **Share ⬆ → Add to Home Screen**. Once
added, it opens full-screen with no browser chrome.

What this gets you:
- App icon + splash color on the home screen, opens full-screen (no address
  bar).
- The app shell (HTML/CSS/JS) is cached by a service worker, so it opens
  instantly on repeat visits, even on a flaky connection.
- File data always comes live from Drive — nothing is cached offline
  (deliberately; this avoids showing a stale file list). If there's no
  connection, the shell still opens but shows a network error until it's
  restored.

**Requirements / caveats:**
- Service workers (and therefore install prompts) only work over **HTTPS**
  — a real deployment (Vercel/Netlify/GitHub Pages), not `file://`. Local
  `http://localhost` also works for testing.
- If Google sign-in ever fails specifically inside the installed/standalone
  app on iOS (rare, depends on iOS version), use **Share → Open in Safari**
  once to sign in, then relaunch from the home screen — the session
  persists.
- Icons live in `icons/` — replace `icon-192.png` / `icon-512.png` /
  `icon-maskable-512.png` with your own artwork any time; same filenames,
  same sizes.



This app uses the broad `https://www.googleapis.com/auth/drive` scope for
simplicity: it can list, upload, rename, and delete anywhere in the target
folder without extra UI. Tradeoffs:

- **Unverified app**: fine for personal use or a closed team (add each
  person as a "test user" in the OAuth consent screen — up to 100).
- **Public app for strangers**: Google requires app verification + a
  security assessment for the full `drive` scope, which is a multi-week
  process. For a public-facing tool, switch to the narrower `drive.file`
  scope plus the Google Picker API (user explicitly selects the folder on
  first login) — no verification required. This is a larger change to
  `app.js`; ask if you want that version instead.

## What's not included

- **No file versioning UI** (Drive keeps revisions automatically; not
  exposed here).
- **No sharing/permissions management** — manage that in Drive directly, or
  ask for it as an addition.
- **No server-side rendering / SEO** — this is an authenticated internal
  tool, not a public content site.

## Search — how it works

The search box searches **file names and document content together**,
across the whole library (every department, every subfolder), not just the
folder you're currently in.

It's built on Google Drive's own `fullText contains` index — there's no
separate search engine to run or maintain. Coverage:

| File type | Content searchable? |
|---|---|
| Google Docs / Sheets / Slides | Yes, fully |
| PDF with real text (not scanned) | Yes |
| Word / Excel / PowerPoint (.docx, .xlsx, .pptx) | Yes |
| Scanned PDF / photographed document (image only) | **No**, unless OCR'd first |
| Plain images, video | Name only |

**For scanned documents:** upload them, then in Drive right-click → **Open
with → Google Docs**. Drive OCRs the image and creates a searchable Google
Doc alongside the original — do this once per scanned file you want
findable by content. (Automating this on upload is possible as a follow-up
if it comes up often — ask if you want it built in.)

**How it stays fast:** the app keeps a small in-memory map of your folder
tree so it can tell "this result is inside our library" apart from
unrelated files elsewhere in the Drive account, without an extra API call
per result. That map rebuilds automatically every 5 minutes, and instantly
whenever you create a new folder — you never need to think about it.


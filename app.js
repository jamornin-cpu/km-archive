"use strict";

/* ===================================================================
   STATE
=================================================================== */
const state = {
  accessToken: null,
  tokenClient: null,
  currentFolderId: null,     // null until resolved to root
  rootFolderId: null,
  path: [],                  // [{id, name}] breadcrumb trail
  files: [],                 // raw Drive file objects for current folder
  filter: "all",
  query: "",

  // library-wide content search
  searchMode: false,
  searchResults: [],
  folderIndex: null,         // Map<folderId, {name, parentId}> — whole tree under root
  folderIndexBuiltAt: 0,

  // Home screen tab strip: "departments" (default) | a CONTENT_TAGS key | "latest"
  homeView: "sections",
  homeResults: [],
};

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/* ===================================================================
   DOM SHORTCUTS
=================================================================== */
const $ = (id) => document.getElementById(id);
const gate = $("gate");
const app = $("app");
const grid = $("grid");
const breadcrumbEl = $("breadcrumb");
const emptyState = $("empty-state");
const loadingState = $("loading-state");
const dropOverlay = $("drop-overlay");
const uploadTray = $("upload-tray");
const searchInput = $("search-input");
const searchStatus = $("search-status");
const homeTabsEl = $("home-tabs");
const mainContent = $("main-content");
const homeSectionsEl = $("home-sections");

/* ===================================================================
   AUTH
=================================================================== */
function initAuth() {
  if (!window.APP_CONFIG || !window.APP_CONFIG.CLIENT_ID || window.APP_CONFIG.CLIENT_ID.startsWith("YOUR_")) {
    showGateError("config.js ยังไม่ได้ใส่ CLIENT_ID — ดูขั้นตอนใน README.md");
    return;
  }

  // The Google Identity Services script tag is loaded with async/defer, so
  // it can genuinely still be in flight when this runs (slower networks,
  // mobile data, etc.) — `google` would be undefined and everything below
  // would throw before the sign-in button's click handler is ever attached,
  // making the button silently do nothing. Wait for it instead of assuming.
  waitForGoogleIdentity(() => setupAuth(), () => {
    showGateError("โหลดระบบล็อกอินของ Google ไม่สำเร็จ — เช็คอินเทอร์เน็ต หรือลองรีเฟรชหน้านี้");
  });
}

function waitForGoogleIdentity(onReady, onTimeout, attempt = 0) {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    onReady();
    return;
  }
  if (attempt >= 100) {
    // ~10s of polling (100 * 100ms) and it still hasn't shown up
    onTimeout();
    return;
  }
  setTimeout(() => waitForGoogleIdentity(onReady, onTimeout, attempt + 1), 100);
}

function setupAuth() {
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: window.APP_CONFIG.CLIENT_ID,
    scope: window.APP_CONFIG.SCOPE,
    callback: (resp) => {
      if (resp.error) {
        showGateError("เข้าสู่ระบบไม่สำเร็จ: " + resp.error);
        return;
      }
      state.accessToken = resp.access_token;
      onSignedIn();
    },
  });

  $("signin-btn").addEventListener("click", () => {
    hideGateError();
    state.tokenClient.requestAccessToken({ prompt: "consent" });
  });

  $("signout-btn").addEventListener("click", signOut);
}

function showGateError(msg) {
  const el = $("gate-error");
  el.textContent = msg;
  el.hidden = false;
}
function hideGateError() {
  $("gate-error").hidden = true;
}

function signOut() {
  if (state.accessToken) {
    google.accounts.oauth2.revoke(state.accessToken, () => {});
  }
  state.accessToken = null;
  state.currentFolderId = null;
  state.path = [];
  state.homeView = "sections";
  state.homeResults = [];
  state.searchMode = false;
  state.folderIndex = null;
  app.hidden = true;
  gate.hidden = false;
}

async function onSignedIn() {
  gate.hidden = true;
  app.hidden = false;

  const configured = window.APP_CONFIG.ROOT_FOLDER_ID && window.APP_CONFIG.ROOT_FOLDER_ID.trim();
  state.rootFolderId = configured || "root";
  state.currentFolderId = state.rootFolderId;
  state.path = [{ id: state.rootFolderId, name: window.APP_CONFIG.ROOT_LABEL || "My Drive" }];

  await ensureDepartments(state.rootFolderId);
  await loadFolder(state.currentFolderId);
  ensureFolderIndex(); // warm cache in the background; not awaited on purpose
}

/**
 * Makes sure every folder name in APP_CONFIG.DEPARTMENTS exists directly
 * under rootId. Matches by exact name (case-insensitive), creates only
 * what's missing, never duplicates. Safe to call on every sign-in.
 */
async function ensureDepartments(rootId) {
  const wanted = window.APP_CONFIG.DEPARTMENTS || [];
  if (!wanted.length) return;

  loadingState.hidden = false;
  try {
    const existing = await listFolder(rootId);
    const existingNames = new Set(
      existing.filter((f) => f.mimeType === FOLDER_MIME).map((f) => f.name.trim().toLowerCase())
    );
    const missing = wanted.filter((name) => !existingNames.has(name.trim().toLowerCase()));
    for (const name of missing) {
      await createFolder(name, rootId);
    }
  } catch (err) {
    console.error("ensureDepartments failed:", err);
    // non-fatal — user still sees whatever already exists
  } finally {
    loadingState.hidden = true;
  }
}

/* ===================================================================
   DRIVE API HELPERS
=================================================================== */
async function driveFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${state.accessToken}`,
    },
  });
  if (res.status === 401) {
    // token expired — force re-auth
    signOut();
    throw new Error("Session expired. Please sign in again.");
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive API error ${res.status}: ${body}`);
  }
  return res;
}

async function listFolder(folderId) {
  const fields = "files(id,name,mimeType,thumbnailLink,webViewLink,webContentLink,createdTime,modifiedTime,size,iconLink,properties),nextPageToken";
  let all = [];
  let pageToken = "";
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const url = `${DRIVE_FILES_URL}?q=${q}&fields=${encodeURIComponent(fields)}&pageSize=200&orderBy=folder,name_natural${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await driveFetch(url);
    const data = await res.json();
    all = all.concat(data.files || []);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return all;
}

async function listFoldersOnly(folderId) {
  const fields = "files(id,name),nextPageToken";
  let all = [];
  let pageToken = "";
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='${FOLDER_MIME}'`);
    const url = `${DRIVE_FILES_URL}?q=${q}&fields=${encodeURIComponent(fields)}&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await driveFetch(url);
    const data = await res.json();
    all = all.concat(data.files || []);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return all;
}

/**
 * Walks the entire folder tree under rootId (breadth-first, one API call
 * per folder per level, levels done in parallel) and returns a
 * Map<folderId, {name, parentId}>. Used to scope library-wide search
 * results to "everything under our root", since Drive's fullText search
 * otherwise searches the whole Drive the user can see.
 */
async function buildFolderIndex(rootId) {
  const map = new Map();
  map.set(rootId, { name: window.APP_CONFIG.ROOT_LABEL || "Root", parentId: null });

  let frontier = [rootId];
  let depth = 0;
  while (frontier.length && depth < 25) {
    const results = await Promise.all(frontier.map((id) => listFoldersOnly(id)));
    const next = [];
    results.forEach((children, i) => {
      const parentId = frontier[i];
      children.forEach((f) => {
        if (!map.has(f.id)) {
          map.set(f.id, { name: f.name, parentId });
          next.push(f.id);
        }
      });
    });
    frontier = next;
    depth++;
  }
  return map;
}

async function ensureFolderIndex(force = false) {
  const stale = Date.now() - state.folderIndexBuiltAt > 5 * 60 * 1000;
  if (!force && state.folderIndex && !stale) return state.folderIndex;
  state.folderIndex = await buildFolderIndex(state.rootFolderId);
  state.folderIndexBuiltAt = Date.now();
  return state.folderIndex;
}

function isDescendantOfRoot(parentId) {
  let cur = parentId;
  let hops = 0;
  while (cur && hops < 50) {
    if (cur === state.rootFolderId) return true;
    const entry = state.folderIndex.get(cur);
    if (!entry) return false;
    cur = entry.parentId;
    hops++;
  }
  return false;
}

function pathFromFolderIndex(folderId) {
  const chain = [];
  let cur = folderId;
  let hops = 0;
  while (cur && hops < 50) {
    const entry = state.folderIndex.get(cur);
    if (!entry) break;
    chain.unshift({ id: cur, name: entry.name });
    cur = entry.parentId;
    hops++;
  }
  return chain.length ? chain : [{ id: state.rootFolderId, name: window.APP_CONFIG.ROOT_LABEL || "Root" }];
}

function escapeForDriveQuery(str) {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Searches file NAME and DOCUMENT CONTENT (Drive's built-in fullText
 * index — covers Google Docs/Sheets/Slides, and text extracted from PDFs
 * and Office files) across the whole library, then narrows results down
 * to files that actually live under our root folder.
 */
async function performGlobalSearch(term) {
  $("search-loading").hidden = false;
  grid.innerHTML = "";
  emptyState.hidden = true;
  try {
    await ensureFolderIndex();

    const esc = escapeForDriveQuery(term.trim());
    const q = `(name contains '${esc}' or fullText contains '${esc}') and trashed=false and mimeType != '${FOLDER_MIME}'`;
    const fields = "files(id,name,mimeType,thumbnailLink,webViewLink,webContentLink,parents,modifiedTime,size,properties),nextPageToken";

    let all = [];
    let pageToken = "";
    do {
      const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=100&orderBy=modifiedTime desc${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const res = await driveFetch(url);
      const data = await res.json();
      all = all.concat(data.files || []);
      pageToken = data.nextPageToken || "";
    } while (pageToken && all.length < 300);

    state.searchResults = all.filter((f) => (f.parents || []).some((p) => isDescendantOfRoot(p)));
    renderGrid();
  } catch (err) {
    console.error(err);
    showTransientError(err.message);
  } finally {
    $("search-loading").hidden = true;
  }
}

async function createFolder(name, parentId) {
  const res = await driveFetch(DRIVE_FILES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return res.json();
}

/**
 * Home-screen tab: files anywhere in the library tagged with a given
 * CONTENT_TAGS key (stored as a Drive "property", not a folder move —
 * a file keeps living wherever its department put it).
 */
async function loadTaggedFiles(tagKey) {
  loadingState.hidden = false;
  grid.innerHTML = "";
  emptyState.hidden = true;
  try {
    await ensureFolderIndex();
    const fields = "files(id,name,mimeType,thumbnailLink,webViewLink,webContentLink,parents,modifiedTime,size,properties),nextPageToken";
    const q = `properties has { key='kmTag' and value='${tagKey}' } and trashed=false`;
    let all = [];
    let pageToken = "";
    do {
      const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=200&orderBy=name_natural${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const res = await driveFetch(url);
      const data = await res.json();
      all = all.concat(data.files || []);
      pageToken = data.nextPageToken || "";
    } while (pageToken);

    state.homeResults = all.filter((f) => (f.parents || []).some((p) => isDescendantOfRoot(p)));
    renderGrid();
  } catch (err) {
    console.error(err);
    showTransientError(err.message);
  } finally {
    loadingState.hidden = true;
  }
}

/** Home-screen tab: most recently modified files anywhere in the library. */
async function loadLatestFiles() {
  loadingState.hidden = false;
  grid.innerHTML = "";
  emptyState.hidden = true;
  try {
    await ensureFolderIndex();
    const fields = "files(id,name,mimeType,thumbnailLink,webViewLink,webContentLink,parents,modifiedTime,size,properties),nextPageToken";
    const q = `trashed=false and mimeType != '${FOLDER_MIME}'`;
    let all = [];
    let pageToken = "";
    // Pull a bit more than we need, since some results will be outside our
    // root folder and get filtered out below.
    do {
      const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=50&orderBy=modifiedTime desc${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const res = await driveFetch(url);
      const data = await res.json();
      all = all.concat(data.files || []);
      pageToken = data.nextPageToken || "";
    } while (pageToken && all.length < 150);

    state.homeResults = all.filter((f) => (f.parents || []).some((p) => isDescendantOfRoot(p))).slice(0, 24);
    renderGrid();
  } catch (err) {
    console.error(err);
    showTransientError(err.message);
  } finally {
    loadingState.hidden = true;
  }
}

/** Sets (or clears, if tagKey is null) the kmTag property on a file. */
async function setFileTag(fileId, tagKey) {
  const res = await driveFetch(`${DRIVE_FILES_URL}/${fileId}?fields=properties`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { kmTag: tagKey } }),
  });
  const updated = await res.json();
  // keep whatever list is currently on screen in sync without a full reload
  [state.files, state.searchResults, state.homeResults].forEach((list) => {
    const hit = list.find((f) => f.id === fileId);
    if (hit) hit.properties = updated.properties || {};
  });
  return updated;
}

async function deleteFile(fileId) {
  await driveFetch(`${DRIVE_FILES_URL}/${fileId}`, { method: "DELETE" });
}

async function renameFile(fileId, newName) {
  const res = await driveFetch(`${DRIVE_FILES_URL}/${fileId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  return res.json();
}

function uploadFile(file, parentId, onProgress, overrideName, properties) {
  return new Promise((resolve, reject) => {
    const metadata = { name: overrideName || file.name, parents: [parentId] };
    if (properties) metadata.properties = properties;
    const boundary = "-------drivearchive" + Date.now();
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--`;

    const reader = new FileReader();
    reader.onload = () => {
      const base64Data = reader.result.split(",")[1];
      const body =
        delimiter +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify(metadata) +
        delimiter +
        `Content-Type: ${file.type || "application/octet-stream"}\r\n` +
        "Content-Transfer-Encoding: base64\r\n\r\n" +
        base64Data +
        closeDelim;

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,mimeType,properties`);
      xhr.setRequestHeader("Authorization", `Bearer ${state.accessToken}`);
      xhr.setRequestHeader("Content-Type", `multipart/related; boundary=${boundary}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(new Error(`Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.send(body);
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Document numbering — "{TYPE}-{DEPT}-{NNN}", matching the latest house
 * format (e.g. "WI-DES-001"). Numbering is scoped per type *and*
 * department: DES's WI-001 and CON's WI-001 are independent counters.
 * Scans the whole library for existing files already tagged with this
 * exact (type, dept) pair, takes the highest sequence found, returns the
 * next one.
 *
 * Note: like any "read max, then use max+1" scheme, two people generating
 * a code for the same (type, dept) at the exact same moment could in
 * theory get the same number. Fine for a small team; mention it if it
 * ever bites.
 */
async function getMaxDocSeq(typeKey, deptCode) {
  const fields = "files(properties),nextPageToken";
  const q = `properties has { key='docType' and value='${typeKey}' } and properties has { key='docDept' and value='${deptCode}' } and trashed=false`;
  let all = [];
  let pageToken = "";
  do {
    const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await driveFetch(url);
    const data = await res.json();
    all = all.concat(data.files || []);
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  let maxSeq = 0;
  all.forEach((f) => {
    const code = f.properties && f.properties.docCode;
    if (!code) return;
    const m = code.match(/-(\d+)$/);
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  });
  return maxSeq;
}

/**
 * Figures out which department the *current* folder belongs to, by
 * matching state.path against DEPARTMENTS. Works whether you're sitting
 * directly in a department folder or several subfolders deep inside one.
 * Returns { name, code, index } or null if not inside any department.
 */
function currentDepartment() {
  const depts = window.APP_CONFIG.DEPARTMENTS || [];
  const codes = window.APP_CONFIG.DEPARTMENT_CODES || [];
  for (const crumb of state.path) {
    const idx = depts.findIndex((d) => d.trim().toLowerCase() === crumb.name.trim().toLowerCase());
    if (idx !== -1) {
      return { name: depts[idx], code: codes[idx] || "GEN", index: idx };
    }
  }
  return null;
}

/** Builds the final filename: TYPE-DEPT-NNN[-RevRR]-title.ext */
function buildDocFileName(docCode, rev, title, originalName) {
  const dot = originalName.lastIndexOf(".");
  const ext = dot > -1 ? originalName.slice(dot) : "";
  const baseTitle = (title || (dot > -1 ? originalName.slice(0, dot) : originalName)).trim();
  const revPart = rev && rev.trim() ? `-Rev${rev.trim()}` : "";
  return `${docCode}${revPart}-${baseTitle}${ext}`;
}

/* ===================================================================
   FOLDER LOADING / RENDERING
=================================================================== */
async function loadFolder(folderId) {
  loadingState.hidden = false;
  emptyState.hidden = true;
  grid.innerHTML = "";
  try {
    state.files = await listFolder(folderId);
    renderBreadcrumb();
    renderGrid();
  } catch (err) {
    console.error(err);
    showTransientError(err.message);
  } finally {
    loadingState.hidden = true;
  }
}

function showTransientError(msg) {
  emptyState.hidden = false;
  emptyState.querySelector("p").textContent = "เกิดข้อผิดพลาด";
  emptyState.querySelector(".empty-sub").textContent = msg;
}

function renderBreadcrumb() {
  breadcrumbEl.innerHTML = "";
  state.path.forEach((crumb, idx) => {
    const isLast = idx === state.path.length - 1;
    const btn = document.createElement("button");
    btn.textContent = crumb.name;
    btn.className = isLast ? "current" : "";
    if (!isLast) {
      btn.addEventListener("click", () => navigateToCrumb(idx));
    }
    breadcrumbEl.appendChild(btn);
    if (!isLast) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      breadcrumbEl.appendChild(sep);
    }
  });
}

function navigateToCrumb(idx) {
  state.searchMode = false;
  state.query = "";
  searchInput.value = "";
  searchStatus.hidden = true;
  state.path = state.path.slice(0, idx + 1);
  state.currentFolderId = state.path[idx].id;
  if (idx === 0) state.homeView = "sections";
  loadFolder(state.currentFolderId);
}

function classify(mimeType) {
  if (mimeType === FOLDER_MIME) return "folder";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType === "application/pdf" ||
    mimeType.includes("document") ||
    mimeType.includes("word") ||
    mimeType.includes("text") ||
    mimeType.includes("presentation") ||
    mimeType.includes("spreadsheet")
  )
    return "document";
  return "other";
}

const TYPE_ICON = { folder: "📁", image: "🖼️", video: "🎬", document: "📄", other: "📦" };

function isAtRoot() {
  return state.path.length === 1 && state.currentFolderId === state.rootFolderId;
}

function departmentIndex(name) {
  const list = window.APP_CONFIG.DEPARTMENTS || [];
  return list.findIndex((d) => d.trim().toLowerCase() === name.trim().toLowerCase());
}

function getTag(key) {
  return (window.APP_CONFIG.CONTENT_TAGS || []).find((t) => t.key === key);
}

/** True when Home should show a flat cross-department file list (a content
 * tag or "latest") instead of a special view. */
function isHomeFlatView() {
  if (!isAtRoot() || state.searchMode) return false;
  return state.homeView !== "departments" && state.homeView !== "sections" && state.homeView !== "experts";
}

function renderHomeTabs() {
  const atRoot = isAtRoot();
  const hideStrip = !atRoot || state.searchMode || state.homeView === "sections";
  homeTabsEl.hidden = hideStrip;
  if (hideStrip) return;

  const tags = window.APP_CONFIG.CONTENT_TAGS || [];
  const tabs = [
    { key: "sections", label: "🏠 หน้าแรก", color: null },
    { key: "departments", label: "แผนก", color: null },
    ...tags,
    { key: "latest", label: "อัปเดตล่าสุด", color: "#93A6BC" },
    { key: "registry", label: "📋 ทะเบียนเอกสาร", color: "#6B4F9E" },
    { key: "experts", label: "ผู้เชี่ยวชาญ", color: "#4B5563" },
  ];

  homeTabsEl.innerHTML = tabs
    .map((t) => {
      const active = state.homeView === t.key;
      const style = t.color ? ` style="--tag-color:${t.color}"` : "";
      const dot = t.key === "departments" || t.key === "sections" ? "" : `<span class="home-tab-dot"></span>`;
      return `<button class="home-tab${active ? " active" : ""}" data-key="${t.key}"${style}>${dot}${escapeHtml(t.label)}</button>`;
    })
    .join("");

  homeTabsEl.querySelectorAll(".home-tab").forEach((btn) => {
    btn.addEventListener("click", () => selectHomeView(btn.dataset.key));
  });
}

function selectHomeView(key) {
  if (state.homeView === key) return;
  state.homeView = key;
  renderHomeTabs();
  if (key === "departments" || key === "sections" || key === "experts") {
    renderGrid();
  } else if (key === "latest") {
    loadLatestFiles();
  } else if (key === "registry") {
    loadRegistry();
  } else {
    loadTaggedFiles(key);
  }
}

/**
 * "ทะเบียนเอกสาร" — every file anywhere in the library that has a
 * document code (docCode property), listed together and sorted by code.
 * This is the flat appendix/index the whole numbering system exists to
 * produce.
 */
async function loadRegistry() {
  loadingState.hidden = false;
  grid.innerHTML = "";
  emptyState.hidden = true;
  try {
    await ensureFolderIndex();
    const fields = "files(id,name,mimeType,thumbnailLink,webViewLink,webContentLink,parents,modifiedTime,size,properties),nextPageToken";
    const q = `properties has { key='docCode' } and trashed=false`;
    let all = [];
    let pageToken = "";
    do {
      const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const res = await driveFetch(url);
      const data = await res.json();
      all = all.concat(data.files || []);
      pageToken = data.nextPageToken || "";
    } while (pageToken);

    const inLibrary = all.filter((f) => (f.parents || []).some((p) => isDescendantOfRoot(p)));
    inLibrary.sort((a, b) => {
      const ca = (a.properties && a.properties.docCode) || "";
      const cb = (b.properties && b.properties.docCode) || "";
      return ca.localeCompare(cb);
    });

    state.homeResults = inLibrary;
    renderGrid();
  } catch (err) {
    console.error(err);
    showTransientError(err.message);
  } finally {
    loadingState.hidden = true;
  }
}

function expertCardEl(p) {
  const card = document.createElement("div");
  card.className = "expert-card";
  const href = p.contactType === "tel" ? `tel:${p.contact}` : `mailto:${p.contact}`;
  card.innerHTML = `
    <div class="expert-avatar">${escapeHtml(p.icon || "👤")}</div>
    <h4>${escapeHtml(p.name || "")}</h4>
    <div class="role">${escapeHtml(p.role || "")}</div>
    ${p.dept ? `<div class="dept">${escapeHtml(p.dept)}</div>` : ""}
    ${p.contact ? `<a class="contact" href="${href}">ติดต่อ →</a>` : ""}
  `;
  return card;
}

/** The "ผู้เชี่ยวชาญ" tab isn't Drive data at all — just a static people
 * directory from config.js, rendered as its own card style. */
function renderExpertsView() {
  $("filter-tabs").hidden = true;
  searchStatus.hidden = true;
  grid.classList.remove("grid-departments");
  grid.classList.add("experts-grid");
  grid.innerHTML = "";

  const experts = window.APP_CONFIG.EXPERTS || [];
  emptyState.hidden = experts.length > 0;
  if (!experts.length) {
    emptyState.querySelector("p:first-of-type").textContent = "ยังไม่มีข้อมูลผู้เชี่ยวชาญ";
    emptyState.querySelector(".empty-sub").textContent = "เพิ่มรายชื่อได้ที่ EXPERTS ใน config.js";
    return;
  }

  experts.forEach((p) => grid.appendChild(expertCardEl(p)));
}

function renderGrid() {
  const atRoot = isAtRoot();
  renderHomeTabs();

  // The rich stacked homepage replaces the normal .content grid entirely.
  if (atRoot && !state.searchMode && state.homeView === "sections") {
    mainContent.hidden = true;
    homeSectionsEl.hidden = false;
    renderHomeSections();
    return;
  }
  homeSectionsEl.hidden = true;
  mainContent.hidden = false;

  const flatHome = isHomeFlatView();
  let items;

  if (atRoot && !state.searchMode && state.homeView === "experts") {
    renderExpertsView();
    return;
  }
  grid.classList.remove("experts-grid");

  if (state.searchMode) {
    items = state.searchResults;
    $("filter-tabs").hidden = false;
    if (state.filter !== "all") {
      items = items.filter((f) => classify(f.mimeType) === state.filter);
    }
    searchStatus.hidden = false;
    searchStatus.innerHTML = `<span>ผลการค้นหา “${escapeHtml(state.query)}” — พบ ${items.length} รายการ (ชื่อไฟล์ + เนื้อหาเอกสาร ทั้งคลัง)</span><button id="clear-search-btn">ล้างการค้นหา ✕</button>`;
    $("clear-search-btn").addEventListener("click", clearSearch);
  } else if (flatHome) {
    items = state.homeResults;
    searchStatus.hidden = true;
    $("filter-tabs").hidden = false;
    if (state.filter !== "all") {
      items = items.filter((f) => classify(f.mimeType) === state.filter);
    }
  } else {
    items = state.files;
    searchStatus.hidden = true;
    // filter tabs / type-filtering don't apply to the department home screen
    $("filter-tabs").hidden = atRoot;
    if (!atRoot && state.filter !== "all") {
      items = items.filter((f) => classify(f.mimeType) === state.filter);
    }
  }

  if (atRoot && !state.searchMode && !flatHome) {
    // department folders first, in configured order; anything else after
    items = [...items].sort((a, b) => {
      const ai = departmentIndex(a.name);
      const bi = departmentIndex(b.name);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  const showPath = state.searchMode || flatHome;
  grid.innerHTML = "";
  grid.classList.toggle("grid-departments", atRoot && !state.searchMode && !flatHome);
  emptyState.hidden = items.length > 0;
  if (!items.length) {
    emptyState.querySelector("p:first-of-type").textContent = state.searchMode
      ? "ไม่พบไฟล์ที่ตรงกับคำค้นหา"
      : flatHome
      ? "ยังไม่มีไฟล์ในหมวดนี้"
      : state.filter !== "all"
      ? "ไม่พบไฟล์ที่ตรงกับเงื่อนไข"
      : "This folder is empty.";
    emptyState.querySelector(".empty-sub").textContent = state.searchMode
      ? "ลองใช้คำค้นหาอื่น หรือคำที่สั้นลง"
      : flatHome
      ? "เปิดไฟล์แล้วติดแท็กจากหน้าต่าง preview ได้"
      : state.filter !== "all"
      ? "ลองล้างตัวกรอง"
      : "Drag files here, or use Upload above.";
    return;
  }

  items.forEach((file) => grid.appendChild(buildCard(file, atRoot && !state.searchMode && !flatHome, showPath)));
}

/** Walks up from a file's parent folder to find which top-level department
 * folder (a direct child of root) it lives under. Returns that folder's id,
 * or null if the file isn't inside any department folder (e.g. sits loose
 * at the library root). */
function topLevelDeptFolderId(parentId) {
  let cur = parentId;
  let hops = 0;
  while (cur && hops < 50) {
    const entry = state.folderIndex.get(cur);
    if (!entry) return null;
    if (entry.parentId === state.rootFolderId) return cur;
    if (cur === state.rootFolderId) return null;
    cur = entry.parentId;
    hops++;
  }
  return null;
}

/**
 * Dashboard: counts every non-folder file under the library root, bucketed
 * by which department folder it lives in and by content tag. Pulls the
 * whole library file list once (paginated, capped) rather than one query
 * per department — cheaper and avoids Drive query-length limits.
 */
async function computeDashboardStats() {
  await ensureFolderIndex();
  const fields = "files(id,mimeType,parents,properties),nextPageToken";
  const q = `trashed=false and mimeType != '${FOLDER_MIME}'`;
  let all = [];
  let pageToken = "";
  const HARD_CAP = 2000;
  do {
    const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await driveFetch(url);
    const data = await res.json();
    all = all.concat(data.files || []);
    pageToken = data.nextPageToken || "";
  } while (pageToken && all.length < HARD_CAP);

  const inLibrary = all.filter((f) => (f.parents || []).some((p) => isDescendantOfRoot(p)));

  const deptCounts = new Map(); // folderId -> count
  const tagCounts = new Map(); // tagKey -> count
  let uncategorized = 0;

  inLibrary.forEach((f) => {
    const parentId = (f.parents || [])[0];
    const deptId = parentId ? topLevelDeptFolderId(parentId) : null;
    if (deptId) {
      deptCounts.set(deptId, (deptCounts.get(deptId) || 0) + 1);
    } else {
      uncategorized++;
    }
    const tagKey = f.properties && f.properties.kmTag;
    if (tagKey) tagCounts.set(tagKey, (tagCounts.get(tagKey) || 0) + 1);
  });

  const byDept = getSortedDepartmentFolders().map((folder, idx) => ({
    id: folder.id,
    name: folder.name,
    icon: (window.APP_CONFIG.DEPARTMENT_ICONS || [])[idx] || "📁",
    colorIdx: idx % 6,
    count: deptCounts.get(folder.id) || 0,
  }));

  return {
    total: inLibrary.length,
    capped: all.length >= HARD_CAP,
    byDept,
    uncategorized,
    tagCounts,
  };
}

function dashboardSectionHtml() {
  return `
    <section class="home-section" id="dashboard-section">
      <div class="home-section-header">
        <div>
          <h2>แดชบอร์ดสรุปเอกสาร</h2>
          <div class="home-sub">ภาพรวมจำนวนเอกสารแยกตามส่วนงาน</div>
        </div>
      </div>
      <div class="dashboard-overview" id="dashboard-overview">
        <div class="search-loading">กำลังนับจำนวนเอกสาร…</div>
      </div>
      <div class="dashboard-grid" id="dashboard-grid"></div>
    </section>
  `;
}

async function loadDashboard() {
  const requestedView = state.homeView;
  try {
    const stats = await computeDashboardStats();
    if (state.homeView !== requestedView || !isAtRoot()) return;

    const overviewEl = $("dashboard-overview");
    const gridEl = $("dashboard-grid");
    if (!overviewEl || !gridEl) return;

    const activeDepts = stats.byDept.filter((d) => d.count > 0).length;
    overviewEl.innerHTML = `
      <div class="dashboard-overview-stat"><div class="num">${stats.total}${stats.capped ? "+" : ""}</div><div class="lbl">เอกสารทั้งหมด</div></div>
      <div class="dashboard-overview-stat"><div class="num">${activeDepts}/${stats.byDept.length}</div><div class="lbl">แผนกที่มีเอกสาร</div></div>
      <div class="dashboard-overview-stat"><div class="num">${stats.tagCounts.get("sop") || 0}</div><div class="lbl">SOP ที่ติดแท็ก</div></div>
      <div class="dashboard-overview-stat"><div class="num">${stats.uncategorized}</div><div class="lbl">ไฟล์นอกแผนก</div></div>
    `;

    gridEl.innerHTML = "";
    stats.byDept.forEach((d) => {
      const card = document.createElement("div");
      card.className = "dashboard-card";
      card.style.setProperty("--dept-color", ["#3E7CB1", "#C08A2E", "#B1603E", "#2F8F6B", "#6B6FA6", "#7C8A4C"][d.colorIdx]);
      card.innerHTML = `
        <div class="dc-icon">${d.icon}</div>
        <div class="dc-body">
          <div class="dc-count">${d.count}</div>
          <div class="dc-name">${escapeHtml(d.name)}</div>
        </div>
      `;
      card.addEventListener("click", async () => {
        state.path.push({ id: d.id, name: d.name });
        state.currentFolderId = d.id;
        await loadFolder(d.id);
      });
      card.style.cursor = "pointer";
      gridEl.appendChild(card);
    });

    // annotate category cards with counts (match by department name)
    document.querySelectorAll("#home-categories .card-dept").forEach((cardEl) => {
      const nameEl = cardEl.querySelector(".card-name-dept");
      if (!nameEl) return;
      const match = stats.byDept.find((d) => d.name === nameEl.textContent);
      if (match && !cardEl.querySelector(".card-count-badge")) {
        const badge = document.createElement("div");
        badge.className = "card-count-badge";
        badge.textContent = `${match.count} ไฟล์`;
        nameEl.insertAdjacentElement("afterend", badge);
      }
    });
  } catch (err) {
    console.error(err);
    const overviewEl = $("dashboard-overview");
    if (overviewEl) overviewEl.innerHTML = `<div class="empty-sub">โหลดแดชบอร์ดไม่สำเร็จ</div>`;
  }
}

function getSortedDepartmentFolders() {
  return state.files
    .filter((f) => f.mimeType === FOLDER_MIME)
    .slice()
    .sort((a, b) => {
      const ai = departmentIndex(a.name);
      const bi = departmentIndex(b.name);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
}

function articleCardEl(file) {
  const type = classify(file.mimeType);
  const tagKey = file.properties && file.properties.kmTag;
  const tag = tagKey ? getTag(tagKey) : null;
  const card = document.createElement("div");
  card.className = "article-card";
  card.innerHTML = `
    <div class="thumb">${TYPE_ICON[type]}</div>
    <div class="article-content">
      ${tag ? `<span class="article-tag" style="background:${tag.color}22;color:${tag.color}">${escapeHtml(tag.label)}</span>` : ""}
      <h4>${escapeHtml(file.name)}</h4>
      <div class="article-meta">อัปเดต ${formatDate(file.modifiedTime)}</div>
    </div>
  `;
  card.addEventListener("click", async () => {
    const parentId = (file.parents || [])[0];
    if (parentId) {
      await ensureFolderIndex();
      state.path = pathFromFolderIndex(parentId);
      state.currentFolderId = parentId;
      state.homeView = "sections";
      await loadFolder(parentId);
    }
    openPreview(file);
  });
  return card;
}

/**
 * The rich, stacked homepage: hero+search, department "categories", an SOP
 * call-to-action band, a latest-files preview, and an experts preview —
 * mirrors the reference mockup's structure while using our real data.
 */
function renderHomeSections() {
  const tags = window.APP_CONFIG.CONTENT_TAGS || [];
  const sopTag = tags.find((t) => t.key === "sop");
  const experts = (window.APP_CONFIG.EXPERTS || []).slice(0, 4);

  homeSectionsEl.innerHTML = `
    <section class="home-hero">
      <h1>ทุกคำตอบเพื่องานที่แม่นยำ ปลอดภัย และมีประสิทธิภาพ</h1>
      <p>ค้นหา SOP คู่มือปฏิบัติงาน และบทเรียนจากประสบการณ์จริง ได้ในไม่กี่วินาที เพื่อสนับสนุนการทำงานของทีมวิศวกรและปฏิบัติการทุกวัน</p>
      <div class="home-search-box">
        <input id="hero-search-input" type="text" placeholder="ค้นหาทั้งคลัง — ชื่อไฟล์หรือข้อความในเอกสาร…" autocomplete="off" />
        <button id="hero-search-btn">ค้นหาความรู้ทันที</button>
      </div>
      <div class="home-quick-links" id="hero-quick-links"></div>
    </section>

    ${dashboardSectionHtml()}

    <section class="home-section" id="categories-section">
      <div class="home-section-header">
        <div>
          <h2>หมวดหมู่ความรู้หลัก</h2>
          <div class="home-sub">เลือกแผนกที่ตรงกับงานของคุณ</div>
        </div>
      </div>
      <div class="home-categories" id="home-categories"></div>
    </section>

    ${
      sopTag
        ? `<section class="home-section" style="padding-top:0">
      <div class="sop-band">
        <div class="text">
          <h2>คู่มือ / SOP / แบบฟอร์มมาตรฐาน</h2>
          <p>รวมเอกสารปฏิบัติงานและแบบฟอร์มที่ใช้บ่อยที่สุด ติดแท็กไว้ให้ค้นหาได้จากทุกแผนก</p>
        </div>
        <button id="sop-band-btn">เข้าสู่คลังเอกสาร SOP →</button>
      </div>
    </section>`
        : ""
    }

    <section class="home-section" id="articles-section">
      <div class="home-section-header">
        <div>
          <h2>อัปเดตล่าสุด</h2>
          <div class="home-sub">ไฟล์ที่แก้ไขล่าสุดจากทุกแผนก</div>
        </div>
        <button class="home-view-all" id="articles-view-all">ดูทั้งหมด →</button>
      </div>
      <div class="home-articles" id="home-articles">
        <div class="search-loading">กำลังโหลด…</div>
      </div>
    </section>

    <section class="home-section" id="experts-section">
      <div class="home-section-header">
        <div>
          <h2>ผู้เชี่ยวชาญ / ชุมชนความรู้</h2>
          <div class="home-sub">ติดต่อผู้เชี่ยวชาญในแต่ละด้านได้โดยตรง</div>
        </div>
        <button class="home-view-all" id="experts-view-all">ดูทั้งหมด →</button>
      </div>
      <div class="home-experts" id="home-experts"></div>
    </section>

    <footer class="home-footer">
      <div class="home-footer-grid">
        <div>
          <h5>เกี่ยวกับคลังความรู้</h5>
          <a href="#" id="footer-readme-link">แนวทางการใช้งาน</a>
        </div>
        <div>
          <h5>แผนก</h5>
          ${(window.APP_CONFIG.DEPARTMENTS || []).slice(0, 3).map((d) => `<a href="#" class="footer-dept-link" data-name="${escapeHtml(d)}">${escapeHtml(d)}</a>`).join("")}
        </div>
        <div>
          <h5>เอกสาร</h5>
          ${tags.slice(0, 3).map((t) => `<a href="#" class="footer-tag-link" data-key="${t.key}">${escapeHtml(t.label)}</a>`).join("")}
        </div>
        <div>
          <h5>ติดต่อ</h5>
          <a href="#" id="footer-experts-link">ผู้เชี่ยวชาญ KM</a>
        </div>
      </div>
      <div class="home-footer-bottom">© ${new Date().getFullYear() + 543} ${escapeHtml(window.APP_CONFIG.ROOT_LABEL || "คลังความรู้องค์กร")} — พัฒนาเพื่อสนับสนุนการทำงานของทีมวิศวกรและปฏิบัติการ</div>
    </footer>
  `;

  // --- categories: real department folders as clickable cards ---
  const catsEl = $("home-categories");
  getSortedDepartmentFolders().forEach((f) => catsEl.appendChild(buildCard(f, true, false)));

  // --- hero search: reuses the exact same debounced search pipeline ---
  const heroInput = $("hero-search-input");
  const runHeroSearch = () => {
    const val = heroInput.value;
    searchInput.value = val;
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  };
  $("hero-search-btn").addEventListener("click", runHeroSearch);
  heroInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runHeroSearch();
  });

  // --- hero quick links: one pill per content tag ---
  $("hero-quick-links").innerHTML = tags
    .map((t) => `<button data-key="${t.key}">${escapeHtml(t.label)}</button>`)
    .join("");
  $("hero-quick-links").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => selectHomeView(btn.dataset.key));
  });

  // --- SOP band CTA ---
  if (sopTag) {
    $("sop-band-btn").addEventListener("click", () => selectHomeView("sop"));
  }

  // --- "view all" links ---
  $("articles-view-all").addEventListener("click", () => selectHomeView("latest"));
  $("experts-view-all").addEventListener("click", () => selectHomeView("experts"));
  $("footer-experts-link").addEventListener("click", (e) => {
    e.preventDefault();
    selectHomeView("experts");
  });
  homeSectionsEl.querySelectorAll(".footer-tag-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      selectHomeView(a.dataset.key);
    });
  });
  homeSectionsEl.querySelectorAll(".footer-dept-link").forEach((a) => {
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      const folder = state.files.find((f) => f.mimeType === FOLDER_MIME && f.name === a.dataset.name);
      if (!folder) return;
      state.path.push({ id: folder.id, name: folder.name });
      state.currentFolderId = folder.id;
      await loadFolder(folder.id);
    });
  });

  // --- experts preview (static config data, no fetch needed) ---
  const expertsEl = $("home-experts");
  if (!experts.length) {
    expertsEl.innerHTML = `<div class="empty-sub">ยังไม่มีข้อมูลผู้เชี่ยวชาญ — เพิ่มได้ที่ EXPERTS ใน config.js</div>`;
  } else {
    experts.forEach((p) => expertsEl.appendChild(expertCardEl(p)));
  }

  // --- latest-files preview (async; guard against a stale response landing
  // after the user has already navigated away from the homepage) ---
  loadLatestPreview();
  loadDashboard();
}

async function loadLatestPreview() {
  const requestedView = state.homeView;
  try {
    await ensureFolderIndex();
    const fields = "files(id,name,mimeType,thumbnailLink,parents,modifiedTime,size,properties),nextPageToken";
    const q = `trashed=false and mimeType != '${FOLDER_MIME}'`;
    const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=30&orderBy=modifiedTime desc`;
    const res = await driveFetch(url);
    const data = await res.json();
    const preview = (data.files || [])
      .filter((f) => (f.parents || []).some((p) => isDescendantOfRoot(p)))
      .slice(0, 6);

    // The user may have navigated to a different Home tab while this was
    // in flight — don't overwrite whatever they're looking at now.
    if (state.homeView !== requestedView || !isAtRoot()) return;
    const el = $("home-articles");
    if (!el) return;
    el.innerHTML = "";
    if (!preview.length) {
      el.innerHTML = `<div class="empty-sub">ยังไม่มีไฟล์ในคลัง</div>`;
      return;
    }
    preview.forEach((f) => el.appendChild(articleCardEl(f)));
  } catch (err) {
    console.error(err);
    const el = $("home-articles");
    if (el) el.innerHTML = `<div class="empty-sub">โหลดรายการล่าสุดไม่สำเร็จ</div>`;
  }
}

function clearSearch() {
  state.searchMode = false;
  state.searchResults = [];
  state.query = "";
  searchInput.value = "";
  searchStatus.hidden = true;
  renderGrid();
}

function buildCard(file, atRoot = false, showPath = false) {
  const type = classify(file.mimeType);
  const deptIdx = atRoot && type === "folder" ? departmentIndex(file.name) : -1;
  const card = document.createElement("div");
  card.className = `card type-${type}`;
  if (deptIdx !== -1) {
    card.classList.add("card-dept", `dept-${deptIdx % 6}`);
  }

  let thumbHtml = `<div class="card-icon">${TYPE_ICON[type]}</div>`;
  if (file.thumbnailLink && type !== "folder") {
    thumbHtml = `<img class="card-thumb" src="${file.thumbnailLink}" alt="" loading="lazy" onerror="this.remove()" />`;
  }

  const tagKey = file.properties && file.properties.kmTag;
  const tag = tagKey ? getTag(tagKey) : null;
  const tagHtml = tag ? `<span class="card-tag" style="--tag-color:${tag.color}">${escapeHtml(tag.label)}</span>` : "";
  const docCode = file.properties && file.properties.docCode;
  const codeHtml = docCode ? `<span class="card-doccode">${escapeHtml(docCode)}</span>` : "";

  if (deptIdx !== -1) {
    const icons = window.APP_CONFIG.DEPARTMENT_ICONS || [];
    const deptEmoji = icons[deptIdx] || "📁";
    card.innerHTML = `
      <div class="dept-tab">แผนก ${String(deptIdx + 1).padStart(2, "0")}</div>
      <div class="card-icon">${deptEmoji}</div>
      <div class="card-name card-name-dept">${escapeHtml(file.name)}</div>
    `;
  } else if (showPath) {
    const parentId = (file.parents || [])[0];
    const chain = parentId ? pathFromFolderIndex(parentId) : [];
    const pathLabel = chain.map((c) => c.name).join(" / ") || "—";
    card.innerHTML = `
      ${thumbHtml}
      <div class="card-name">${escapeHtml(file.name)}</div>
      ${codeHtml}${tagHtml}
      <div class="card-path">${escapeHtml(pathLabel)}</div>
    `;
  } else {
    const meta = type === "folder" ? "Folder" : formatBytes(file.size);
    const date = formatDate(file.modifiedTime || file.createdTime);
    card.innerHTML = `
      ${thumbHtml}
      <div class="card-name">${escapeHtml(file.name)}</div>
      ${codeHtml}${tagHtml}
      <div class="card-meta"><span>${meta}</span><span>${date}</span></div>
    `;
  }

  card.addEventListener("click", async () => {
    if (showPath) {
      const parentId = (file.parents || [])[0];
      if (parentId) {
        state.path = pathFromFolderIndex(parentId);
        state.currentFolderId = parentId;
        state.searchMode = false;
        state.query = "";
        searchInput.value = "";
        searchStatus.hidden = true;
        state.homeView = "departments";
        await loadFolder(parentId);
      }
      openPreview(file);
      return;
    }
    if (type === "folder") {
      state.path.push({ id: file.id, name: file.name });
      state.currentFolderId = file.id;
      loadFolder(file.id);
    } else {
      openPreview(file);
    }
  });

  return card;
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ===================================================================
   FILTERS / SEARCH
=================================================================== */
document.querySelectorAll(".filter-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".filter-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.filter = tab.dataset.filter;
    renderGrid();
  });
});

let searchDebounce;
searchInput.addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  const value = e.target.value;
  searchDebounce = setTimeout(() => {
    state.query = value;
    if (!value.trim()) {
      clearSearch();
      return;
    }
    if (value.trim().length < 2) return; // avoid noisy 1-char searches
    state.searchMode = true;
    performGlobalSearch(value);
  }, 350);
});

/* ===================================================================
   UPLOAD (button + drag-and-drop)
=================================================================== */
const fileInput = $("file-input");
$("upload-btn").addEventListener("click", () => fileInput.click());
$("fab-upload").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  handleFiles(Array.from(e.target.files));
  fileInput.value = "";
});

let dragCounter = 0;
window.addEventListener("dragenter", (e) => {
  if (app.hidden) return;
  e.preventDefault();
  dragCounter++;
  dropOverlay.hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (app.hidden) return;
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.hidden = true;
  }
});
window.addEventListener("dragover", (e) => {
  if (app.hidden) return;
  e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (app.hidden) return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.hidden = true;
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) handleFiles(files);
});

function handleFiles(files) {
  if (!files.length) return;
  showDocTypeChooser(files);
}

function showDocTypeChooser(files) {
  const types = window.APP_CONFIG.DOCUMENT_TYPES || [];
  const dept = currentDepartment();
  const depts = window.APP_CONFIG.DEPARTMENTS || [];
  const codes = window.APP_CONFIG.DEPARTMENT_CODES || [];

  uploadTray.hidden = false;
  uploadTray.innerHTML = `
    <div class="doctype-chooser">
      <div class="doctype-chooser-label">ติดรหัสเอกสารให้ไฟล์ชุดนี้ไหม? (${files.length} ไฟล์)</div>

      <select id="doctype-select">
        <option value="">ไม่ติดรหัส — อัปโหลดเฉยๆ</option>
        ${types.map((t) => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join("")}
      </select>

      <div id="doctype-dept-row" class="doctype-dept-row" hidden>
        ${
          dept
            ? `<span class="doctype-dept-detected">แผนก: <strong>${escapeHtml(dept.name)}</strong> (${dept.code})</span>`
            : `<select id="doctype-dept-select">
                 <option value="">— เลือกแผนกสำหรับเลขรหัส —</option>
                 ${depts.map((d, i) => `<option value="${i}">${escapeHtml(d)} (${codes[i] || "GEN"})</option>`).join("")}
               </select>`
        }
        <input id="doctype-rev-input" type="text" placeholder="Rev (ไม่บังคับ) เช่น 01" />
      </div>

      <button id="doctype-confirm-btn" class="btn btn-primary btn-sm">เริ่มอัปโหลด</button>
      <button id="doctype-cancel-btn" class="btn btn-ghost btn-sm">ยกเลิก</button>
    </div>
  `;

  const typeSelect = $("doctype-select");
  const deptRow = $("doctype-dept-row");
  typeSelect.addEventListener("change", () => {
    deptRow.hidden = !typeSelect.value;
  });

  $("doctype-cancel-btn").addEventListener("click", () => {
    uploadTray.innerHTML = "";
    uploadTray.hidden = true;
    fileInput.value = "";
  });

  $("doctype-confirm-btn").addEventListener("click", async () => {
    const typeKey = typeSelect.value || null;
    const rev = $("doctype-rev-input") ? $("doctype-rev-input").value : "";
    let deptInfo = dept;
    if (typeKey && !deptInfo) {
      const sel = $("doctype-dept-select");
      const idx = sel ? parseInt(sel.value, 10) : NaN;
      if (Number.isNaN(idx)) {
        alert("กรุณาเลือกแผนกก่อน เพื่อให้รันเลขรหัสได้ถูกต้อง");
        return;
      }
      deptInfo = { name: depts[idx], code: codes[idx] || "GEN", index: idx };
    }
    uploadTray.innerHTML = "";
    await startUploads(files, typeKey, deptInfo, rev);
  });
}

async function startUploads(files, typeKey, deptInfo, rev) {
  let nextSeq = null;
  if (typeKey && deptInfo) {
    try {
      nextSeq = (await getMaxDocSeq(typeKey, deptInfo.code)) + 1;
    } catch (err) {
      alert("อ่านเลขรหัสล่าสุดไม่สำเร็จ: " + err.message + " — จะอัปโหลดแบบไม่ติดรหัสแทน");
      typeKey = null;
    }
  }

  files.forEach((file, i) => {
    const row = document.createElement("div");
    row.className = "upload-item";
    row.innerHTML = `
      <div class="upload-item-name">${escapeHtml(file.name)}</div>
      <div class="upload-item-bar"><div class="upload-item-fill" style="width:0%"></div></div>
      <div class="upload-item-status">Uploading…</div>
    `;
    uploadTray.appendChild(row);
    const fill = row.querySelector(".upload-item-fill");
    const status = row.querySelector(".upload-item-status");

    let overrideName = null;
    let properties = null;
    if (typeKey && deptInfo && nextSeq !== null) {
      const docCode = `${typeKey}-${deptInfo.code}-${String(nextSeq + i).padStart(3, "0")}`;
      overrideName = buildDocFileName(docCode, rev, null, file.name);
      properties = { docCode, docType: typeKey, docDept: deptInfo.code };
      if (rev && rev.trim()) properties.docRev = rev.trim();
    }

    uploadFile(
      file,
      state.currentFolderId,
      (pct) => {
        fill.style.width = pct + "%";
      },
      overrideName,
      properties
    )
      .then(() => {
        row.classList.add("done");
        fill.style.width = "100%";
        status.textContent = overrideName ? `Filed as ${overrideName}` : "Filed.";
        loadFolder(state.currentFolderId);
        setTimeout(() => {
          row.remove();
          if (!uploadTray.children.length) uploadTray.hidden = true;
        }, 3500);
      })
      .catch((err) => {
        row.classList.add("error");
        status.textContent = err.message;
      });
  });
}

/* ===================================================================
   NEW FOLDER
=================================================================== */
$("new-folder-btn").addEventListener("click", async () => {
  const name = prompt("ชื่อโฟลเดอร์ใหม่:");
  if (!name || !name.trim()) return;
  try {
    await createFolder(name.trim(), state.currentFolderId);
    state.folderIndex = null; // force a fresh tree walk next search
    loadFolder(state.currentFolderId);
  } catch (err) {
    alert("สร้างโฟลเดอร์ไม่สำเร็จ: " + err.message);
  }
});

/* ===================================================================
   PREVIEW MODAL
=================================================================== */
const modal = $("preview-modal");
let activeFile = null;

// Native Google Docs/Sheets/Slides are NOT served through the generic
// drive.google.com/file/.../preview embed — that URL loads blank for
// them. Each Workspace type has its own viewer host.
const GOOGLE_WORKSPACE_VIEWERS = {
  "application/vnd.google-apps.document": "document",
  "application/vnd.google-apps.spreadsheet": "spreadsheets",
  "application/vnd.google-apps.presentation": "presentation",
};

function buildEmbedUrl(file) {
  const viewer = GOOGLE_WORKSPACE_VIEWERS[file.mimeType];
  if (viewer) return `https://docs.google.com/${viewer}/d/${file.id}/preview`;
  return `https://drive.google.com/file/d/${file.id}/preview`;
}

function openPreview(file) {
  activeFile = file;
  $("modal-title").textContent = file.name;
  $("modal-open-link").href = file.webViewLink || "#";

  const body = $("modal-body");
  const type = classify(file.mimeType);
  const embedUrl = buildEmbedUrl(file);

  if (type === "image" || type === "video" || type === "document") {
    body.innerHTML = `<iframe src="${embedUrl}" allow="autoplay" allowfullscreen></iframe>`;
  } else {
    body.innerHTML = `<div class="no-preview">No inline preview for this file type.<br/>Use "Open in Drive" to view it.</div>`;
  }

  $("modal-meta").innerHTML = `
    <span>Type: ${escapeHtml(file.mimeType)}</span>
    <span>Size: ${formatBytes(file.size)}</span>
    <span>Modified: ${formatDate(file.modifiedTime)}</span>
  `;

  renderModalTags(file);
  modal.hidden = false;
}

function renderModalTags(file) {
  const tags = window.APP_CONFIG.CONTENT_TAGS || [];
  const current = file.properties && file.properties.kmTag;
  const el = $("modal-tags");

  el.innerHTML = tags
    .map((t) => {
      const active = current === t.key;
      return `<button class="modal-tag-btn${active ? " active" : ""}" data-key="${t.key}" style="--tag-color:${t.color}"><span class="modal-tag-dot"></span>${escapeHtml(t.label)}</button>`;
    })
    .join("");

  el.querySelectorAll(".modal-tag-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!activeFile) return;
      const key = btn.dataset.key;
      const clickingActive = btn.classList.contains("active");
      const newKey = clickingActive ? null : key; // click again to clear
      btn.disabled = true;
      try {
        const updated = await setFileTag(activeFile.id, newKey);
        activeFile.properties = updated.properties || {};
        renderModalTags(activeFile);
        renderGrid(); // reflect the new/removed badge on the card behind the modal
      } catch (err) {
        alert("ติดแท็กไม่สำเร็จ: " + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function closePreview() {
  modal.hidden = true;
  $("modal-body").innerHTML = "";
  $("modal-tags").innerHTML = "";
  activeFile = null;
}

$("modal-close-btn").addEventListener("click", closePreview);
$("modal-backdrop").addEventListener("click", closePreview);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) closePreview();
});

$("modal-rename-btn").addEventListener("click", async () => {
  if (!activeFile) return;
  const newName = prompt("ชื่อใหม่:", activeFile.name);
  if (!newName || !newName.trim() || newName === activeFile.name) return;
  try {
    await renameFile(activeFile.id, newName.trim());
    closePreview();
    loadFolder(state.currentFolderId);
  } catch (err) {
    alert("เปลี่ยนชื่อไม่สำเร็จ: " + err.message);
  }
});

$("modal-delete-btn").addEventListener("click", async () => {
  if (!activeFile) return;
  if (!confirm(`ลบ "${activeFile.name}" ถาวรหรือไม่?`)) return;
  try {
    await deleteFile(activeFile.id);
    closePreview();
    loadFolder(state.currentFolderId);
  } catch (err) {
    alert("ลบไม่สำเร็จ: " + err.message);
  }
});

/* ===================================================================
   PWA — service worker + install prompts
=================================================================== */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Service workers require HTTPS (localhost is exempt). Fails silently
  // and harmlessly if served over plain http on a real domain.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js?v=8").catch((err) => {
      console.warn("Service worker registration skipped:", err.message);
    });
  });
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function initInstallPrompts() {
  const installBtn = $("install-btn");
  let deferredPrompt = null;

  // Android / Chrome / Edge: native install prompt
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    installBtn.hidden = true;
  });

  // iOS Safari has no beforeinstallprompt — show a one-time manual hint.
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const dismissed = localStorage.getItem("archive_ios_banner_dismissed") === "1";
  if (isIOS && !isStandalone() && !dismissed) {
    $("ios-install-banner").hidden = false;
  }
  $("ios-banner-close").addEventListener("click", () => {
    $("ios-install-banner").hidden = true;
    localStorage.setItem("archive_ios_banner_dismissed", "1");
  });
}

/* ===================================================================
   BOOT
=================================================================== */
window.addEventListener("DOMContentLoaded", () => {
  initAuth();
  initInstallPrompts();
  registerServiceWorker();
});

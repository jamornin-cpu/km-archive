/* app.js UI hook patch for refreshed index.html */
document.addEventListener('DOMContentLoaded', () => {
  const map = {
    breadcrumb: 'breadcrumb',
    searchInput: 'search-input',
    heroInput: 'hero-search-input',
    heroBtn: 'hero-search-btn',
    quickLinks: 'home-quick-links',
    dashOverview: 'dashboard-overview',
    dashGrid: 'dashboard-grid',
    cats: 'home-categories',
    articles: 'home-articles',
    experts: 'home-experts',
    articlesView: 'articles-view-all',
    expertsView: 'experts-view-all',
    fab: 'fab-upload',
    uploadBtn: 'upload-btn',
    folderBtn: 'new-folder-btn',
    signoutBtn: 'signout-btn',
    fileInput: 'file-input',
    dropOverlay: 'drop-overlay',
    previewModal: 'preview-modal',
    modalBackdrop: 'modal-backdrop',
    modalClose: 'modal-close',
    modalTitle: 'modal-title',
    modalOpen: 'modal-open-link',
    modalBody: 'modal-body',
    modalMeta: 'modal-meta',
    modalDoccode: 'modal-doccode',
    modalTags: 'modal-tags'
  };

  const missing = Object.entries(map).filter(([k, id]) => !document.getElementById(id)).map(([k]) => k);
  window.__UI_HOOK_CHECK__ = missing;
  if (missing.length) console.warn('Missing UI hooks:', missing);
});

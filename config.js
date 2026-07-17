// ==========================================================
// CONFIG — edit these two values before deploying
// ==========================================================
window.APP_CONFIG = {
  // Get this from Google Cloud Console → APIs & Services → Credentials
  // (OAuth 2.0 Client ID, type "Web application")
    CLIENT_ID: "109721573345-6emvfud6s9lfmrdcv7e8hod75ec3ap30.apps.googleusercontent.com",

  // Scope needed to read/write files. Using the broad "drive" scope keeps
  // setup simple (no Picker flow) — see README for the tradeoffs and the
  // narrower drive.file alternative.
  SCOPE: "https://www.googleapis.com/auth/drive",

  // Optional: paste a Drive folder ID here to lock the library to one
  // folder (recommended). Leave empty to browse the user's whole My Drive.
  // The folder ID is the long string in the folder's URL:
  // https://drive.google.com/drive/folders/<THIS_PART>
    ROOT_FOLDER_ID: "1A63mxgJfpb_TACRYI9QAJFK-AD6HO55F",

  // Label shown for the top-level breadcrumb / home screen.
  ROOT_LABEL: "ฝ่ายวิศวกรรม",

  // Department folders. Created automatically inside ROOT_FOLDER_ID the
  // first time each one is missing — safe to re-run, existing folders are
  // detected by name and reused, never duplicated.
  // Add/remove/rename departments here to change the home screen.
  DEPARTMENTS: [
    "แผนกออกแบบ",
    "แผนกประเมินราคา",
    "แผนกก่อสร้าง",
    "แผนกเทคนิควิศวกรรม",
    "แผนกตรวจสอบคุณภาพ",
    "แผนกสนับสนุนการก่อสร้าง",
  ],
};

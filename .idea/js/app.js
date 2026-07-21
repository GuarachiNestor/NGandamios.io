/* ===================== UTILIDADES ===================== */
const CATEGORIES = ["Eléctrica", "Manual", "Andamios/Estructura", "Medición", "Seguridad", "Otro"];
const PERIOD_TYPES = ["Día", "Semana", "Quincena", "Mes"];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayISO() { return new Date().toISOString().split("T")[0]; }
function fmtDate(iso) { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
function fmtMoney(n) { const num = Number(n) || 0; return "$" + num.toLocaleString("es-AR", { maximumFractionDigits: 0 }); }
function esc(s) { const d = document.createElement("div"); d.innerText = s == null ? "" : s; return d.innerHTML; }

function priceForPeriod(machine, periodType) {
  if (!machine) return 0;
  if (periodType === "Día") return machine.priceDay;
  if (periodType === "Semana") return machine.priceWeek;
  if (periodType === "Quincena") return machine.priceQuincena;
  return machine.priceMonth;
}

function calcDueDate(startDate, periodType, count) {
  const d = new Date(startDate + "T00:00:00");
  const c = Number(count) || 0;
  if (periodType === "Día") d.setDate(d.getDate() + c);
  else if (periodType === "Semana") d.setDate(d.getDate() + c * 7);
  else if (periodType === "Quincena") d.setDate(d.getDate() + c * 15);
  else if (periodType === "Mes") d.setMonth(d.getMonth() + c);
  return d.toISOString().split("T")[0];
}

function icon(name, cls) {
  const tpl = document.getElementById("icon-templates").content.getElementById("ic-" + name);
  const clone = tpl.cloneNode(true);
  clone.removeAttribute("id");
  if (cls) clone.setAttribute("class", cls);
  return clone.outerHTML;
}

function resizeImage(file, maxWidth = 900, quality = 0.62) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ===================== ALMACENAMIENTO ===================== */
// Datos livianos (máquinas, alquileres) -> localStorage
// Fotos (pueden pesar) -> IndexedDB
const LS_MACHINES = "ah_machines";
const LS_RENTALS = "ah_rentals";

function loadMachines() { try { return JSON.parse(localStorage.getItem(LS_MACHINES)) || []; } catch { return []; } }
function saveMachines(list) { localStorage.setItem(LS_MACHINES, JSON.stringify(list)); scheduleAutoSync(); }
function loadRentals() { try { return JSON.parse(localStorage.getItem(LS_RENTALS)) || []; } catch { return []; } }
function saveRentals(list) { localStorage.setItem(LS_RENTALS, JSON.stringify(list)); scheduleAutoSync(); }

let dbPromise = null;
function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("alquilerHTA", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("photos");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function savePhoto(key, dataUrl) {
  const db = await getDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").put(dataUrl, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  scheduleAutoSync();
}
async function getPhoto(key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readonly");
    const req = tx.objectStore("photos").get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function deletePhoto(key) {
  const db = await getDB();
  await new Promise((resolve) => {
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").delete(key);
    tx.oncomplete = () => resolve();
  });
  scheduleAutoSync();
}

/* ===================== GOOGLE DRIVE: RESPALDO AUTOMÁTICO ===================== */
// 1) Creá un proyecto en https://console.cloud.google.com/ (gratis).
// 2) Activá la "Google Drive API".
// 3) Configurá la pantalla de consentimiento OAuth (tipo "Externo", agregate a vos mismo
//    como usuario de prueba) y creá una credencial "ID de cliente de OAuth" de tipo
//    "Aplicación web", con tu dominio de GitHub Pages en "Orígenes de JavaScript autorizados"
//    (ej: https://guarachinestor.github.io).
// 4) Pegá acá abajo el Client ID que te da Google:
const GOOGLE_CLIENT_ID = "1042664850210-9gc6c389nst5dl6v9t0sddhoulp2c487.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_BACKUP_FILENAME = "AlquilerHerramientas_backup.json";
const DRIVE_REPORTS_FOLDER_NAME = "Alquiler Herramientas - Reportes";
const DRIVE_REPORT_ALQUILERES_FILENAME = "Reporte_Alquileres.xlsx";
const DRIVE_REPORT_STOCK_FILENAME = "Reporte_Stock.xlsx";
const LS_DRIVE_SIGNED_IN = "ah_drive_signed_in";
const LS_DRIVE_REPORTS_FOLDER_ID = "ah_drive_reports_folder_id";
const LS_DRIVE_REPORTS_FOLDER_LINK = "ah_drive_reports_folder_link";

const driveSync = {
  tokenClient: null,
  ready: false,
  accessToken: null,
  tokenExpiresAt: 0,
  signedIn: false,
  syncing: false,
  lastSyncAt: null,
  fileId: null,
  saveTimer: null,
  // --- reportes compartidos (Excel) ---
  reportsFolderId: localStorage.getItem(LS_DRIVE_REPORTS_FOLDER_ID) || null,
  reportsFolderLink: localStorage.getItem(LS_DRIVE_REPORTS_FOLDER_LINK) || null,
  reportsFileIds: { alquileres: null, stock: null },
  reportsSyncing: false,
  reportsLastSyncAt: null,
  reportsSaveTimer: null,
  reportsLastError: null,
};
let isRestoringFromDrive = false;

function initGoogleAuthWhenReady() {
  if (GOOGLE_CLIENT_ID.indexOf("PONÉ_ACÁ") === 0) return; // todavía no configuraron el Client ID
  if (window.google && google.accounts && google.accounts.oauth2) {
    driveSync.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (resp) => handleTokenResponse(resp),
    });
    driveSync.ready = true;
    if (localStorage.getItem(LS_DRIVE_SIGNED_IN) === "1") {
      driveSync.tokenClient.requestAccessToken({ prompt: "" }); // intenta recuperar la sesión sin mostrar el popup
    }
  } else {
    setTimeout(initGoogleAuthWhenReady, 300);
  }
}

function handleTokenResponse(resp) {
  if (resp.error) {
    console.error("Error de Google Sign-In:", resp);
    driveSync.signedIn = false;
    updateDriveStatusUI();
    return;
  }
  driveSync.accessToken = resp.access_token;
  driveSync.tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3500) * 1000;
  const eraLogin = !driveSync.signedIn;
  driveSync.signedIn = true;
  localStorage.setItem(LS_DRIVE_SIGNED_IN, "1");
  updateDriveStatusUI();
  if (eraLogin) {
    restoreFromDriveIfNeeded();
    setTimeout(() => syncReportsToDrive(false), 1500);
  }
}

function signInGoogle() {
  if (!driveSync.ready) {
    alert("Todavía se está cargando el inicio de sesión de Google. Esperá un segundo e intentá de nuevo.\n\n(Si nunca cargó, es porque falta configurar el GOOGLE_CLIENT_ID en el código.)");
    return;
  }
  driveSync.tokenClient.requestAccessToken({ prompt: "consent" });
}

function signOutGoogle() {
  if (driveSync.accessToken && window.google && google.accounts.oauth2.revoke) {
    google.accounts.oauth2.revoke(driveSync.accessToken, () => {});
  }
  driveSync.accessToken = null;
  driveSync.signedIn = false;
  driveSync.fileId = null;
  driveSync.reportsFileIds = { alquileres: null, stock: null };
  driveSync.reportsLastSyncAt = null;
  driveSync.reportsLastError = null;
  localStorage.removeItem(LS_DRIVE_SIGNED_IN);
  updateDriveStatusUI();
  toast("Sesión de Google cerrada");
}

function ensureAccessToken() {
  return new Promise((resolve, reject) => {
    if (driveSync.accessToken && Date.now() < driveSync.tokenExpiresAt - 30000) {
      resolve(driveSync.accessToken);
      return;
    }
    if (!driveSync.tokenClient) { reject(new Error("Google Sign-In no está listo")); return; }
    driveSync.tokenClient.callback = (resp) => {
      handleTokenResponse(resp);
      if (resp.error) reject(new Error(resp.error));
      else resolve(resp.access_token);
    };
    driveSync.tokenClient.requestAccessToken({ prompt: "" });
  });
}

async function driveFindBackupFileId(token) {
  if (driveSync.fileId) return driveSync.fileId;
  const q = encodeURIComponent(`name='${DRIVE_BACKUP_FILENAME}' and trashed=false`);
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (data.files && data.files.length > 0) driveSync.fileId = data.files[0].id;
  return driveSync.fileId;
}

async function collectBackupPayload() {
  const db = await getDB();
  const keys = await new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readonly");
    const req = tx.objectStore("photos").getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const photos = {};
  for (const key of keys) photos[key] = await getPhoto(key);
  return { version: 1, savedAt: new Date().toISOString(), machines: state.machines, rentals: state.rentals, photos };
}

function scheduleAutoSync(immediate) {
  if (!driveSync.signedIn || isRestoringFromDrive) return;
  clearTimeout(driveSync.saveTimer);
  if (immediate) { uploadBackupToDrive(); } else { driveSync.saveTimer = setTimeout(uploadBackupToDrive, 2500); }
  scheduleReportsAutoSync(immediate);
}

async function uploadBackupToDrive() {
  driveSync.syncing = true;
  updateDriveStatusUI();
  try {
    const token = await ensureAccessToken();
    const payload = await collectBackupPayload();
    const fileId = await driveFindBackupFileId(token);
    const metadata = { name: DRIVE_BACKUP_FILENAME, mimeType: "application/json" };
    const boundary = "ahboundary" + Date.now();
    const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--`;
    const url = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
    const resp = await fetch(url, {
      method: fileId ? "PATCH" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    const data = await resp.json();
    if (data.id) driveSync.fileId = data.id;
    driveSync.lastSyncAt = new Date();
  } catch (err) {
    console.error("Error subiendo el respaldo a Drive:", err);
  } finally {
    driveSync.syncing = false;
    updateDriveStatusUI();
  }
}

/* ---- Carpeta compartida de Drive con los reportes Excel (Alquileres y Stock) ---- */
// Busca en Drive la carpeta guardada; si ya no existe (por ej. se cerró sesión con otra
// cuenta), la vuelve a crear. La carpeta queda visible en "Mi unidad" del usuario para
// que la comparta una sola vez con quien necesite ver los reportes.
async function driveEnsureReportsFolder(token) {
  if (driveSync.reportsFolderId) {
    const check = await fetch(`https://www.googleapis.com/drive/v3/files/${driveSync.reportsFolderId}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (check.ok) {
      const data = await check.json();
      if (!data.trashed) return driveSync.reportsFolderId;
    }
    driveSync.reportsFolderId = null;
  }

  const q = encodeURIComponent(`name='${DRIVE_REPORTS_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const searchData = await searchResp.json();
  if (searchData.files && searchData.files.length > 0) {
    driveSync.reportsFolderId = searchData.files[0].id;
  } else {
    const createResp = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: DRIVE_REPORTS_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    const createData = await createResp.json();
    driveSync.reportsFolderId = createData.id;
  }
  localStorage.setItem(LS_DRIVE_REPORTS_FOLDER_ID, driveSync.reportsFolderId);

  // Guardamos el link directo a la carpeta para mostrarlo en la app.
  const linkResp = await fetch(`https://www.googleapis.com/drive/v3/files/${driveSync.reportsFolderId}?fields=webViewLink`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const linkData = await linkResp.json();
  if (linkData.webViewLink) {
    driveSync.reportsFolderLink = linkData.webViewLink;
    localStorage.setItem(LS_DRIVE_REPORTS_FOLDER_LINK, linkData.webViewLink);
  }
  return driveSync.reportsFolderId;
}

async function driveFindFileInFolder(token, filename, folderId) {
  const q = encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`);
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  return (data.files && data.files.length > 0) ? data.files[0].id : null;
}

// Sube un archivo binario (el .xlsx) a Drive. Usa Blob para armar el cuerpo multipart
// en vez de concatenar texto, porque un xlsx es binario y concatenarlo como string
// (como se hace con el respaldo JSON) corrompería el archivo.
async function driveUploadBinaryFile(token, filename, blob, mimeType, folderId, existingFileId) {
  const metadata = existingFileId ? { name: filename } : { name: filename, mimeType, parents: [folderId] };
  const boundary = "ahboundary" + Date.now() + Math.random().toString(36).slice(2);
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const filePartHeader = `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const closeDelim = `\r\n--${boundary}--`;
  const multipartBody = new Blob([metaPart, filePartHeader, blob, closeDelim]);

  const url = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
  const resp = await fetch(url, {
    method: existingFileId ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipartBody,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error((data.error && data.error.message) || "Error subiendo el archivo a Drive");
  return data.id;
}

function scheduleReportsAutoSync(immediate) {
  if (!driveSync.signedIn || isRestoringFromDrive) return;
  clearTimeout(driveSync.reportsSaveTimer);
  if (immediate) { syncReportsToDrive(false); return; }
  driveSync.reportsSaveTimer = setTimeout(() => syncReportsToDrive(false), 2500);
}

// manual=true cuando lo dispara el botón "Actualizar reportes ahora" (muestra toasts/alerts).
// manual=false cuando lo dispara el autosync en segundo plano (falla en silencio, solo consola).
async function syncReportsToDrive(manual) {
  if (!driveSync.signedIn) {
    if (manual) alert("Iniciá sesión con Google (arriba, en Inicio) para poder compartir los reportes.");
    return;
  }
  driveSync.reportsSyncing = true;
  driveSync.reportsLastError = null;
  updateDriveStatusUI();
  try {
    const token = await ensureAccessToken();
    const folderId = await driveEnsureReportsFolder(token);

    let alquileresBlob = null, stockBlob = null;
    try { alquileresBlob = await construirBlobReporteAlquileres(); } catch (e) { if (e.message !== "SIN_DATOS_ALQUILERES") throw e; }
    try { stockBlob = construirBlobReporteStock(); } catch (e) { if (e.message !== "SIN_DATOS_STOCK") throw e; }

    if (alquileresBlob) {
      const existingId = driveSync.reportsFileIds.alquileres || await driveFindFileInFolder(token, DRIVE_REPORT_ALQUILERES_FILENAME, folderId);
      driveSync.reportsFileIds.alquileres = await driveUploadBinaryFile(token, DRIVE_REPORT_ALQUILERES_FILENAME, alquileresBlob, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", folderId, existingId);
    }
    if (stockBlob) {
      const existingId = driveSync.reportsFileIds.stock || await driveFindFileInFolder(token, DRIVE_REPORT_STOCK_FILENAME, folderId);
      driveSync.reportsFileIds.stock = await driveUploadBinaryFile(token, DRIVE_REPORT_STOCK_FILENAME, stockBlob, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", folderId, existingId);
    }

    driveSync.reportsLastSyncAt = new Date();
    if (manual) toast("Reportes actualizados en Drive");
  } catch (err) {
    console.error("Error subiendo los reportes a Drive:", err);
    driveSync.reportsLastError = (err && err.message) || String(err);
    if (manual) alert("No se pudieron subir los reportes: " + driveSync.reportsLastError);
  } finally {
    driveSync.reportsSyncing = false;
    updateDriveStatusUI();
  }
}

async function restoreFromDriveIfNeeded() {
  try {
    const token = await ensureAccessToken();
    const fileId = await driveFindBackupFileId(token);
    if (!fileId) {
      if (state.machines.length > 0 || state.rentals.length > 0) scheduleAutoSync(true);
      return;
    }
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const backup = await resp.json();
    const hayDatosLocales = state.machines.length > 0 || state.rentals.length > 0;
    if (!hayDatosLocales) {
      await applyBackup(backup);
      toast("Se restauraron tus datos desde Google Drive");
    } else if (confirm("Encontramos un respaldo guardado en tu cuenta de Google.\n\n¿Reemplazar los datos de este celu por los del respaldo?\n\n(Cancelar mantiene lo que ya tenés cargado acá y lo sube como respaldo nuevo).")) {
      await applyBackup(backup);
      toast("Datos restaurados desde Google Drive");
    } else {
      scheduleAutoSync(true);
    }
  } catch (err) {
    console.error("Error restaurando desde Drive:", err);
  }
}

async function applyBackup(backup) {
  isRestoringFromDrive = true;
  try {
    state.machines = backup.machines || [];
    state.rentals = backup.rentals || [];
    saveMachines(state.machines);
    saveRentals(state.rentals);
    const photos = backup.photos || {};
    for (const key of Object.keys(photos)) await savePhoto(key, photos[key]);
    render();
  } finally {
    isRestoringFromDrive = false;
  }
}

function fmtRelativeTime(date) {
  const diffMin = Math.round((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return "recién";
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `hace ${diffH} h`;
  return `el ${fmtDate(date.toISOString().split("T")[0])}`;
}

function driveSyncBlockHTML() {
  if (!driveSync.signedIn) {
    return `
      <div class="block-title">${icon("cloud")} Respaldo en Google Drive</div>
      <div class="hint" style="margin-top:0">Guardá copia automática de máquinas, alquileres y fotos en tu cuenta de Google, para no perder nada si se rompe o se pierde el celu.</div>
      <button class="btn btn-secondary btn-block" id="btn-google-signin">${icon("cloud")} Iniciar sesión con Google</button>`;
  }
  const estado = driveSync.syncing ? "Sincronizando..." : driveSync.lastSyncAt ? `Sincronizado ${fmtRelativeTime(driveSync.lastSyncAt)}` : "Conectado";
  return `
    <div class="block-title">${icon("cloud")} Respaldo en Google Drive</div>
    <div class="hint" style="margin-top:0" id="drive-sync-state">${estado}</div>
    <button class="btn-mini" id="btn-google-signout">Cerrar sesión de Google</button>`;
}

function driveReportsBlockHTML() {
  if (!driveSync.signedIn) {
    return `
      <div class="block-title">${icon("file")} Reportes compartidos (Excel)</div>
      <div class="hint" style="margin-top:0">Iniciá sesión con Google arriba para que los reportes de Alquileres y Stock se guarden solos en una carpeta de Drive, lista para compartir.</div>`;
  }
  let estado;
  if (driveSync.reportsSyncing) estado = "Actualizando reportes...";
  else if (driveSync.reportsLastError) estado = `No se pudo actualizar: ${driveSync.reportsLastError}`;
  else if (driveSync.reportsLastSyncAt) estado = `Actualizados ${fmtRelativeTime(driveSync.reportsLastSyncAt)}`;
  else estado = "Todavía no se subieron (tocá el botón o esperá al próximo cambio)";

  return `
    <div class="block-title">${icon("file")} Reportes compartidos (Excel)</div>
    <div class="hint" style="margin-top:0" id="drive-reports-state">${estado}</div>
    ${driveSync.reportsFolderLink ? `<a href="${driveSync.reportsFolderLink}" target="_blank" rel="noopener" class="hint" style="display:block;margin-top:0;margin-bottom:8px">Abrir carpeta en Drive →</a>` : `<div class="hint" style="margin-top:0">La carpeta "${DRIVE_REPORTS_FOLDER_NAME}" se crea sola en tu Drive la primera vez que se suban los reportes.</div>`}
    <button class="btn btn-secondary btn-block" id="btn-forzar-reportes" style="margin-top:0">${icon("file")} Actualizar reportes ahora</button>
    <div class="hint" style="margin-top:8px;margin-bottom:0">Compartí esa carpeta una sola vez (clic derecho → Compartir) con quien necesite ver los reportes, sin entrar a la app.</div>`;
}

function updateDriveStatusUI() {
  const block = document.getElementById("drive-sync-block");
  if (block) block.innerHTML = driveSyncBlockHTML();
  const reportsBlock = document.getElementById("drive-reports-block");
  if (reportsBlock) reportsBlock.innerHTML = driveReportsBlockHTML();
  bindDriveSyncButtons();
}

function bindDriveSyncButtons() {
  document.getElementById("btn-google-signin")?.addEventListener("click", signInGoogle);
  document.getElementById("btn-google-signout")?.addEventListener("click", signOutGoogle);
  document.getElementById("btn-forzar-reportes")?.addEventListener("click", () => syncReportsToDrive(true));
}

/* ===================== ESTADO ===================== */
const state = {
  tab: "inicio",
  machines: loadMachines(),
  rentals: loadRentals(),
  showMachineForm: false,
  editingMachine: null,
  viewingRentalId: null,
  viewingClientKey: null,
  nuevoAlquiler: freshRentalForm(),
};

function freshRentalForm() {
  return {
    items: [{ id: uid(), machineId: "", periodType: "Día", periodCount: 1 }],
    clientName: "", clientPhone: "", clientDni: "",
    discount: 0, // porcentaje (ej: 10 = 10%)
    startDate: todayISO(), notes: "", dniPhoto: null, comprobantePhoto: null,
    showPresupuesto: false,
  };
}

// Cuántas unidades de esta máquina quedan libres, contando lo que ya está
// reservado en otros renglones del mismo presupuesto (para no pasarse de stock).
function remainingStock(machine, items, excludeItemId) {
  const act = activeRentals();
  const alquiladas = act.filter((r) => r.machineId === machine.id).length;
  const reservadasEnForm = items.filter((it) => it.machineId === machine.id && it.id !== excludeItemId).length;
  return machine.totalQty - alquiladas - reservadasEnForm;
}

function activeRentals() { return state.rentals.filter((r) => r.status === "Activo"); }

// Los clientes no se cargan por separado: se arman solos a partir de los
// alquileres ya registrados, agrupando por DNI (o teléfono, o nombre si no
// hay ninguno de los dos) para que un mismo cliente junte todo su historial.
function clientKeyFor(name, dni, phone) {
  const d = (dni || "").trim();
  if (d) return "dni:" + d.toLowerCase();
  const p = (phone || "").trim();
  if (p) return "tel:" + p.replace(/\s+/g, "");
  return "nombre:" + (name || "").trim().toLowerCase();
}

function getClientsFromRentals() {
  const map = new Map();
  state.rentals.forEach((r) => {
    if (!r.clientName && !r.clientDni && !r.clientPhone) return;
    const key = clientKeyFor(r.clientName, r.clientDni, r.clientPhone);
    if (!map.has(key)) map.set(key, { key, name: r.clientName, phone: r.clientPhone, dni: r.clientDni, rentals: [] });
    const c = map.get(key);
    c.rentals.push(r);
    // Se queda con el dato más reciente que no esté vacío (por si lo completaron después)
    if (r.clientName) c.name = r.clientName;
    if (r.clientPhone) c.phone = r.clientPhone;
    if (r.clientDni) c.dni = r.clientDni;
  });
  return Array.from(map.values());
}

// Agrupa una lista de alquileres por groupId (los que vienen de un mismo
// presupuesto con varias máquinas), preservando el orden de la lista de entrada.
// Los alquileres viejos sin groupId (o sueltos) quedan en su propio grupo de a uno.
function groupRentalsForDisplay(list) {
  const seen = new Map();
  const order = [];
  list.forEach((r) => {
    const gid = r.groupId || r.id;
    if (!seen.has(gid)) { seen.set(gid, []); order.push(gid); }
    seen.get(gid).push(r);
  });
  return order.map((gid) => seen.get(gid));
}

function renderRentalGroups(list) {
  return groupRentalsForDisplay(list)
    .map((group) => (group.length > 1 ? groupedRentalCardHTML(group) : rentalCard(group[0])))
    .join("");
}

function groupedRentalCardHTML(group) {
  const todayStr = todayISO();
  const client = group[0].clientName;
  const allDevuelto = group.every((r) => r.status === "Devuelto");
  const anyOverdue = group.some((r) => r.status === "Activo" && r.dueDate < todayStr);
  const overallLabel = allDevuelto ? "Devuelto" : anyOverdue ? "Atrasado" : "Activo";
  const overallBadge = allDevuelto ? "badge-green" : anyOverdue ? "badge-red" : "badge-yellow";
  const totalCombinado = group.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const maxDueDate = group.reduce((max, r) => (r.dueDate > max ? r.dueDate : max), group[0].dueDate);

  const rows = group.map((r) => {
    const isOverdue = r.status === "Activo" && r.dueDate < todayStr;
    const statusLabel = r.status === "Devuelto" ? "Devuelto" : isOverdue ? "Atrasado" : "Activo";
    const badgeClass = r.status === "Devuelto" ? "badge-green" : isOverdue ? "badge-red" : "badge-yellow";
    return `
      <div class="group-item-row" data-open-rental="${r.id}">
        <div class="group-item-top">
          <span class="group-item-name">${esc(r.machineName)}</span>
          <span class="badge ${badgeClass}" style="font-size:9.5px">${statusLabel}</span>
        </div>
        <div class="group-item-bottom">
          <span>${icon("clock", "icon-inline")}Hasta ${fmtDate(r.dueDate)}</span>
          <span class="amount">${fmtMoney(r.total)}</span>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="card group-card" style="cursor:default">
      <div class="card-top">
        <div>
          <div class="card-name">${esc(client)}</div>
          <div class="card-sub">${group.length} máquinas del mismo presupuesto</div>
        </div>
        <div class="badge ${overallBadge}">${overallLabel}</div>
      </div>
      <div class="group-items">${rows}</div>
      <div class="card-bottom" style="border-top:1px solid var(--border);padding-top:8px;margin-top:2px">
        <span>${icon("clock", "icon-inline")}Hasta ${fmtDate(maxDueDate)}</span>
        <span class="amount">Total: ${fmtMoney(totalCombinado)}</span>
      </div>
    </div>`;
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ===================== RENDER PRINCIPAL ===================== */
function render() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="shell">
      <div class="header">
        <div class="header-row">
          <div class="header-left">
            <div class="header-logo"><img src="icons/logo.png" alt="Logo"></div>
            <div style="min-width:0">
              <div class="header-title tag-font">ALQUILER DE HERRAMIENTAS</div>
              <div class="header-sub">Control de stock y clientes</div>
            </div>
          </div>
        </div>
      </div>
      <div class="content" id="content"></div>
      <div class="nav">
        ${navBtn("home", "Inicio", "inicio")}
        ${navBtn("package", "Máquinas", "maquinas")}
        ${navBtn("plus", "Alquilar", "nuevo", true)}
        ${navBtn("list", "Alquileres", "alquileres")}
        ${navBtn("users", "Clientes", "clientes")}
      </div>
    </div>
    <div id="modal-root"></div>
  `;
  renderContent();
  bindNav();
  renderModals();
}

function navBtn(iconName, label, tabName, highlight) {
  const active = state.tab === tabName;
  return `
    <button class="nav-btn ${active ? "active" : ""} ${highlight ? "highlight" : ""}" data-tab="${tabName}">
      <div class="nav-icon-wrap">${icon(iconName)}</div>
      <span class="nav-label">${label}</span>
    </button>`;
}

function bindNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => { state.tab = btn.dataset.tab; render(); });
  });
}

function renderContent() {
  const c = document.getElementById("content");
  if (state.tab === "inicio") c.innerHTML = viewInicio();
  else if (state.tab === "maquinas") c.innerHTML = viewMaquinas();
  else if (state.tab === "nuevo") c.innerHTML = viewNuevo();
  else if (state.tab === "alquileres") c.innerHTML = viewAlquileres();
  else if (state.tab === "clientes") c.innerHTML = viewClientes();
  bindContentEvents();
}

/* ===================== VISTA: INICIO ===================== */
function viewInicio() {
  const act = activeRentals();
  const overdue = act.filter((r) => r.dueDate < todayISO());
  const totalDisponibles = state.machines.reduce((sum, m) => {
    const alquiladas = act.filter((r) => r.machineId === m.id).length;
    return sum + Math.max(0, m.totalQty - alquiladas);
  }, 0);

  let html = `
    <div class="section-title tag-font">Inicio</div>
    <div class="section-sub">Resumen general del local</div>
    <div class="section-block" id="drive-sync-block">${driveSyncBlockHTML()}</div>
    <div class="section-block" id="drive-reports-block">${driveReportsBlockHTML()}</div>
    <div class="stat-grid">
      ${statCard("Máquinas", state.machines.length, "package", "var(--ink)")}
      ${statCard("Disponibles", totalDisponibles, "check", "var(--green)")}
      ${statCard("Alquileres activos", act.length, "list", "var(--yellow-dark)")}
      ${statCard("Atrasados", overdue.length, "alert", "var(--red)")}
    </div>`;

  if (overdue.length > 0) {
    html += `<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--red);display:flex;align-items:center;gap:6px">${icon("alert", "icon-inline")} Devoluciones atrasadas</div>`;
    html += renderRentalGroups(overdue);
    html += `<div style="height:8px"></div>`;
  }

  html += `
    <div class="action-row">
      <button class="btn btn-primary" data-go="nuevo">${icon("plus")} Nuevo alquiler</button>
      <button class="btn btn-secondary" data-go="maquinas">${icon("package")} Ver máquinas</button>
    </div>
    <div class="action-row">
      <button class="btn btn-secondary" id="btn-reporte-alquileres">${icon("file")} Reporte alquileres</button>
      <button class="btn btn-secondary" id="btn-reporte-stock">${icon("file")} Reporte stock</button>
    </div>`;

  if (act.length > 0) {
    html += `<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--sub)">Alquileres activos (${act.length})</div>`;
    html += renderRentalGroups(act.slice(0, 8));
  }

  if (state.machines.length === 0) {
    html += emptyState("package", "Todavía no cargaste ninguna máquina. Andá a la pestaña Máquinas para empezar.");
  }
  return html;
}

function statCard(label, value, iconName, color) {
  return `
    <div class="stat-card">
      <div class="stat-card-top">
        <div class="stat-value tag-font">${value}</div>
        <div class="stat-icon" style="color:${color}">${icon(iconName)}</div>
      </div>
      <div class="stat-label">${label}</div>
    </div>`;
}

function emptyState(iconName, text) {
  return `<div class="empty-state">${icon(iconName)}<div class="txt">${esc(text)}</div></div>`;
}

/* ===================== VISTA: MAQUINAS ===================== */
function viewMaquinas() {
  const act = activeRentals();
  let html = `
    <div style="display:flex;justify-content:space-between;align-items:flex-end">
      <div>
        <div class="section-title tag-font">Inventario</div>
        <div class="section-sub">${state.machines.length} tipos de herramienta cargados</div>
      </div>
      <button class="btn" style="background:var(--ink);color:#fff;padding:8px 12px;font-size:12.5px;margin-bottom:14px" data-add-machine>${icon("plus")} Agregar</button>
    </div>`;

  if (state.machines.length === 0) html += emptyState("package", "No hay máquinas cargadas todavía.");

  state.machines.forEach((m) => {
    const alquiladas = act.filter((r) => r.machineId === m.id).length;
    const disponibles = m.totalQty - alquiladas;
    const badgeClass = disponibles <= 0 ? "badge-red" : disponibles < m.totalQty ? "badge-orange" : "badge-green";
    const badgeText = disponibles <= 0 ? "SIN STOCK" : `${disponibles}/${m.totalQty} libres`;
    html += `
      <div class="card" style="cursor:default">
        <div class="card-top">
          <div>
            <div class="card-name">${esc(m.name)}</div>
            <div class="card-sub">${esc(m.code)} · ${esc(m.category)}</div>
          </div>
          <div class="badge ${badgeClass}">${badgeText}</div>
        </div>
        <div class="price-row">
          <div><div class="price-label">Día</div><div class="price-value">${fmtMoney(m.priceDay)}</div></div>
          <div><div class="price-label">Semana</div><div class="price-value">${fmtMoney(m.priceWeek)}</div></div>
          <div><div class="price-label">Quincena</div><div class="price-value">${fmtMoney(m.priceQuincena)}</div></div>
          <div><div class="price-label">Mes</div><div class="price-value">${fmtMoney(m.priceMonth)}</div></div>
        </div>
        <div class="card-actions">
          <button class="btn-mini" data-edit-machine="${m.id}">${icon("edit")} Editar</button>
          <button class="btn-danger" data-delete-machine="${m.id}">${icon("trash")}</button>
        </div>
      </div>`;
  });
  return html;
}

/* ===================== VISTA: NUEVO ALQUILER ===================== */
function viewNuevo() {
  const f = state.nuevoAlquiler;
  const clientesExistentes = getClientsFromRentals().sort((a, b) => (a.name || "").localeCompare(b.name || "", "es"));

  // Recalcular precio unitario de cada renglón según su propia máquina y período
  f.items.forEach((it) => {
    const m = state.machines.find((x) => x.id === it.machineId);
    it.unitPrice = m ? priceForPeriod(m, it.periodType) : 0;
  });

  const calcTotal = f.items.reduce((sum, it) => sum + (Number(it.unitPrice) || 0) * (Number(it.periodCount) || 0), 0);
  const discountPct = Math.min(100, Math.max(0, Number(f.discount) || 0));
  const discountAmount = calcTotal * (discountPct / 100);
  const total = Math.max(0, calcTotal - discountAmount);

  let html = `
    <div class="section-title tag-font">Nuevo alquiler</div>
    <div class="section-sub">Cargá los datos del cliente y las máquinas</div>

    <div class="section-block">
      <div class="block-title">${icon("package")} Máquinas a alquilar</div>
      <div class="field"><label>Fecha de inicio (para todas las máquinas)</label><input type="date" id="f-startDate" value="${f.startDate}"></div>
      ${f.items.map((it, idx) => itemCardHTML(it, idx, f)).join("")}
      <button type="button" class="btn-mini" id="btn-add-item">${icon("plus")} Agregar otra máquina</button>
      ${state.machines.length === 0 ? `<div class="hint" style="margin-top:8px">Todavía no cargaste ninguna máquina.</div>` : ""}
    </div>

    <div class="section-block">
      <div class="block-title">${icon("id")} Datos del cliente</div>
      ${clientesExistentes.length > 0 ? `
      <div class="field">
        <label>Cliente existente (opcional)</label>
        <select id="f-pick-client">
          <option value="">+ Nuevo cliente</option>
          ${clientesExistentes.map((c) => `<option value="${esc(c.key)}">${esc(c.name || "(sin nombre)")}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("")}
        </select>
      </div>` : ""}
      <div class="field"><label>Nombre y apellido</label><input type="text" id="f-clientName" value="${esc(f.clientName)}" placeholder="Juan Pérez"></div>
      <div class="field-row">
        <div class="field"><label>Teléfono</label><input type="tel" id="f-clientPhone" value="${esc(f.clientPhone)}" placeholder="011-5555-5555"></div>
        <div class="field"><label>DNI</label><input type="text" id="f-clientDni" value="${esc(f.clientDni)}" placeholder="30111222"></div>
      </div>
    </div>

    <div class="section-block">
      <div class="block-title">${icon("wrench")} Precio</div>
      <div class="calc-line" id="calc-line">Subtotal: <b>${fmtMoney(calcTotal)}</b></div>
      <div class="field"><label>Descuento (%)</label><input type="number" min="0" max="100" id="f-discount" value="${f.discount || 0}" placeholder="0"></div>
      <div class="field">
        <label>Total a cobrar</label>
        <input type="number" id="f-total" value="${total}" disabled style="font-weight:700">
      </div>
      <div class="hint" style="margin-top:-4px">El total se calcula solo: suma de cada máquina × sus propios períodos, menos el % de descuento que cargues.</div>
    </div>

    <div class="section-block">
      <div class="block-title">${icon("camera")} Fotos</div>
      <div class="photo-row">
        ${photoBox("dni", "DNI", "id", f.dniPhoto)}
        ${photoBox("comp", "Comprobante", "receipt", f.comprobantePhoto)}
      </div>
      <input type="file" accept="image/*" id="input-photo-dni" style="display:none">
      <input type="file" accept="image/*" id="input-photo-comp" style="display:none">
    </div>

    <div class="field"><label>Observaciones</label><textarea id="f-notes" rows="2" placeholder="Depósito, accesorios entregados, etc.">${esc(f.notes)}</textarea></div>

    <div id="presupuesto-container">${f.showPresupuesto ? presupuestoHTML(f, total) : ""}</div>

    <div class="action-row" style="margin-top:6px">
      <button class="btn btn-secondary" id="btn-presupuesto">${icon("file")} Presupuesto</button>
      <button class="btn btn-primary" id="btn-confirmar">Confirmar alquiler</button>
    </div>
  `;
  return html;
}

// Tarjeta de un renglón: máquina + su propio período + su subtotal
function itemCardHTML(it, idx, f) {
  const opciones = state.machines.filter((m) => remainingStock(m, f.items, it.id) > 0);
  return `
    <div class="section-block" style="background:var(--bg);border:1px dashed var(--border);margin-bottom:10px;padding:11px">
      <div class="field-row" style="align-items:center">
        <div class="field" style="flex:1;margin-bottom:10px">
          <label>Máquina ${idx + 1}</label>
          <select data-item-machine="${it.id}">
            <option value="">Seleccioná una máquina...</option>
            ${opciones.map((m) => `<option value="${m.id}" ${m.id === it.machineId ? "selected" : ""}>${esc(m.name)} (${esc(m.code)})</option>`).join("")}
          </select>
        </div>
        ${f.items.length > 1 ? `<button type="button" class="btn-danger" data-remove-item="${it.id}" style="margin-bottom:10px">${icon("trash")}</button>` : ""}
      </div>
      <div class="pill-row" data-item-pillrow="${it.id}">
        ${PERIOD_TYPES.map((p) => `<button type="button" class="pill ${it.periodType === p ? "active" : ""}" data-item-period="${it.id}" data-value="${p}">${p}</button>`).join("")}
      </div>
      <div class="field"><label>Cantidad de ${it.periodType.toLowerCase()}s</label><input type="number" min="1" data-item-count="${it.id}" value="${it.periodCount}"></div>
      <div id="item-price-${it.id}">${itemPriceLineHTML(it, f)}</div>
    </div>`;
}

// Renglón "precio por período × cantidad = subtotal (devolución estimada)"
function itemPriceLineHTML(it, f) {
  const m = state.machines.find((x) => x.id === it.machineId);
  if (!m) return "";
  const lineTotal = (Number(it.unitPrice) || 0) * (Number(it.periodCount) || 0);
  const dueDate = calcDueDate(f.startDate, it.periodType, it.periodCount);
  return `
    <div class="row-line"><span class="lab">${it.periodCount || 0} ${it.periodType.toLowerCase()}(s) &times; ${fmtMoney(it.unitPrice)}</span><span class="val"><b>${fmtMoney(lineTotal)}</b></span></div>
    <div class="hint" style="margin:0">Devolución estimada: ${fmtDate(dueDate)}</div>`;
}

function photoBox(key, label, iconName, photo) {
  return `
    <div class="photo-box ${photo ? "filled" : ""}" data-photo-pick="${key}">
      ${photo
      ? `<img src="${photo}"><button class="photo-clear" data-photo-clear="${key}">${icon("x")}</button>`
      : `${icon(iconName)}<div class="lbl">Subir ${label}</div>`}
    </div>`;
}

function presupuestoHTML(f, total) {
  const discountPct = Math.min(100, Math.max(0, Number(f.discount) || 0));
  const validos = f.items.filter((it) => it.machineId);
  const itemsHtml = validos.map((it) => {
    const m = state.machines.find((x) => x.id === it.machineId);
    if (!m) return "";
    const lineTotal = (Number(it.unitPrice) || 0) * (Number(it.periodCount) || 0);
    const dueDate = calcDueDate(f.startDate, it.periodType, it.periodCount);
    return `<div class="row-line"><span class="lab">${esc(m.name)} — ${it.periodCount} ${it.periodType.toLowerCase()}(s) (${fmtMoney(it.unitPrice)}/${it.periodType.toLowerCase()})</span><span class="val">${fmtMoney(lineTotal)}</span></div>
      <div class="hint" style="margin:0 0 4px">Devuelve: ${fmtDate(dueDate)}</div>`;
  }).join("");
  return `
    <div class="presupuesto">
      <img src="icons/logo.png" alt="Logo" style="height:32px;display:block;margin:0 auto 10px">
      <div class="presupuesto-title tag-font">Presupuesto</div>
      <div class="presupuesto-date">Emitido el ${fmtDate(todayISO())}</div>
      <div class="row-line"><span class="lab">Cliente</span><span class="val">${esc(f.clientName) || "-"}</span></div>
      <div class="row-line"><span class="lab">Fecha de inicio</span><span class="val">${fmtDate(f.startDate)}</span></div>
      ${itemsHtml}
      ${discountPct ? `<div class="row-line"><span class="lab">Descuento</span><span class="val">${discountPct}%</span></div>` : ""}
      <div class="presupuesto-total"><span class="lab">Total</span><span class="val tag-font">${fmtMoney(total)}</span></div>
      <div class="presupuesto-foot">Presupuesto sin cargo. No implica reserva de la máquina hasta confirmar el alquiler.<br><b>Válido hasta el ${fmtDate(addDays(todayISO(), 7))}.</b> Pasada esa fecha hay que pedirlo de nuevo, ya que los precios pueden cambiar.</div>
      <button class="btn btn-primary btn-block" id="btn-presupuesto-pdf" style="margin-top:10px">${icon("share")} Compartir por WhatsApp (PDF)</button>
    </div>`;
}

/* ===================== VISTA: CLIENTES ===================== */
function viewClientes() {
  const clients = getClientsFromRentals().sort((a, b) => (a.name || "").localeCompare(b.name || "", "es"));
  let html = `
    <div class="section-title tag-font">Clientes</div>
    <div class="section-sub">${clients.length} cliente(s) con alquileres registrados</div>`;

  if (clients.length === 0) {
    html += emptyState("users", "Todavía no hay clientes. Van a aparecer solos a medida que cargues alquileres.");
    return html;
  }

  clients.forEach((c) => {
    const totalFacturado = c.rentals.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const activos = c.rentals.filter((r) => r.status === "Activo").length;
    html += `
      <div class="card" data-open-client="${esc(c.key)}">
        <div class="card-top">
          <div>
            <div class="card-name">${esc(c.name || "(sin nombre)")}</div>
            <div class="card-sub">${c.phone ? esc(c.phone) : "sin teléfono"}${c.dni ? " · DNI " + esc(c.dni) : ""}</div>
          </div>
          <div class="badge ${activos > 0 ? "badge-yellow" : "badge-green"}">${c.rentals.length} alquiler${c.rentals.length === 1 ? "" : "es"}</div>
        </div>
        <div class="card-bottom">
          <span>${activos > 0 ? activos + " activo(s)" : "sin alquileres activos"}</span>
          <span class="amount">${fmtMoney(totalFacturado)}</span>
        </div>
      </div>`;
  });
  return html;
}

function clientDetailModal() {
  const clients = getClientsFromRentals();
  const c = clients.find((x) => x.key === state.viewingClientKey);
  if (!c) return "";
  const totalFacturado = c.rentals.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const rentalsOrdenados = [...c.rentals].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title tag-font">${esc(c.name || "Cliente")}</div>
          <button class="modal-close" id="close-modal">${icon("x")}</button>
        </div>
        ${c.phone ? `<div class="row-line"><span class="lab">Teléfono</span><span class="val">${esc(c.phone)}</span></div>` : ""}
        ${c.dni ? `<div class="row-line"><span class="lab">DNI</span><span class="val">${esc(c.dni)}</span></div>` : ""}
        <div class="row-line"><span class="lab">Alquileres totales</span><span class="val">${c.rentals.length}</span></div>
        <div class="presupuesto-total"><span class="lab">Total facturado histórico</span><span class="val tag-font">${fmtMoney(totalFacturado)}</span></div>
        <div style="border-top:1px solid var(--border);margin:12px 0 8px"></div>
        <div style="font-size:12px;font-weight:600;color:var(--sub);margin-bottom:8px">Historial de alquileres</div>
        ${renderRentalGroups(rentalsOrdenados)}
      </div>
    </div>`;
}

function bindClientDetail() {
  document.getElementById("overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeModals(); });
  document.getElementById("close-modal").addEventListener("click", closeModals);
  document.querySelectorAll("[data-open-rental]").forEach((b) => b.addEventListener("click", () => {
    state.viewingClientKey = null;
    state.viewingRentalId = b.dataset.openRental;
    renewingOpen = false;
    renderModals();
  }));
}

/* ===================== VISTA: ALQUILERES ===================== */
let alquileresFilter = "Activo";
function viewAlquileres() {
  const filtered = state.rentals
      .filter((r) => alquileresFilter === "Todos" ? true : r.status === alquileresFilter)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  let html = `
    <div class="section-title tag-font">Alquileres</div>
    <div class="section-sub">${state.rentals.length} alquileres registrados en total</div>
    <div class="filter-row">
      ${["Activo", "Devuelto", "Todos"].map((f) => `<button class="pill ${alquileresFilter === f ? "active" : ""}" data-filter="${f}">${f}</button>`).join("")}
    </div>`;

  if (filtered.length === 0) html += emptyState("list", "No hay alquileres para mostrar acá.");
  html += renderRentalGroups(filtered);
  return html;
}

function rentalCard(rental) {
  const isOverdue = rental.status === "Activo" && rental.dueDate < todayISO();
  const statusLabel = rental.status === "Devuelto" ? "Devuelto" : isOverdue ? "Atrasado" : "Activo";
  const badgeClass = rental.status === "Devuelto" ? "badge-green" : isOverdue ? "badge-red" : "badge-yellow";
  return `
    <div class="card" data-open-rental="${rental.id}">
      <div class="card-top">
        <div>
          <div class="card-name">${esc(rental.machineName)}</div>
          <div class="card-sub">${esc(rental.clientName)}</div>
        </div>
        <div class="badge ${badgeClass}">${statusLabel}</div>
      </div>
      <div class="card-bottom">
        <span>${icon("clock", "icon-inline")}Hasta ${fmtDate(rental.dueDate)}</span>
        <span class="amount">${fmtMoney(rental.total)}</span>
      </div>
    </div>`;
}

/* ===================== EVENTOS DEL CONTENIDO ===================== */
function bindContentEvents() {
  document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.go; render(); }));

  if (state.tab === "maquinas") {
    document.querySelector("[data-add-machine]")?.addEventListener("click", () => { state.editingMachine = null; state.showMachineForm = true; renderModals(); });
    document.querySelectorAll("[data-edit-machine]").forEach((b) => b.addEventListener("click", () => {
      state.editingMachine = state.machines.find((m) => m.id === b.dataset.editMachine);
      state.showMachineForm = true; renderModals();
    }));
    document.querySelectorAll("[data-delete-machine]").forEach((b) => b.addEventListener("click", () => {
      const m = state.machines.find((x) => x.id === b.dataset.deleteMachine);
      if (confirm(`¿Eliminar "${m.name}"?`)) {
        state.machines = state.machines.filter((x) => x.id !== m.id);
        saveMachines(state.machines);
        toast("Máquina eliminada");
        renderContent();
      }
    }));
  }

  if (state.tab === "nuevo") bindNuevoAlquiler();

  if (state.tab === "alquileres") {
    document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { alquileresFilter = b.dataset.filter; renderContent(); }));
    document.querySelectorAll("[data-open-rental]").forEach((b) => b.addEventListener("click", () => { state.viewingRentalId = b.dataset.openRental; renewingOpen = false; renderModals(); }));
  }

  if (state.tab === "inicio") {
    document.getElementById("btn-reporte-alquileres")?.addEventListener("click", generarReporteAlquileres);
    document.getElementById("btn-reporte-stock")?.addEventListener("click", generarReporteStock);
    document.querySelectorAll("[data-open-rental]").forEach((b) => b.addEventListener("click", () => { state.viewingRentalId = b.dataset.openRental; renewingOpen = false; renderModals(); }));
    bindDriveSyncButtons();
  }

  if (state.tab === "clientes") {
    document.querySelectorAll("[data-open-client]").forEach((el) => el.addEventListener("click", () => {
      state.viewingClientKey = el.dataset.openClient;
      renderModals();
    }));
  }
}

function bindNuevoAlquiler() {
  const f = state.nuevoAlquiler;

  document.getElementById("f-pick-client")?.addEventListener("change", (e) => {
    const key = e.target.value;
    if (!key) {
      f.clientName = ""; f.clientPhone = ""; f.clientDni = "";
    } else {
      const c = getClientsFromRentals().find((x) => x.key === key);
      if (c) { f.clientName = c.name || ""; f.clientPhone = c.phone || ""; f.clientDni = c.dni || ""; }
    }
    renderContent();
  });

  document.querySelectorAll("[data-item-machine]").forEach((sel) => sel.addEventListener("change", (e) => {
    const item = f.items.find((it) => it.id === sel.dataset.itemMachine);
    if (item) item.machineId = e.target.value;
    renderContent();
  }));

  document.getElementById("btn-add-item")?.addEventListener("click", () => {
    f.items.push({ id: uid(), machineId: "", periodType: "Día", periodCount: 1 });
    renderContent();
  });

  document.querySelectorAll("[data-remove-item]").forEach((btn) => btn.addEventListener("click", () => {
    f.items = f.items.filter((it) => it.id !== btn.dataset.removeItem);
    renderContent();
  }));

  document.querySelectorAll("[data-item-period]").forEach((b) => b.addEventListener("click", () => {
    const item = f.items.find((it) => it.id === b.dataset.itemPeriod);
    if (item) item.periodType = b.dataset.value;
    renderContent();
  }));

  document.querySelectorAll("[data-item-count]").forEach((inp) => inp.addEventListener("input", (e) => {
    const item = f.items.find((it) => it.id === inp.dataset.itemCount);
    if (item) item.periodCount = e.target.value;
    updatePrecioDisplay();
  }));

  document.getElementById("f-clientName").addEventListener("input", (e) => { f.clientName = e.target.value; });
  document.getElementById("f-clientPhone").addEventListener("input", (e) => { f.clientPhone = e.target.value; });
  document.getElementById("f-clientDni").addEventListener("input", (e) => { f.clientDni = e.target.value; });
  document.getElementById("f-startDate").addEventListener("input", (e) => { f.startDate = e.target.value; updatePrecioDisplay(); });
  document.getElementById("f-discount").addEventListener("input", (e) => { f.discount = e.target.value; updatePrecioDisplay(); });
  document.getElementById("f-notes").addEventListener("input", (e) => { f.notes = e.target.value; });

  document.querySelectorAll("[data-photo-pick]").forEach((box) => box.addEventListener("click", () => {
    const key = box.dataset.photoPick;
    if ((key === "dni" && f.dniPhoto) || (key === "comp" && f.comprobantePhoto)) return;
    document.getElementById(key === "dni" ? "input-photo-dni" : "input-photo-comp").click();
  }));
  document.querySelectorAll("[data-photo-clear]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const key = btn.dataset.photoClear;
    if (key === "dni") f.dniPhoto = null; else f.comprobantePhoto = null;
    renderContent();
  }));
  document.getElementById("input-photo-dni").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    toast("Procesando foto...");
    f.dniPhoto = await resizeImage(file);
    renderContent();
  });
  document.getElementById("input-photo-comp").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    toast("Procesando foto...");
    f.comprobantePhoto = await resizeImage(file);
    renderContent();
  });

  document.getElementById("btn-presupuesto").addEventListener("click", () => {
    const err = validateNuevo();
    if (err) { alert(err); return; }
    f.showPresupuesto = true;
    renderContent();
  });

  bindPresupuestoPdfButton();

  document.getElementById("btn-confirmar").addEventListener("click", async () => {
    const err = validateNuevo();
    if (err) { alert(err); return; }

    const validItems = f.items.filter((it) => it.machineId);
    const calcTotal = validItems.reduce((sum, it) => {
      const m = state.machines.find((x) => x.id === it.machineId);
      const unitPrice = m ? priceForPeriod(m, it.periodType) : 0;
      return sum + unitPrice * (Number(it.periodCount) || 0);
    }, 0);
    const discountPct = Math.min(100, Math.max(0, Number(f.discount) || 0));

    // Se crea un alquiler por cada máquina (cada una con su propio período y
    // fecha de devolución), repartiendo el descuento en proporción a lo que
    // pesa cada máquina en el total, así el stock sigue contándose por máquina.
    // Comparten "groupId" para que la lista de Alquileres los muestre juntos.
    const groupId = uid();
    let discountAsignado = 0;
    const nuevosRentals = [];
    for (let i = 0; i < validItems.length; i++) {
      const it = validItems[i];
      const machine = state.machines.find((m) => m.id === it.machineId);
      const unitPrice = priceForPeriod(machine, it.periodType);
      const lineTotal = unitPrice * (Number(it.periodCount) || 0);
      const dueDate = calcDueDate(f.startDate, it.periodType, it.periodCount);
      const lineDiscountAmount = calcTotal > 0 ? lineTotal * (discountPct / 100) : 0;
      let itemDiscountAmount;
      if (i === validItems.length - 1) {
        itemDiscountAmount = calcTotal * (discountPct / 100) - discountAsignado;
      } else {
        itemDiscountAmount = Math.round(lineDiscountAmount);
        discountAsignado += itemDiscountAmount;
      }
      const total = Math.max(0, Math.round(lineTotal - itemDiscountAmount));
      nuevosRentals.push({
        id: uid(), groupId,
        machineId: machine.id, machineName: machine.name, machineCode: machine.code,
        clientName: f.clientName.trim(), clientPhone: f.clientPhone.trim(), clientDni: f.clientDni.trim(),
        periodType: it.periodType, periodCount: Number(it.periodCount), unitPrice,
        discountPct, discount: Math.round(itemDiscountAmount), total,
        startDate: f.startDate, dueDate, status: "Activo", notes: f.notes.trim(),
        hasDniPhoto: !!f.dniPhoto, hasComprobantePhoto: !!f.comprobantePhoto,
        createdAt: new Date().toISOString(),
      });
    }

    state.rentals.push(...nuevosRentals);
    saveRentals(state.rentals);
    for (const rental of nuevosRentals) {
      if (f.dniPhoto) await savePhoto("dni-" + rental.id, f.dniPhoto);
      if (f.comprobantePhoto) await savePhoto("comp-" + rental.id, f.comprobantePhoto);
    }
    toast(nuevosRentals.length > 1 ? "Alquileres confirmados" : "Alquiler confirmado");
    state.nuevoAlquiler = freshRentalForm();
    state.tab = "alquileres";
    render();
  });
}

function bindPresupuestoPdfButton() {
  const f = state.nuevoAlquiler;
  document.getElementById("btn-presupuesto-pdf")?.addEventListener("click", async () => {
    const calcTotal = f.items.reduce((sum, it) => sum + (Number(it.unitPrice) || 0) * (Number(it.periodCount) || 0), 0);
    const discountPct = Math.min(100, Math.max(0, Number(f.discount) || 0));
    const discountAmount = calcTotal * (discountPct / 100);
    const total = Math.max(0, calcTotal - discountAmount);
    await generarPresupuestoPDF(f, total, discountPct, calcTotal);
  });
}

// Actualiza los números derivados (renglones de precio, total, presupuesto)
// sin volver a dibujar todo el formulario, para no perder el foco mientras se escribe.
function updatePrecioDisplay() {
  const f = state.nuevoAlquiler;
  f.items.forEach((it) => {
    const m = state.machines.find((x) => x.id === it.machineId);
    it.unitPrice = m ? priceForPeriod(m, it.periodType) : 0;
  });
  const calcTotal = f.items.reduce((sum, it) => sum + (Number(it.unitPrice) || 0) * (Number(it.periodCount) || 0), 0);
  const discountPct = Math.min(100, Math.max(0, Number(f.discount) || 0));
  const discountAmount = calcTotal * (discountPct / 100);
  const total = Math.max(0, calcTotal - discountAmount);

  f.items.filter((it) => it.machineId).forEach((it) => {
    const lineEl = document.getElementById("item-price-" + it.id);
    if (lineEl) lineEl.innerHTML = itemPriceLineHTML(it, f);
  });

  const calcLineEl = document.getElementById("calc-line");
  if (calcLineEl) calcLineEl.innerHTML = `Subtotal: <b>${fmtMoney(calcTotal)}</b>`;

  const totalEl = document.getElementById("f-total");
  if (totalEl) totalEl.value = total;

  const presupuestoCont = document.getElementById("presupuesto-container");
  if (presupuestoCont) {
    presupuestoCont.innerHTML = f.showPresupuesto ? presupuestoHTML(f, total) : "";
    bindPresupuestoPdfButton();
  }
}

function validateNuevo() {
  const f = state.nuevoAlquiler;
  if (!f.items.some((it) => it.machineId)) return "Elegí al menos una máquina";
  if (!f.clientName.trim()) return "Ingresá el nombre del cliente";
  if (f.items.some((it) => it.machineId && (!it.periodCount || Number(it.periodCount) <= 0))) {
    return "Ingresá una cantidad de períodos válida para cada máquina";
  }
  return null;
}

/* ===================== MODALES ===================== */
function renderModals() {
  const root = document.getElementById("modal-root");
  if (state.showMachineForm) { root.innerHTML = machineFormModal(state.editingMachine); bindMachineForm(); return; }
  if (state.viewingRentalId) { root.innerHTML = rentalDetailModal(); bindRentalDetail(); return; }
  if (state.viewingClientKey) { root.innerHTML = clientDetailModal(); bindClientDetail(); return; }
  root.innerHTML = "";
}

function machineFormModal(machine) {
  const m = machine || { code: "", name: "", category: CATEGORIES[0], totalQty: 1, priceDay: "", priceWeek: "", priceQuincena: "", priceMonth: "", notes: "" };
  return `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title tag-font">${machine ? "Editar máquina" : "Nueva máquina"}</div>
          <button class="modal-close" id="close-modal">${icon("x")}</button>
        </div>
        <div class="field"><label>Código</label><input type="text" id="m-code" value="${esc(m.code)}" placeholder="H-001"></div>
        <div class="field"><label>Nombre</label><input type="text" id="m-name" value="${esc(m.name)}" placeholder='Amoladora angular 4 1/2"'></div>
        <div class="field"><label>Categoría</label>
          <select id="m-category">${CATEGORIES.map((c) => `<option value="${c}" ${c === m.category ? "selected" : ""}>${c}</option>`).join("")}</select>
        </div>
        <div class="field"><label>Cantidad total en stock</label><input type="number" min="1" id="m-qty" value="${m.totalQty}"></div>
        <div class="field-row">
          <div class="field"><label>Precio/día</label><input type="number" id="m-priceDay" value="${m.priceDay}"></div>
          <div class="field"><label>Precio/semana</label><input type="number" id="m-priceWeek" value="${m.priceWeek}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Precio/quincena</label><input type="number" id="m-priceQuincena" value="${m.priceQuincena}"></div>
          <div class="field"><label>Precio/mes</label><input type="number" id="m-priceMonth" value="${m.priceMonth}"></div>
        </div>
        <div class="field"><label>Observaciones</label><textarea id="m-notes" rows="2">${esc(m.notes)}</textarea></div>
        <button class="btn btn-primary btn-block" id="save-machine">Guardar máquina</button>
      </div>
    </div>`;
}

function bindMachineForm() {
  document.getElementById("overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeModals(); });
  document.getElementById("close-modal").addEventListener("click", closeModals);
  document.getElementById("save-machine").addEventListener("click", () => {
    const name = document.getElementById("m-name").value.trim();
    if (!name) { alert("Ponele un nombre a la máquina"); return; }
    const data = {
      id: state.editingMachine ? state.editingMachine.id : uid(),
      code: document.getElementById("m-code").value.trim(),
      name,
      category: document.getElementById("m-category").value,
      totalQty: Number(document.getElementById("m-qty").value) || 1,
      priceDay: Number(document.getElementById("m-priceDay").value) || 0,
      priceWeek: Number(document.getElementById("m-priceWeek").value) || 0,
      priceQuincena: Number(document.getElementById("m-priceQuincena").value) || 0,
      priceMonth: Number(document.getElementById("m-priceMonth").value) || 0,
      notes: document.getElementById("m-notes").value.trim(),
    };
    if (state.editingMachine) {
      state.machines = state.machines.map((m) => (m.id === data.id ? data : m));
    } else {
      state.machines.push(data);
    }
    saveMachines(state.machines);
    toast(state.editingMachine ? "Máquina actualizada" : "Máquina agregada");
    closeModals();
    renderContent();
  });
}

let renewingOpen = false;
let renewPeriodType = "Día";
let renewCount = 1;

function rentalDetailModal() {
  const rental = state.rentals.find((r) => r.id === state.viewingRentalId);
  if (!rental) return "";
  const isOverdue = rental.status === "Activo" && rental.dueDate < todayISO();
  const machine = state.machines.find((m) => m.id === rental.machineId);
  const renewExtra = machine ? priceForPeriod(machine, renewPeriodType) * (Number(renewCount) || 0) : 0;
  const renewNewDueDate = calcDueDate(rental.dueDate, renewPeriodType, renewCount);
  return `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title tag-font">Detalle del alquiler</div>
          <button class="modal-close" id="close-modal">${icon("x")}</button>
        </div>
        <div class="row-line"><span class="lab">Máquina</span><span class="val">${esc(rental.machineName)} (${esc(rental.machineCode)})</span></div>
        <div class="row-line"><span class="lab">Cliente</span><span class="val">${esc(rental.clientName)}</span></div>
        ${rental.clientPhone ? `<div class="row-line"><span class="lab">Teléfono</span><span class="val">${esc(rental.clientPhone)}</span></div>` : ""}
        ${rental.clientDni ? `<div class="row-line"><span class="lab">DNI</span><span class="val">${esc(rental.clientDni)}</span></div>` : ""}
        <div class="row-line"><span class="lab">Período contratado</span><span class="val">${rental.periodCount} ${rental.periodType.toLowerCase()}(s)</span></div>
        <div class="row-line"><span class="lab">Desde</span><span class="val">${fmtDate(rental.startDate)}</span></div>
        <div class="row-line"><span class="lab">Hasta (devolución)</span><span class="val">${fmtDate(rental.dueDate)}</span></div>
        <div class="row-line"><span class="lab">Estado</span><span class="val">${rental.status === "Devuelto" ? "Devuelto" : isOverdue ? "Atrasado" : "Activo"}</span></div>
        ${rental.notes ? `<div class="row-line"><span class="lab">Notas</span><span class="val">${esc(rental.notes)}</span></div>` : ""}
        ${rental.renewals && rental.renewals.length ? `<div class="row-line"><span class="lab">Renovaciones</span><span class="val">${rental.renewals.length}</span></div>` : ""}
        <div class="presupuesto-total"><span class="lab">Total</span><span class="val tag-font">${fmtMoney(rental.total)}</span></div>
        <div class="detail-photos" id="detail-photos"></div>

        ${rental.status === "Activo" && renewingOpen ? `
          <div class="section-block" style="margin-top:14px">
            <div class="block-title">${icon("clock")} Renovar alquiler</div>
            <div class="pill-row">
              ${PERIOD_TYPES.map((p) => `<button class="pill ${renewPeriodType === p ? "active" : ""}" data-renew-period="${p}">${p}</button>`).join("")}
            </div>
            <div class="field"><label>Cantidad de ${renewPeriodType.toLowerCase()}s a sumar</label><input type="number" min="1" id="renew-count" value="${renewCount}"></div>
            <div class="row-line"><span class="lab">Nueva fecha de devolución</span><span class="val">${fmtDate(renewNewDueDate)}</span></div>
            <div class="row-line"><span class="lab">Costo adicional</span><span class="val">${fmtMoney(renewExtra)}</span></div>
            <div class="action-row" style="margin-top:8px">
              <button class="btn btn-secondary" id="btn-cancel-renew">Cancelar</button>
              <button class="btn btn-primary" id="btn-confirm-renew">Confirmar renovación</button>
            </div>
          </div>` : ""}

        <div class="action-row" style="margin-top:16px">
          ${rental.status === "Activo" && !renewingOpen ? `<button class="btn btn-secondary" id="btn-open-renew">${icon("clock")} Renovar</button>` : ""}
          ${rental.status === "Activo" && !renewingOpen ? `<button class="btn btn-primary" id="btn-return">${icon("check")} Marcar devuelto</button>` : ""}
        </div>
      </div>
    </div>`;
}

async function bindRentalDetail() {
  const rental = state.rentals.find((r) => r.id === state.viewingRentalId);
  document.getElementById("overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeModals(); });
  document.getElementById("close-modal").addEventListener("click", closeModals);

  const photosDiv = document.getElementById("detail-photos");
  if (rental.hasDniPhoto || rental.hasComprobantePhoto) {
    const dni = rental.hasDniPhoto ? await getPhoto("dni-" + rental.id) : null;
    const comp = rental.hasComprobantePhoto ? await getPhoto("comp-" + rental.id) : null;
    photosDiv.innerHTML = `
      ${dni ? `<div class="detail-photo"><div class="lbl">DNI</div><img src="${dni}"></div>` : ""}
      ${comp ? `<div class="detail-photo"><div class="lbl">Comprobante</div><img src="${comp}"></div>` : ""}
    `;
  }

  document.getElementById("btn-return")?.addEventListener("click", () => {
    state.rentals = state.rentals.map((r) => (r.id === rental.id ? { ...r, status: "Devuelto", returnedDate: todayISO() } : r));
    saveRentals(state.rentals);
    toast("Marcado como devuelto");
    closeModals();
    renderContent();
  });

  document.getElementById("btn-open-renew")?.addEventListener("click", () => {
    renewingOpen = true;
    renewPeriodType = rental.periodType;
    renewCount = 1;
    refreshRentalModal();
  });
  document.getElementById("btn-cancel-renew")?.addEventListener("click", () => {
    renewingOpen = false;
    refreshRentalModal();
  });
  document.querySelectorAll("[data-renew-period]").forEach((b) => b.addEventListener("click", () => {
    renewPeriodType = b.dataset.renewPeriod;
    refreshRentalModal();
  }));
  document.getElementById("renew-count")?.addEventListener("input", (e) => {
    renewCount = e.target.value;
    refreshRentalModal();
  });
  document.getElementById("btn-confirm-renew")?.addEventListener("click", () => {
    const machine = state.machines.find((m) => m.id === rental.machineId);
    const extra = machine ? priceForPeriod(machine, renewPeriodType) * (Number(renewCount) || 0) : 0;
    const newDueDate = calcDueDate(rental.dueDate, renewPeriodType, renewCount);
    const previousDueDate = rental.dueDate;
    state.rentals = state.rentals.map((r) => {
      if (r.id !== rental.id) return r;
      const renewals = r.renewals ? [...r.renewals] : [];
      renewals.push({ date: todayISO(), periodType: renewPeriodType, count: Number(renewCount) || 0, cost: extra, previousDueDate, newDueDate });
      return { ...r, dueDate: newDueDate, total: (Number(r.total) || 0) + extra, renewals };
    });
    saveRentals(state.rentals);
    renewingOpen = false;
    toast("Alquiler renovado");
    renderModals();
    renderContent();
  });

}

function refreshRentalModal() {
  const root = document.getElementById("modal-root");
  root.innerHTML = rentalDetailModal();
  bindRentalDetail();
}

function closeModals() {
  state.showMachineForm = false;
  state.editingMachine = null;
  state.viewingRentalId = null;
  state.viewingClientKey = null;
  renderModals();
}

/* ===================== PRESUPUESTO (PDF) ===================== */
// Carga icons/logo.png como data URL una sola vez y lo reutiliza (para incrustarlo en el PDF)
let logoDataUrlCache = null;
async function getLogoDataUrl() {
  if (logoDataUrlCache) return logoDataUrlCache;
  try {
    const resp = await fetch("icons/logo.png");
    const blob = await resp.blob();
    logoDataUrlCache = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error("No se pudo cargar el logo para el PDF:", e);
    logoDataUrlCache = null;
  }
  return logoDataUrlCache;
}

async function generarPresupuestoPDF(f, total, discountPct, calcTotal) {
  try {
    if (typeof window.jspdf === "undefined") {
      alert("No se pudo cargar el generador de PDF (necesita internet la primera vez). Conectate a internet y volvé a tocar el botón.");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a5" });
    const pageW = doc.internal.pageSize.getWidth();
    let y = 14;

    const logo = await getLogoDataUrl();
    if (logo) {
      const logoW = 42;
      const logoH = logoW / 2.913; // relación de aspecto real del logo (268x92)
      doc.addImage(logo, "PNG", (pageW - logoW) / 2, y, logoW, logoH);
      y += logoH + 8;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("PRESUPUESTO", pageW / 2, y, { align: "center" });
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`Emitido el ${fmtDate(todayISO())}`, pageW / 2, y, { align: "center" });
    doc.setTextColor(20);
    y += 10;

    const line = (label, value, bold) => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.setTextColor(110);
      doc.text(label, 14, y);
      doc.setTextColor(20);
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.text(String(value), pageW - 14, y, { align: "right" });
      y += 7;
    };

    line("Cliente", f.clientName || "-");
    if (f.clientPhone) line("Teléfono", f.clientPhone);
    line("Fecha de inicio", fmtDate(f.startDate));

    y += 2;
    doc.setDrawColor(225);
    doc.line(14, y, pageW - 14, y);
    y += 7;

    f.items.filter((it) => it.machineId).forEach((it) => {
      const m = state.machines.find((x) => x.id === it.machineId);
      if (!m) return;
      const lineTotal = (Number(it.unitPrice) || 0) * (Number(it.periodCount) || 0);
      const dueDate = calcDueDate(f.startDate, it.periodType, it.periodCount);
      line(m.name, fmtMoney(lineTotal));
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(130);
      doc.text(`${it.periodCount} ${it.periodType.toLowerCase()}(s) x ${fmtMoney(it.unitPrice)} - devuelve ${fmtDate(dueDate)}`, 14, y - 4);
      doc.setTextColor(20);
      y += 2;
    });

    y += 2;
    doc.setDrawColor(210);
    doc.line(14, y, pageW - 14, y);
    y += 9;

    if (discountPct) {
      line("Subtotal", fmtMoney(calcTotal));
      line("Descuento", `${discountPct}%`);
      y += 2;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Total", 14, y);
    doc.setFontSize(16);
    doc.text(fmtMoney(total), pageW - 14, y, { align: "right" });
    y += 12;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(130);
    doc.text("Presupuesto sin cargo. No implica reserva de la máquina hasta confirmar el alquiler.", 14, y, { maxWidth: pageW - 28 });
    y += 8;
    doc.setFont("helvetica", "bold");
    doc.setTextColor(90);
    doc.text(`Válido hasta el ${fmtDate(addDays(todayISO(), 7))}.`, 14, y, { maxWidth: pageW - 28 });
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.text("Pasada esa fecha hay que pedirlo de nuevo, ya que los precios pueden cambiar.", 14, y, { maxWidth: pageW - 28 });

    const filename = `Presupuesto_${(f.clientName || "cliente").trim().replace(/\s+/g, "_") || "cliente"}_${todayISO()}.pdf`;
    const blob = doc.output("blob");
    compartirArchivo(blob, filename, "application/pdf", "PDF");
  } catch (err) {
    console.error("Error generando el presupuesto en PDF:", err);
    alert("Hubo un problema generando el PDF: " + (err && err.message ? err.message : err));
  }
}

async function compartirArchivo(blob, filename, mimeType, label) {
  try {
    const file = new File([blob], filename, { type: mimeType });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (err) {
    if (err && err.name === "AbortError") return; // el usuario cerró el selector de compartir
    console.error("No se pudo abrir el selector de compartir, se ofrece descarga:", err);
  }
  presentReport(blob, filename, label);
}

/* ===================== REPORTES (EXCEL) ===================== */
function getWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0=domingo .. 6=sábado
  const diff = (day === 0 ? -6 : 1) - day; // retrocede hasta el lunes
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

async function construirBlobReporteAlquileres() {
  if (typeof ExcelJS === "undefined") throw new Error("No se pudo cargar el generador de Excel (necesita internet la primera vez).");
  if (state.rentals.length === 0) throw new Error("SIN_DATOS_ALQUILERES");

  // --- Agrupar por semana (lunes a domingo) según fecha de carga ---
  const weekMap = {};
  state.rentals.forEach((r) => {
    const d = (r.createdAt || "").split("T")[0] || todayISO();
    const weekStart = getWeekStart(d);
    if (!weekMap[weekStart]) weekMap[weekStart] = { count: 0, total: 0 };
    weekMap[weekStart].count += 1;
    weekMap[weekStart].total += Number(r.total) || 0;
  });
  const weekKeys = Object.keys(weekMap).sort();
  const totalGeneral = state.rentals.reduce((s, r) => s + (Number(r.total) || 0), 0);

  const wb = new ExcelJS.Workbook();

  // --- Hoja 1: resumen semanal ---
  const wsResumen = wb.addWorksheet("Ganado por semana");
  wsResumen.columns = [
    { header: "Semana", key: "semana", width: 26 },
    { header: "Cantidad de alquileres", key: "cant", width: 20 },
    { header: "Monto ganado", key: "monto", width: 16 },
  ];
  wsResumen.getRow(1).font = { bold: true };
  weekKeys.forEach((wk) => {
    const info = weekMap[wk];
    wsResumen.addRow({ semana: `${fmtDate(wk)} al ${fmtDate(addDays(wk, 6))}`, cant: info.count, monto: info.total });
  });
  wsResumen.addRow({});
  wsResumen.addRow({ semana: "TOTAL GENERAL", cant: state.rentals.length, monto: totalGeneral });

  // --- Hoja 2: detalle de cada alquiler, con descuento, observaciones y fotos ---
  const wsDetalle = wb.addWorksheet("Detalle alquileres");
  wsDetalle.columns = [
    { header: "Fecha carga", key: "fecha", width: 12 },
    { header: "Máquina", key: "maquina", width: 24 },
    { header: "Código", key: "codigo", width: 10 },
    { header: "Cliente", key: "cliente", width: 20 },
    { header: "Teléfono", key: "telefono", width: 15 },
    { header: "Período", key: "periodo", width: 10 },
    { header: "Cant. períodos", key: "cant", width: 12 },
    { header: "Precio unitario", key: "precio", width: 13 },
    { header: "Descuento %", key: "descuentoPct", width: 11 },
    { header: "Descuento $", key: "descuento", width: 12 },
    { header: "Total", key: "total", width: 12 },
    { header: "Estado", key: "estado", width: 10 },
    { header: "Fecha devolución", key: "devolucion", width: 14 },
    { header: "Observaciones", key: "obs", width: 32 },
    { header: "Foto DNI", key: "fotoDni", width: 14 },
    { header: "Foto comprobante", key: "fotoComp", width: 14 },
  ];
  wsDetalle.getRow(1).font = { bold: true };

  const rentalsOrdenados = [...state.rentals].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

  for (let i = 0; i < rentalsOrdenados.length; i++) {
    const r = rentalsOrdenados[i];
    const isOverdue = r.status === "Activo" && r.dueDate < todayISO();
    wsDetalle.addRow({
      fecha: fmtDate((r.createdAt || "").split("T")[0]),
      maquina: r.machineName, codigo: r.machineCode || "", cliente: r.clientName, telefono: r.clientPhone || "",
      periodo: r.periodType, cant: r.periodCount, precio: r.unitPrice, descuentoPct: r.discountPct || 0, descuento: r.discount || 0, total: r.total,
      estado: r.status === "Devuelto" ? "Devuelto" : isOverdue ? "Atrasado" : "Activo",
      devolucion: fmtDate(r.dueDate), obs: r.notes || "",
    });

    const excelRow = i + 2; // la fila 1 es el encabezado
    let hayFoto = false;

    if (r.hasDniPhoto) {
      try {
        const dataUrl = await getPhoto("dni-" + r.id);
        if (dataUrl) {
          const imgId = wb.addImage({ base64: dataUrl, extension: "jpeg" });
          wsDetalle.addImage(imgId, { tl: { col: 14, row: excelRow - 1 }, ext: { width: 55, height: 55 } });
          hayFoto = true;
        }
      } catch (e) { console.error("No se pudo incluir la foto de DNI del alquiler " + r.id + ":", e); }
    }
    if (r.hasComprobantePhoto) {
      try {
        const dataUrl = await getPhoto("comp-" + r.id);
        if (dataUrl) {
          const imgId = wb.addImage({ base64: dataUrl, extension: "jpeg" });
          wsDetalle.addImage(imgId, { tl: { col: 15, row: excelRow - 1 }, ext: { width: 55, height: 55 } });
          hayFoto = true;
        }
      } catch (e) { console.error("No se pudo incluir la foto del comprobante del alquiler " + r.id + ":", e); }
    }
    if (hayFoto) wsDetalle.getRow(excelRow).height = 44;
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

async function generarReporteAlquileres() {
  try {
    toast("Generando reporte... si hay muchas fotos puede tardar unos segundos.");
    const blob = await construirBlobReporteAlquileres();
    presentReport(blob, `Reporte_Alquileres_${todayISO()}.xlsx`);
  } catch (err) {
    if (err && err.message === "SIN_DATOS_ALQUILERES") { alert("Todavía no hay ningún alquiler cargado."); return; }
    console.error("Error generando el reporte de alquileres:", err);
    alert("Hubo un problema generando el reporte: " + (err && err.message ? err.message : err));
  }
}

function construirBlobReporteStock() {
  if (typeof XLSX === "undefined") throw new Error("No se pudo cargar el generador de Excel (necesita internet la primera vez).");
  if (state.machines.length === 0) throw new Error("SIN_DATOS_STOCK");

  const act = activeRentals();
  const stockData = [["Código", "Máquina", "Categoría", "Cantidad total", "Alquiladas", "Disponibles"]];
  state.machines.forEach((m) => {
    const alquiladas = act.filter((r) => r.machineId === m.id).length;
    stockData.push([m.code || "", m.name, m.category, m.totalQty, alquiladas, m.totalQty - alquiladas]);
  });
  const totalMaquinas = state.machines.reduce((s, m) => s + (Number(m.totalQty) || 0), 0);
  const totalAlquiladas = act.length;
  stockData.push([]);
  stockData.push(["TOTALES", "", "", totalMaquinas, totalAlquiladas, totalMaquinas - totalAlquiladas]);

  const wb = XLSX.utils.book_new();
  const wsStock = XLSX.utils.aoa_to_sheet(stockData);
  wsStock["!cols"] = [{ wch: 10 }, { wch: 28 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsStock, "Stock");

  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function generarReporteStock() {
  try {
    const blob = construirBlobReporteStock();
    presentReport(blob, `Reporte_Stock_${todayISO()}.xlsx`);
  } catch (err) {
    if (err && err.message === "SIN_DATOS_STOCK") { alert("Todavía no hay ninguna máquina cargada."); return; }
    console.error("Error generando el reporte de stock:", err);
    alert("Hubo un problema generando el reporte: " + (err && err.message ? err.message : err));
  }
}

function presentReport(blob, filename, label = "Excel") {
  const url = URL.createObjectURL(blob);
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title tag-font">${label === "PDF" ? "Presupuesto listo" : "Reporte listo"}</div>
          <button class="modal-close" id="close-modal">${icon("x")}</button>
        </div>
        <div class="hint" style="margin-top:0">${esc(filename)}</div>
        <a class="btn btn-primary btn-block" id="btn-download-report" href="${url}" download="${filename}" style="margin-top:10px;text-decoration:none">${icon("file")} Descargar ${label}</a>
        <div class="hint" style="margin-top:10px">Se guarda en tus Descargas. Desde ahí lo podés adjuntar en WhatsApp como cualquier otro archivo.</div>
      </div>
    </div>`;

  document.getElementById("overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeReportModal(url); });
  document.getElementById("close-modal").addEventListener("click", () => closeReportModal(url));
  document.getElementById("btn-download-report")?.addEventListener("click", () => {
    toast("Descargando reporte...");
    setTimeout(() => closeReportModal(url), 600);
  });
}

function closeReportModal(url) {
  document.getElementById("modal-root").innerHTML = "";
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ===================== SERVICE WORKER + INSTALACIÓN ===================== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* ===================== INICIO ===================== */
render();
initGoogleAuthWhenReady();
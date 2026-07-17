/* ===================== UTILIDADES ===================== */
const CATEGORIES = ["Eléctrica", "Manual", "Andamios/Estructura", "Medición", "Seguridad", "Otro"];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayISO() { return new Date().toISOString().split("T")[0]; }
function fmtDate(iso) { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
function fmtMoney(n) { const num = Number(n) || 0; return "$" + num.toLocaleString("es-AR", { maximumFractionDigits: 0 }); }
function esc(s) { const d = document.createElement("div"); d.innerText = s == null ? "" : s; return d.innerHTML; }

function calcDueDate(startDate, periodType, count) {
  const d = new Date(startDate + "T00:00:00");
  const c = Number(count) || 0;
  if (periodType === "Día") d.setDate(d.getDate() + c);
  else if (periodType === "Semana") d.setDate(d.getDate() + c * 7);
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
function saveMachines(list) { localStorage.setItem(LS_MACHINES, JSON.stringify(list)); }
function loadRentals() { try { return JSON.parse(localStorage.getItem(LS_RENTALS)) || []; } catch { return []; } }
function saveRentals(list) { localStorage.setItem(LS_RENTALS, JSON.stringify(list)); }

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
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").put(dataUrl, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
  return new Promise((resolve) => {
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").delete(key);
    tx.oncomplete = () => resolve();
  });
}

/* ===================== ESTADO ===================== */
const state = {
  tab: "inicio",
  machines: loadMachines(),
  rentals: loadRentals(),
  showMachineForm: false,
  editingMachine: null,
  viewingRentalId: null,
  nuevoAlquiler: freshRentalForm(),
};

function freshRentalForm() {
  return {
    machineId: "", clientName: "", clientPhone: "", clientDni: "",
    periodType: "Día", periodCount: 1, unitPrice: 0, totalOverride: null,
    startDate: todayISO(), notes: "", dniPhoto: null, comprobantePhoto: null,
    showPresupuesto: false,
  };
}

function activeRentals() { return state.rentals.filter((r) => r.status === "Activo"); }

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
            <div class="header-logo">${icon("wrench")}</div>
            <div style="min-width:0">
              <div class="header-title tag-font">ALQUILER DE HERRAMIENTAS</div>
              <div class="header-sub">Control de stock y clientes</div>
            </div>
          </div>
          <button class="header-action" id="btn-report" title="Reporte semanal">${icon("share")}</button>
        </div>
      </div>
      <div class="content" id="content"></div>
      <div class="nav">
        ${navBtn("home", "Inicio", "inicio")}
        ${navBtn("package", "Máquinas", "maquinas")}
        ${navBtn("plus", "Alquilar", "nuevo", true)}
        ${navBtn("list", "Alquileres", "alquileres")}
      </div>
    </div>
    <div id="modal-root"></div>
  `;
  renderContent();
  bindNav();
  renderModals();
  document.getElementById("btn-report").addEventListener("click", generarReporteSemanal);
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
    <div class="stat-grid">
      ${statCard("Máquinas", state.machines.length, "package", "var(--ink)")}
      ${statCard("Disponibles", totalDisponibles, "check", "var(--green)")}
      ${statCard("Alquileres activos", act.length, "list", "var(--yellow-dark)")}
      ${statCard("Atrasados", overdue.length, "alert", "var(--red)")}
    </div>`;

  if (overdue.length > 0) {
    html += `<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--red);display:flex;align-items:center;gap:6px">${icon("alert", "icon-inline")} Devoluciones atrasadas</div>`;
    overdue.forEach((r) => (html += rentalCard(r)));
    html += `<div style="height:8px"></div>`;
  }

  html += `
    <div class="action-row">
      <button class="btn btn-primary" data-go="nuevo">${icon("plus")} Nuevo alquiler</button>
      <button class="btn btn-secondary" data-go="maquinas">${icon("package")} Ver máquinas</button>
    </div>`;

  if (act.length > 0) {
    html += `<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--sub)">Alquileres activos (${act.length})</div>`;
    act.slice(0, 5).forEach((r) => (html += rentalCard(r)));
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
  const machine = state.machines.find((m) => m.id === f.machineId);
  const act = activeRentals();
  const available = state.machines.filter((m) => {
    const alquiladas = act.filter((r) => r.machineId === m.id).length;
    return m.totalQty - alquiladas > 0;
  });

  if (machine && f.unitPrice === null) f.unitPrice = machine.priceDay;
  const calcTotal = (Number(f.unitPrice) || 0) * (Number(f.periodCount) || 0);
  const total = f.totalOverride !== null ? f.totalOverride : calcTotal;
  const dueDate = calcDueDate(f.startDate, f.periodType, f.periodCount);

  let html = `
    <div class="section-title tag-font">Nuevo alquiler</div>
    <div class="section-sub">Cargá los datos del cliente y la máquina</div>

    <div class="field">
      <label>Máquina</label>
      <select id="f-machine">
        <option value="">Seleccioná una máquina...</option>
        ${available.map((m) => `<option value="${m.id}" ${m.id === f.machineId ? "selected" : ""}>${esc(m.name)} (${esc(m.code)})</option>`).join("")}
      </select>
    </div>
    ${state.machines.length > available.length ? `<div class="hint" style="color:var(--orange)">Algunas máquinas no aparecen porque no tienen stock disponible.</div>` : ""}

    <div class="section-block">
      <div class="block-title">${icon("id")} Datos del cliente</div>
      <div class="field"><label>Nombre y apellido</label><input type="text" id="f-clientName" value="${esc(f.clientName)}" placeholder="Juan Pérez"></div>
      <div class="field-row">
        <div class="field"><label>Teléfono</label><input type="tel" id="f-clientPhone" value="${esc(f.clientPhone)}" placeholder="011-5555-5555"></div>
        <div class="field"><label>DNI</label><input type="text" id="f-clientDni" value="${esc(f.clientDni)}" placeholder="30111222"></div>
      </div>
    </div>

    <div class="section-block">
      <div class="block-title">${icon("clock")} Período de alquiler</div>
      <div class="pill-row">
        ${["Día", "Semana", "Mes"].map((p) => `<button class="pill ${f.periodType === p ? "active" : ""}" data-period="${p}">${p}</button>`).join("")}
      </div>
      <div class="field-row">
        <div class="field"><label>Cantidad de ${f.periodType.toLowerCase()}s</label><input type="number" min="1" id="f-periodCount" value="${f.periodCount}"></div>
        <div class="field"><label>Fecha de inicio</label><input type="date" id="f-startDate" value="${f.startDate}"></div>
      </div>
      <div class="hint" style="margin-top:-2px">Devolución estimada: <b>${fmtDate(dueDate)}</b></div>
    </div>

    <div class="section-block">
      <div class="block-title">${icon("wrench")} Precio</div>
      <div class="field-row">
        <div class="field"><label>Precio por ${f.periodType.toLowerCase()}</label><input type="number" id="f-unitPrice" value="${f.unitPrice || 0}"></div>
        <div class="field"><label>Total (editable)</label><input type="number" id="f-total" value="${total}" style="font-weight:700"></div>
      </div>
      <div class="hint" style="margin-top:-4px">Podés modificar el precio unitario o el total a mano si le hacés un descuento.</div>
    </div>

    <div class="section-block">
      <div class="block-title">${icon("camera")} Fotos</div>
      <div class="photo-row">
        ${photoBox("dni", "DNI", "id", f.dniPhoto)}
        ${photoBox("comp", "Comprobante", "receipt", f.comprobantePhoto)}
      </div>
      <input type="file" accept="image/*" capture="environment" id="input-photo-dni" style="display:none">
      <input type="file" accept="image/*" capture="environment" id="input-photo-comp" style="display:none">
    </div>

    <div class="field"><label>Observaciones</label><textarea id="f-notes" rows="2" placeholder="Depósito, accesorios entregados, etc.">${esc(f.notes)}</textarea></div>

    ${f.showPresupuesto && machine ? presupuestoHTML(machine, f, total, dueDate) : ""}

    <div class="action-row" style="margin-top:6px">
      <button class="btn btn-secondary" id="btn-presupuesto">${icon("file")} Presupuesto</button>
      <button class="btn btn-primary" id="btn-confirmar">Confirmar alquiler</button>
    </div>
  `;
  return html;
}

function photoBox(key, label, iconName, photo) {
  return `
    <div class="photo-box ${photo ? "filled" : ""}" data-photo-pick="${key}">
      ${photo
        ? `<img src="${photo}"><button class="photo-clear" data-photo-clear="${key}">${icon("x")}</button>`
        : `${icon(iconName)}<div class="lbl">Subir ${label}</div>`}
    </div>`;
}

function presupuestoHTML(machine, f, total, dueDate) {
  return `
    <div class="presupuesto">
      <div class="presupuesto-title tag-font">Presupuesto</div>
      <div class="presupuesto-date">Emitido el ${fmtDate(todayISO())}</div>
      <div class="row-line"><span class="lab">Cliente</span><span class="val">${esc(f.clientName) || "-"}</span></div>
      <div class="row-line"><span class="lab">Máquina</span><span class="val">${esc(machine.name)}</span></div>
      <div class="row-line"><span class="lab">Período</span><span class="val">${f.periodCount} ${f.periodType.toLowerCase()}(s)</span></div>
      <div class="row-line"><span class="lab">Precio unitario</span><span class="val">${fmtMoney(f.unitPrice)}</span></div>
      <div class="row-line"><span class="lab">Desde / hasta</span><span class="val">${fmtDate(f.startDate)} — ${fmtDate(dueDate)}</span></div>
      <div class="presupuesto-total"><span class="lab">Total</span><span class="val tag-font">${fmtMoney(total)}</span></div>
      <div class="presupuesto-foot">Presupuesto sin cargo. No implica reserva de la máquina hasta confirmar el alquiler.</div>
    </div>`;
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
  filtered.forEach((r) => (html += rentalCard(r)));
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
    document.querySelectorAll("[data-open-rental]").forEach((b) => b.addEventListener("click", () => { state.viewingRentalId = b.dataset.openRental; renderModals(); }));
  }

  if (state.tab === "inicio") {
    document.querySelectorAll("[data-open-rental]").forEach((b) => b.addEventListener("click", () => { state.viewingRentalId = b.dataset.openRental; renderModals(); }));
  }
}

function bindNuevoAlquiler() {
  const f = state.nuevoAlquiler;

  document.getElementById("f-machine").addEventListener("change", (e) => {
    f.machineId = e.target.value;
    const m = state.machines.find((x) => x.id === f.machineId);
    if (m) f.unitPrice = f.periodType === "Día" ? m.priceDay : f.periodType === "Semana" ? m.priceWeek : m.priceMonth;
    f.totalOverride = null;
    renderContent();
  });

  document.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => {
    f.periodType = b.dataset.period;
    const m = state.machines.find((x) => x.id === f.machineId);
    if (m) f.unitPrice = f.periodType === "Día" ? m.priceDay : f.periodType === "Semana" ? m.priceWeek : m.priceMonth;
    f.totalOverride = null;
    renderContent();
  }));

  document.getElementById("f-clientName").addEventListener("input", (e) => { f.clientName = e.target.value; });
  document.getElementById("f-clientPhone").addEventListener("input", (e) => { f.clientPhone = e.target.value; });
  document.getElementById("f-clientDni").addEventListener("input", (e) => { f.clientDni = e.target.value; });
  document.getElementById("f-periodCount").addEventListener("input", (e) => { f.periodCount = e.target.value; syncTotals(); });
  document.getElementById("f-startDate").addEventListener("input", (e) => { f.startDate = e.target.value; syncTotals(); });
  document.getElementById("f-unitPrice").addEventListener("input", (e) => { f.unitPrice = e.target.value; f.totalOverride = null; syncTotals(); });
  document.getElementById("f-total").addEventListener("input", (e) => { f.totalOverride = Number(e.target.value); syncPresupuestoOnly(); });
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

  document.getElementById("btn-confirmar").addEventListener("click", async () => {
    const err = validateNuevo();
    if (err) { alert(err); return; }
    const machine = state.machines.find((m) => m.id === f.machineId);
    const calcTotal = (Number(f.unitPrice) || 0) * (Number(f.periodCount) || 0);
    const total = f.totalOverride !== null ? f.totalOverride : calcTotal;
    const dueDate = calcDueDate(f.startDate, f.periodType, f.periodCount);
    const rental = {
      id: uid(),
      machineId: machine.id, machineName: machine.name, machineCode: machine.code,
      clientName: f.clientName.trim(), clientPhone: f.clientPhone.trim(), clientDni: f.clientDni.trim(),
      periodType: f.periodType, periodCount: Number(f.periodCount), unitPrice: Number(f.unitPrice) || 0,
      total, startDate: f.startDate, dueDate, status: "Activo", notes: f.notes.trim(),
      hasDniPhoto: !!f.dniPhoto, hasComprobantePhoto: !!f.comprobantePhoto,
      createdAt: new Date().toISOString(),
    };
    state.rentals.push(rental);
    saveRentals(state.rentals);
    if (f.dniPhoto) await savePhoto("dni-" + rental.id, f.dniPhoto);
    if (f.comprobantePhoto) await savePhoto("comp-" + rental.id, f.comprobantePhoto);
    toast("Alquiler confirmado");
    state.nuevoAlquiler = freshRentalForm();
    state.tab = "alquileres";
    render();
  });
}

function syncTotals() { renderContent(); }
function syncPresupuestoOnly() {
  // solo re-renderiza el bloque de presupuesto si está visible, sin perder foco de otros inputs
  if (state.nuevoAlquiler.showPresupuesto) renderContent();
}

function validateNuevo() {
  const f = state.nuevoAlquiler;
  if (!f.machineId) return "Elegí una máquina";
  if (!f.clientName.trim()) return "Ingresá el nombre del cliente";
  if (!f.periodCount || Number(f.periodCount) <= 0) return "Ingresá una cantidad de períodos válida";
  return null;
}

/* ===================== MODALES ===================== */
function renderModals() {
  const root = document.getElementById("modal-root");
  if (state.showMachineForm) { root.innerHTML = machineFormModal(state.editingMachine); bindMachineForm(); return; }
  if (state.viewingRentalId) { root.innerHTML = rentalDetailModal(); bindRentalDetail(); return; }
  root.innerHTML = "";
}

function machineFormModal(machine) {
  const m = machine || { code: "", name: "", category: CATEGORIES[0], totalQty: 1, priceDay: "", priceWeek: "", priceMonth: "", notes: "" };
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

function rentalDetailModal() {
  const rental = state.rentals.find((r) => r.id === state.viewingRentalId);
  if (!rental) return "";
  const isOverdue = rental.status === "Activo" && rental.dueDate < todayISO();
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
        <div class="row-line"><span class="lab">Período</span><span class="val">${rental.periodCount} ${rental.periodType.toLowerCase()}(s)</span></div>
        <div class="row-line"><span class="lab">Desde</span><span class="val">${fmtDate(rental.startDate)}</span></div>
        <div class="row-line"><span class="lab">Devolución</span><span class="val">${fmtDate(rental.dueDate)}</span></div>
        <div class="row-line"><span class="lab">Estado</span><span class="val">${rental.status === "Devuelto" ? "Devuelto" : isOverdue ? "Atrasado" : "Activo"}</span></div>
        ${rental.notes ? `<div class="row-line"><span class="lab">Notas</span><span class="val">${esc(rental.notes)}</span></div>` : ""}
        <div class="presupuesto-total"><span class="lab">Total</span><span class="val tag-font">${fmtMoney(rental.total)}</span></div>
        <div class="detail-photos" id="detail-photos"></div>
        <div class="action-row" style="margin-top:16px">
          ${rental.status === "Activo" ? `<button class="btn btn-primary" id="btn-return">${icon("check")} Marcar devuelto</button>` : ""}
          <button class="btn-danger" id="btn-delete-rental">${icon("trash")}</button>
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

  document.getElementById("btn-delete-rental").addEventListener("click", async () => {
    if (!confirm("¿Eliminar este alquiler?")) return;
    state.rentals = state.rentals.filter((r) => r.id !== rental.id);
    saveRentals(state.rentals);
    await deletePhoto("dni-" + rental.id);
    await deletePhoto("comp-" + rental.id);
    toast("Alquiler eliminado");
    closeModals();
    renderContent();
  });
}

function closeModals() {
  state.showMachineForm = false;
  state.editingMachine = null;
  state.viewingRentalId = null;
  renderModals();
}

/* ===================== REPORTE SEMANAL (EXCEL) ===================== */
function generarReporteSemanal() {
  if (typeof XLSX === "undefined") {
    alert("No se pudo cargar el generador de Excel. Conectate a internet una vez para descargarlo y probá de nuevo (después ya queda guardado para usar offline).");
    return;
  }

  const todayStr = todayISO();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const weekAgoISO = weekAgo.toISOString().split("T")[0];

  // --- Hoja 1: Resumen ---
  const act = activeRentals();
  const overdueCount = act.filter((r) => r.dueDate < todayStr).length;
  const rentalsWeek = state.rentals.filter((r) => {
    const d = (r.createdAt || "").split("T")[0];
    return d >= weekAgoISO && d <= todayStr;
  });
  const totalFacturado = rentalsWeek.reduce((s, r) => s + (Number(r.total) || 0), 0);

  const resumenData = [
    ["REPORTE SEMANAL - ALQUILER DE HERRAMIENTAS"],
    [`Período: ${fmtDate(weekAgoISO)} al ${fmtDate(todayStr)}`],
    [],
    ["Alquileres registrados esta semana", rentalsWeek.length],
    ["Total facturado esta semana ($)", totalFacturado],
    ["Alquileres activos (total)", act.length],
    ["Devoluciones atrasadas", overdueCount],
    ["Máquinas cargadas en el inventario", state.machines.length],
  ];

  // --- Hoja 2: Alquileres de la semana ---
  const alquileresData = [
    ["Fecha carga", "Máquina", "Código", "Cliente", "Teléfono", "Período", "Cant. períodos", "Precio unitario", "Total", "Estado", "Fecha devolución"],
  ];
  rentalsWeek
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
    .forEach((r) => {
      const isOverdue = r.status === "Activo" && r.dueDate < todayStr;
      alquileresData.push([
        fmtDate((r.createdAt || "").split("T")[0]),
        r.machineName, r.machineCode || "", r.clientName, r.clientPhone || "",
        r.periodType, r.periodCount, r.unitPrice, r.total,
        r.status === "Devuelto" ? "Devuelto" : isOverdue ? "Atrasado" : "Activo",
        fmtDate(r.dueDate),
      ]);
    });
  if (rentalsWeek.length === 0) alquileresData.push(["(sin alquileres cargados esta semana)"]);

  // --- Hoja 3: Stock actual ---
  const stockData = [["Código", "Máquina", "Categoría", "Cantidad total", "Alquilado (hoy)", "Disponible (hoy)"]];
  state.machines.forEach((m) => {
    const alquiladas = act.filter((r) => r.machineId === m.id).length;
    stockData.push([m.code || "", m.name, m.category, m.totalQty, alquiladas, m.totalQty - alquiladas]);
  });
  if (state.machines.length === 0) stockData.push(["(sin máquinas cargadas)"]);

  const wb = XLSX.utils.book_new();
  const wsResumen = XLSX.utils.aoa_to_sheet(resumenData);
  wsResumen["!cols"] = [{ wch: 34 }, { wch: 14 }];
  const wsAlq = XLSX.utils.aoa_to_sheet(alquileresData);
  wsAlq["!cols"] = [{ wch: 12 }, { wch: 26 }, { wch: 8 }, { wch: 18 }, { wch: 14 }, { wch: 9 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 14 }];
  const wsStock = XLSX.utils.aoa_to_sheet(stockData);
  wsStock["!cols"] = [{ wch: 10 }, { wch: 26 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 14 }];

  XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen");
  XLSX.utils.book_append_sheet(wb, wsAlq, "Alquileres semana");
  XLSX.utils.book_append_sheet(wb, wsStock, "Stock");

  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const filename = `Reporte_Alquiler_${todayStr}.xlsx`;

  shareOrDownload(blob, filename);
}

function shareOrDownload(blob, filename) {
  try {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: "Reporte semanal", text: "Reporte semanal de alquileres y stock" })
        .catch(() => {}); // el usuario canceló, no hacemos nada más
      return;
    }
  } catch (e) { /* sigue al fallback de descarga */ }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Reporte descargado. Buscalo en tus Descargas para compartirlo.");
}

/* ===================== SERVICE WORKER + INSTALACIÓN ===================== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* ===================== INICIO ===================== */
render();

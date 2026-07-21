const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
require("fake-indexeddb/auto");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8")
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>\s*/g, "");

const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true });
dom.window.indexedDB = indexedDB;
dom.window.IDBKeyRange = IDBKeyRange;

const appJs = fs.readFileSync(path.join(__dirname, "js/app.js"), "utf8");

const testCode = `
setTimeout(() => {
  try {
    state.machines.push({ id: "m1", code: "H-001", name: "Amoladora", category: "Eléctrica", totalQty: 3, priceDay: 500, priceWeek: 3000, priceQuincena: 5000, priceMonth: 9000, notes: "" });
    state.machines.push({ id: "m2", code: "H-002", name: "Taladro", category: "Eléctrica", totalQty: 2, priceDay: 300, priceWeek: 1800, priceQuincena: 3000, priceMonth: 5500, notes: "" });
    saveMachines(state.machines);

    state.tab = "nuevo";
    const f = state.nuevoAlquiler;
    f.clientName = "Juan Pérez";
    f.periodType = "Día";
    f.periodCount = 3;
    f.items.push({ machineId: "m1", machineName: "Amoladora", machineCode: "H-001", unitPrice: priceForPeriod(state.machines[0], "Día") });
    f.items.push({ machineId: "m2", machineName: "Taladro", machineCode: "H-002", unitPrice: priceForPeriod(state.machines[1], "Día") });
    f.discountPercent = 10;

    const totals = computeTotals(f);
    console.log("computeTotals:", JSON.stringify(totals));
    const okTotals = totals.subtotal === 2400 && totals.discountAmount === 240 && totals.total === 2160;
    console.log("TOTALES_CORRECTOS=" + okTotals);

    render();
    console.log("RENDER_INICIO_OK");
    state.tab = "nuevo";
    renderContent();
    console.log("RENDER_NUEVO_OK");

    const dueDate = calcDueDate(f.startDate, f.periodType, f.periodCount);
    const rental = {
      id: uid(),
      items: f.items.map((it) => ({
        machineId: it.machineId, machineName: it.machineName, machineCode: it.machineCode,
        unitPrice: Number(it.unitPrice) || 0,
        subtotal: (Number(it.unitPrice) || 0) * (Number(f.periodCount) || 0),
      })),
      clientName: f.clientName, clientPhone: "", clientDni: "",
      periodType: f.periodType, periodCount: Number(f.periodCount),
      subtotal: totals.subtotal, discountPercent: totals.discountPercent, discountAmount: totals.discountAmount, total: totals.total,
      startDate: f.startDate, dueDate, status: "Activo", notes: "",
      hasDniPhoto: false, hasComprobantePhoto: false,
      createdAt: new Date().toISOString(), renewals: [],
    };
    state.rentals.push(rental);
    saveRentals(state.rentals);
    console.log("RENTAL_ITEMS=" + rental.items.length + " TOTAL=" + rental.total);

    console.log("ALQUILADAS_M1=" + rentedCountForMachine("m1") + " (esperado 1)");
    console.log("ALQUILADAS_M2=" + rentedCountForMachine("m2") + " (esperado 1)");

    state.tab = "alquileres";
    renderContent();
    console.log("RENDER_ALQUILERES_OK");

    state.viewingRentalId = rental.id;
    renderModals();
    console.log("RENDER_DETALLE_OK");

    const oldRental = { id: "old1", machineId: "m1", machineName: "Amoladora", machineCode: "H-001", unitPrice: 500, periodCount: 2, periodType: "Día", discount: 100, total: 900, status: "Activo", startDate: "2026-01-01", dueDate: "2026-01-03", createdAt: "2026-01-01T00:00:00.000Z" };
    const normalized = normalizeRental(oldRental);
    console.log("NORMALIZADO=" + JSON.stringify(normalized));

    // Simular renovación de un alquiler con 2 máquinas y descuento 10%
    renewPeriodType = "Día";
    renewCount = 2;
    const html2 = rentalDetailModal();
    console.log("RENTAL_DETAIL_HTML_LEN=" + html2.length);

    console.log("=== SMOKE_TEST_OK ===");
  } catch (err) {
    console.error("SMOKE_TEST_FALLO: " + err.stack);
  }
}, 100);
`;

dom.window.eval(appJs + "\n" + testCode);

setTimeout(() => {
  process.exit(0);
}, 1000);

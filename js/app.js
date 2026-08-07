import { db, ORG_ID } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, runTransaction,
  serverTimestamp, writeBatch, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore-lite.js";

/* ============================================================
   HELPERS DE RUTA FIRESTORE
   ============================================================ */
const col = (name) => collection(db, `organizations/${ORG_ID}/${name}`);
const docRef = (name, id) => doc(db, `organizations/${ORG_ID}/${name}/${id}`);
const cop = (n) => "$" + Math.round(n || 0).toLocaleString("es-CO");

/* ============================================================
   ESTADO GLOBAL DE LA APP
   ============================================================ */
const state = {
  user: null,            // { id, name, role, pin }
  shift: null,           // turno abierto actual
  categories: [],
  expenseCategories: [],
  baseFija: 0,
  products: [],
  adminProducts: [],     // incluye inactivos, solo para la pantalla de Administración
  editingProductId: null,
  restockingProductId: null,
  tables: [],
  currentTable: null,
  currentOrder: null,    // { id, tableId, items: [] }
  activeCategoryBar: null,
  activeCategoryCocina: null,
  searchQuery: "",
  pinBuffer: "",
};

/* ============================================================
   UTILIDADES DE UI
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll("main > section").forEach((s) => s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

function toast(msg, type = "ok") {
  const el = document.getElementById("toast");
  const colors = {
    ok: "border-success/40 bg-success/10 text-success",
    error: "border-danger/40 bg-danger/10 text-danger",
    info: "border-gold/40 bg-gold/10 text-goldsoft",
  };
  el.className = `fixed top-5 right-5 z-50 px-5 py-3 rounded-xl border text-sm font-medium ${colors[type]}`;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

/* ============================================================
   LOGIN POR PIN
   ============================================================ */
function renderKeypad() {
  const grid = document.querySelector("#screen-login .grid");
  grid.innerHTML = "";
  const keys = ["1","2","3","4","5","6","7","8","9","borrar","0","ok"];
  keys.forEach((k) => {
    const btn = document.createElement("button");
    btn.className = "key";
    btn.textContent = k === "borrar" ? "⌫" : k === "ok" ? "✓" : k;
    btn.type = "button";
    btn.addEventListener("click", () => handleKey(k));
    grid.appendChild(btn);
  });
}

function updatePinDots() {
  const dots = document.querySelectorAll(".pin-dot");
  dots.forEach((d, i) => d.classList.toggle("filled", i < state.pinBuffer.length));
}

function handleKey(k) {
  if (k === "borrar") { state.pinBuffer = state.pinBuffer.slice(0, -1); }
  else if (k === "ok") { attemptLogin(); return; }
  else if (state.pinBuffer.length < 4) { state.pinBuffer += k; }
  updatePinDots();
  if (state.pinBuffer.length === 4) attemptLogin();
}

async function attemptLogin() {
  const pin = state.pinBuffer;
  document.getElementById("loginError").classList.add("hidden");
  const snap = await getDocs(query(col("users"), where("pin", "==", pin), where("active", "==", true)));
  if (snap.empty) {
    document.getElementById("loginError").classList.remove("hidden");
    state.pinBuffer = "";
    updatePinDots();
    return;
  }
  const u = snap.docs[0];
  state.user = { id: u.id, ...u.data() };
  state.pinBuffer = "";
  updatePinDots();
  await afterLogin();
}

async function afterLogin() {
  document.getElementById("topbar").classList.remove("hidden");
  document.getElementById("userBadge").textContent = `${state.user.name} · ${roleLabel(state.user.role)}`;
  renderNav();
  // Estas tres cargas son independientes entre sí, así que las
  // pedimos al mismo tiempo en vez de esperar una y luego la otra.
  await Promise.all([
    loadOpenShift(),
    loadCategoriesAndProducts(),
    loadTables(),
    loadExpenseCategories(),
    loadBaseFija(),
  ]);
  // loadTables() ya deja renderizada y visible la pantalla de mesas,
  // así que no volvemos a pedirlas de nuevo con goHome().
}

function roleLabel(r) {
  return { mesero: "Mesero", cajero: "Cajero", admin_contador: "Administrador" }[r] || r;
}

function logout() {
  state.user = null;
  state.shift = null;
  state.currentOrder = null;
  state.currentTable = null;
  document.getElementById("topbar").classList.add("hidden");
  showScreen("screen-login");
}

/* ============================================================
   NAVEGACIÓN
   ============================================================ */
function renderNav() {
  const nav = document.getElementById("mainNav");
  const items = [{ id: "screen-tables", label: "Salón" }];
  if (["cajero", "admin_contador"].includes(state.user.role)) {
    items.push({ id: "screen-shift", label: "Caja" });
    items.push({ id: "screen-expenses", label: "Egresos" });
    items.push({ id: "screen-breakfast", label: "Desayunos" });
  }
  if (state.user.role === "admin_contador") {
    items.push({ id: "screen-admin", label: "Administración" });
  }
  nav.innerHTML = "";
  items.forEach((it) => {
    const b = document.createElement("button");
    b.textContent = it.label;
    b.className = "px-3 py-1.5 rounded-full hover:bg-gold/10 text-cream/70 hover:text-goldsoft transition";
    b.addEventListener("click", () => navigateTo(it.id));
    nav.appendChild(b);
  });
}

function navigateTo(screenId) {
  if (screenId === "screen-tables") return loadTables().then(() => showScreen("screen-tables"));
  if (screenId === "screen-shift") return renderShiftScreen();
  if (screenId === "screen-expenses") return showScreen("screen-expenses");
  if (screenId === "screen-breakfast") return renderBreakfastScreen();
  if (screenId === "screen-admin") return renderAdminScreen();
}

function goHome() { navigateTo("screen-tables"); }

/* ============================================================
   MESAS
   ============================================================ */
async function loadTables() {
  let snap = await getDocs(query(col("tables"), orderBy("number")));
  if (snap.empty) {
    // Siembra 10 mesas por defecto la primera vez que se usa el sistema
    for (let i = 1; i <= 10; i++) {
      await addDoc(col("tables"), { number: i, zone: "salon", status: "libre" });
    }
    snap = await getDocs(query(col("tables"), orderBy("number")));
  }
  state.tables = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderTablesGrid();
}

function renderTablesGrid() {
  const grid = document.getElementById("tablesGrid");
  grid.innerHTML = "";
  state.tables.forEach((t) => {
    const statusClass = t.status === "libre" ? "libre" : t.status === "cuenta_pedida" ? "cuenta" : "ocupada";
    const div = document.createElement("button");
    div.className = `table-card ${statusClass}`;
    div.innerHTML = `<span>Mesa ${t.number}</span>
      ${t.label ? `<span class="text-xs text-gold/70">${t.label}</span>` : ""}
      <span class="text-xs uppercase tracking-wide opacity-70">${t.status.replace("_"," ")}</span>`;
    div.addEventListener("click", () => openTable(t));
    grid.appendChild(div);
  });
  showScreen("screen-tables");
}

async function openTable(table) {
  state.currentTable = table;
  document.getElementById("posTableLabel").textContent = table.label ? `Mesa ${table.number} · ${table.label}` : `Mesa ${table.number}`;

  // Buscar orden abierta para esta mesa, o crear una nueva
  const snap = await getDocs(query(col("orders"), where("tableId", "==", table.id), where("status", "in", ["abierta", "en_cocina", "servida"])));
  if (!snap.empty) {
    const d = snap.docs[0];
    state.currentOrder = { id: d.id, ...d.data() };
  } else {
    const newOrderRef = doc(col("orders"));
    const newOrder = {
      tableId: table.id,
      waiterId: state.user.id,
      status: "abierta",
      items: [],
      createdAt: serverTimestamp(),
    };
    const batch = writeBatch(db);
    batch.set(newOrderRef, newOrder);
    batch.set(docRef("tables", table.id), { status: "ocupada" }, { merge: true });
    await batch.commit();
    state.currentOrder = { id: newOrderRef.id, ...newOrder, items: [] };
    // Reflejamos el cambio de estado en memoria de inmediato.
    const t = state.tables.find((tb) => tb.id === table.id);
    if (t) t.status = "ocupada";
  }
  state.activeCategoryBar = categoriesByDept("bar")[0]?.id || null;
  state.activeCategoryCocina = categoriesByDept("cocina")[0]?.id || null;
  state.searchQuery = "";
  document.getElementById("productSearch").value = "";
  renderCategoryTabs();
  renderProductsGrid();
  renderCart();
  showScreen("screen-pos");
}

document.getElementById("backToTables").addEventListener("click", () => loadTables());

async function releaseTable() {
  const doRelease = async () => {
    const batch = writeBatch(db);
    batch.set(docRef("orders", state.currentOrder.id), { status: "cancelada" }, { merge: true });
    batch.set(docRef("tables", state.currentTable.id), { status: "libre" }, { merge: true });
    await batch.commit();

    // Actualizamos la mesa en memoria al instante, sin volver a
    // pedirle toda la lista de mesas al servidor.
    const t = state.tables.find((tb) => tb.id === state.currentTable.id);
    if (t) t.status = "libre";
    toast("Mesa liberada", "info");
    renderTablesGrid();
  };
  if (state.currentOrder.items.length === 0) {
    doRelease();
  } else {
    requireAnyPin(doRelease);
  }
}
document.getElementById("releaseTableBtn").addEventListener("click", releaseTable);

document.getElementById("editTableLabelBtn").addEventListener("click", () => {
  document.getElementById("tableLabelInput").value = state.currentTable.label || "";
  openModal("modalTableLabel");
});
document.getElementById("cancelTableLabel").addEventListener("click", () => closeModal("modalTableLabel"));
document.getElementById("saveTableLabel").addEventListener("click", async () => {
  const label = document.getElementById("tableLabelInput").value.trim();
  await updateDoc(docRef("tables", state.currentTable.id), { label });
  state.currentTable.label = label;
  const t = state.tables.find((tb) => tb.id === state.currentTable.id);
  if (t) t.label = label;
  document.getElementById("posTableLabel").textContent = label ? `Mesa ${state.currentTable.number} · ${label}` : `Mesa ${state.currentTable.number}`;
  closeModal("modalTableLabel");
  toast("Mesa actualizada", "ok");
});

/* ============================================================
   CATEGORÍAS Y PRODUCTOS
   ============================================================ */
async function loadCategoriesAndProducts() {
  let catSnap = await getDocs(query(col("categories"), orderBy("order")));
  if (catSnap.empty) {
    const defaults = [
      { name: "Cócteles de autor", type: "coctel", department: "bar", order: 1 },
      { name: "Bebidas", type: "bebida", department: "bar", order: 2 },
      { name: "Platos", type: "plato", department: "cocina", order: 3 },
    ];
    for (const c of defaults) await addDoc(col("categories"), c);
    catSnap = await getDocs(query(col("categories"), orderBy("order")));
  }
  state.categories = catSnap.docs.map((d) => ({ id: d.id, department: "bar", ...d.data() }));

  const prodSnap = await getDocs(query(col("products"), where("active", "==", true)));
  state.products = prodSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function categoriesByDept(dept) {
  return state.categories.filter((c) => (c.department || "bar") === dept);
}

function renderCategoryTabsForDept(dept) {
  const tabsId = dept === "bar" ? "categoryTabsBar" : "categoryTabsCocina";
  const activeKey = dept === "bar" ? "activeCategoryBar" : "activeCategoryCocina";
  const wrap = document.getElementById(tabsId);
  wrap.innerHTML = "";
  categoriesByDept(dept).forEach((c) => {
    const b = document.createElement("button");
    b.className = `chip whitespace-nowrap ${state[activeKey] === c.id ? "active" : ""}`;
    b.textContent = c.name;
    b.addEventListener("click", () => {
      state[activeKey] = c.id;
      renderCategoryTabsForDept(dept);
      renderProductsGridForDept(dept);
    });
    wrap.appendChild(b);
  });
  if (!categoriesByDept(dept).length) {
    wrap.innerHTML = `<span class="text-cream/40 text-sm">Sin categorías en ${dept === "bar" ? "Bar" : "Cocina"}</span>`;
  }
}

function renderProductsGridForDept(dept) {
  const gridId = dept === "bar" ? "productsGridBar" : "productsGridCocina";
  const activeKey = dept === "bar" ? "activeCategoryBar" : "activeCategoryCocina";
  const grid = document.getElementById(gridId);
  grid.innerHTML = "";

  const deptCategoryIds = new Set(categoriesByDept(dept).map((c) => c.id));
  const query = state.searchQuery.trim().toLowerCase();

  const list = query
    // Con búsqueda activa: todos los productos de este departamento que coincidan por nombre,
    // sin importar en qué categoría estén (así no hay que adivinar la pestaña correcta).
    ? state.products.filter((p) => deptCategoryIds.has(p.categoryId) && p.name.toLowerCase().includes(query))
    // Sin búsqueda: el comportamiento normal, filtrado por la categoría activa.
    : state.products.filter((p) => p.categoryId === state[activeKey]);

  if (!list.length) {
    grid.innerHTML = `<p class="text-cream/40 text-sm col-span-full">${query ? "Sin resultados en " + (dept === "bar" ? "Bar" : "Cocina") : "Sin productos en esta categoría"}</p>`;
    return;
  }

  list.forEach((p) => {
      const card = document.createElement("button");
      card.className = "product-card";
      const lowStock = p.currentStock !== undefined && p.currentStock <= (p.minStockAlert ?? 0);
      card.innerHTML = `
        <div class="h-24 bg-navy/60 flex items-center justify-center text-cream/30 text-xs">
          ${p.imageUrl ? `<img src="${p.imageUrl}" class="w-full h-full object-cover" />` : "sin imagen"}
        </div>
        <div class="p-3">
          <p class="font-display text-base leading-tight">${p.name}</p>
          <p class="text-gold text-sm mt-1">${cop(p.price)}</p>
          ${lowStock ? `<span class="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded-full bg-warn/20 text-goldsoft border border-warn/40">stock bajo</span>` : ""}
        </div>`;
      card.addEventListener("click", () => addToOrder(p));
      grid.appendChild(card);
  });
}

document.getElementById("productSearch").addEventListener("input", (e) => {
  state.searchQuery = e.target.value;
  renderProductsGrid();
});

function renderCategoryTabs() {
  if (!state.activeCategoryBar) state.activeCategoryBar = categoriesByDept("bar")[0]?.id || null;
  if (!state.activeCategoryCocina) state.activeCategoryCocina = categoriesByDept("cocina")[0]?.id || null;
  renderCategoryTabsForDept("bar");
  renderCategoryTabsForDept("cocina");
}

function renderProductsGrid() {
  renderProductsGridForDept("bar");
  renderProductsGridForDept("cocina");
}

/* ============================================================
   CARRITO / PEDIDO
   ============================================================ */
function addToOrder(product) {
  const items = state.currentOrder.items;
  const existing = items.find((i) => i.productId === product.id && !i.voided);
  if (existing) existing.qty += 1;
  else items.push({ productId: product.id, name: product.name, unitPrice: product.price, qty: 1, notes: "", voided: false });
  persistOrder();
  renderCart();
}

function changeQty(idx, delta) {
  const items = state.currentOrder.items;
  items[idx].qty += delta;
  if (items[idx].qty <= 0) items.splice(idx, 1);
  persistOrder();
  renderCart();
}

function removeItem(idx) {
  requireAdminPin(() => {
    state.currentOrder.items.splice(idx, 1);
    persistOrder();
    renderCart();
    toast("Ítem eliminado", "info");
  });
}

async function persistOrder() {
  await setDoc(docRef("orders", state.currentOrder.id), {
    items: state.currentOrder.items,
  }, { merge: true });
}

function cartSubtotal() {
  return state.currentOrder.items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
}

function renderCart() {
  const wrap = document.getElementById("cartItems");
  wrap.innerHTML = "";
  state.currentOrder.items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between text-sm";
    row.innerHTML = `
      <div class="flex-1">
        <p class="text-cream/90">${item.name}</p>
        <p class="text-gold/70 text-xs">${cop(item.unitPrice)} c/u</p>
      </div>
      <div class="flex items-center gap-2">
        <button class="qtyBtn chip" data-a="-1">−</button>
        <span class="w-5 text-center">${item.qty}</span>
        <button class="qtyBtn chip" data-a="1">+</button>
        <button class="delBtn text-danger/70 hover:text-danger ml-1">✕</button>
      </div>`;
    row.querySelectorAll(".qtyBtn").forEach((b) =>
      b.addEventListener("click", () => changeQty(idx, parseInt(b.dataset.a))));
    row.querySelector(".delBtn").addEventListener("click", () => removeItem(idx));
    wrap.appendChild(row);
  });
  document.getElementById("cartSubtotal").textContent = cop(cartSubtotal());
}

document.getElementById("sendKitchenBtn").addEventListener("click", async () => {
  if (!state.currentOrder.items.length) return toast("El pedido está vacío", "error");
  await setDoc(docRef("orders", state.currentOrder.id), { status: "en_cocina" }, { merge: true });
  toast("Pedido enviado a cocina", "ok");
});

/* ============================================================
   CHECKOUT / COBRO
   ============================================================ */
let checkoutState = { tip: 0, lines: [] };

document.getElementById("chargeBtn").addEventListener("click", () => {
  if (!state.currentOrder.items.length) return toast("El pedido está vacío", "error");
  checkoutState = { tip: 0, lines: [{ method: "efectivo", amount: 0 }] };
  renderCheckout();
  openModal("modalCheckout");
});

function renderCheckout() {
  const subtotal = cartSubtotal();
  const total = subtotal + checkoutState.tip;
  document.getElementById("coSubtotal").textContent = cop(subtotal);
  document.getElementById("coTotal").textContent = cop(total);

  document.querySelectorAll(".tipBtn").forEach((b) => {
    b.classList.remove("active");
    b.onclick = () => {
      const pct = parseFloat(b.dataset.tip);
      checkoutState.tip = Math.round(subtotal * (pct / 100));
      renderCheckout();
    };
  });

  const wrap = document.getElementById("paymentLines");
  wrap.innerHTML = "";
  checkoutState.lines.forEach((line, idx) => {
    const row = document.createElement("div");
    row.className = "flex gap-2";
    row.innerHTML = `
      <select class="input flex-1 lineMethod">
        <option value="efectivo" ${line.method === "efectivo" ? "selected" : ""}>Efectivo</option>
        <option value="tarjeta" ${line.method === "tarjeta" ? "selected" : ""}>Tarjeta</option>
        <option value="transferencia" ${line.method === "transferencia" ? "selected" : ""}>Transferencia</option>
      </select>
      <input type="number" class="input w-28 lineAmount" value="${line.amount || ""}" placeholder="Monto" />
      ${checkoutState.lines.length > 1 ? `<button class="text-danger/70 lineRemove">✕</button>` : ""}
    `;
    row.querySelector(".lineMethod").addEventListener("change", (e) => { line.method = e.target.value; });
    row.querySelector(".lineAmount").addEventListener("input", (e) => { line.amount = parseFloat(e.target.value) || 0; renderRemaining(); });
    row.querySelector(".lineRemove")?.addEventListener("click", () => { checkoutState.lines.splice(idx, 1); renderCheckout(); });
    wrap.appendChild(row);
  });
  renderRemaining();
}

function renderRemaining() {
  const subtotal = cartSubtotal();
  const total = subtotal + checkoutState.tip;
  const paid = checkoutState.lines.reduce((s, l) => s + (l.amount || 0), 0);
  const remaining = total - paid;
  const el = document.getElementById("payRemaining");
  el.textContent = remaining > 0 ? `Falta ${cop(remaining)}` : remaining < 0 ? `Sobran ${cop(-remaining)}` : "Pago completo ✓";
  el.className = `text-xs mb-4 ${remaining === 0 ? "text-success" : "text-warn"}`;
}

document.getElementById("addPaymentLine").addEventListener("click", () => {
  checkoutState.lines.push({ method: "efectivo", amount: 0 });
  renderCheckout();
});

document.getElementById("needsInvoice").addEventListener("change", (e) => {
  document.getElementById("invoiceFields").classList.toggle("hidden", !e.target.checked);
});

document.getElementById("cancelCheckout").addEventListener("click", () => closeModal("modalCheckout"));

document.getElementById("confirmCheckout").addEventListener("click", confirmSale);

async function confirmSale() {
  const subtotal = cartSubtotal();
  const total = subtotal + checkoutState.tip;
  const paid = checkoutState.lines.reduce((s, l) => s + (l.amount || 0), 0);
  if (Math.abs(paid - total) > 1) return toast("El pago no coincide con el total", "error");
  if (!state.shift) return toast("No hay un turno de caja abierto", "error");

  try {
    const saleRef = await runTransaction(db, async (tx) => {
      // Descontar stock de cada ítem (directo o por receta)
      for (const item of state.currentOrder.items) {
        const prodRef = docRef("products", item.productId);
        const prodSnap = await tx.get(prodRef);
        if (!prodSnap.exists()) continue;
        const product = prodSnap.data();

        if (product.isRecipe && product.recipeId) {
          const recipeSnap = await tx.get(docRef("recipes", product.recipeId));
          if (recipeSnap.exists()) {
            for (const ing of recipeSnap.data().items) {
              const ingRef = docRef("ingredients", ing.ingredientId);
              const ingSnap = await tx.get(ingRef);
              if (!ingSnap.exists()) continue;
              const newStock = (ingSnap.data().currentStock || 0) - ing.quantity * item.qty;
              tx.update(ingRef, { currentStock: newStock });
            }
          }
        } else if (product.currentStock !== undefined) {
          tx.update(prodRef, { currentStock: product.currentStock - item.qty });
        }
      }

      const newSaleRef = doc(col("sales"));
      tx.set(newSaleRef, {
        orderId: state.currentOrder.id,
        subtotal, tip: checkoutState.tip, total,
        payments: checkoutState.lines,
        cashierId: state.user.id,
        shiftId: state.shift.id,
        createdAt: serverTimestamp(),
      });

      tx.set(docRef("orders", state.currentOrder.id), { status: "cerrada" }, { merge: true });
      tx.set(docRef("tables", state.currentTable.id), { status: "libre" }, { merge: true });

      return newSaleRef;
    });

    const invoiceClientData = document.getElementById("needsInvoice").checked
      ? {
          docNumber: document.getElementById("invDoc").value,
          name: document.getElementById("invName").value,
          email: document.getElementById("invEmail").value,
        }
      // Sin solicitud expresa del cliente: se reporta igual ante la DIAN
      // a nombre de "Consumidor Final" (documento genérico usado por los
      // proveedores tecnológicos colombianos para este caso — confirma
      // el número exacto con tu proveedor de facturación, puede variar).
      : { docType: "43", docNumber: "222222222222", name: "Consumidor final", email: "" };

    await addDoc(col("invoices"), {
      saleId: saleRef.id,
      clientData: invoiceClientData,
      requestedByClient: document.getElementById("needsInvoice").checked,
      dianStatus: "pendiente",
      createdAt: serverTimestamp(),
    });

    showReceipt({
      saleId: saleRef.id,
      table: state.currentTable,
      items: [...state.currentOrder.items],
      subtotal, tip: checkoutState.tip, total,
      payments: checkoutState.lines,
      clientData: invoiceClientData,
      cashierName: state.user.name,
      date: new Date(),
    });

    closeModal("modalCheckout");
    await loadCategoriesAndProducts();
    loadTables();
  } catch (err) {
    console.error(err);
    toast("Error al procesar la venta", "error");
  }
}

/* ---- Recibo de venta (para el cliente / control interno) ---- */
function showReceipt(sale) {
  const dateStr = sale.date.toLocaleString("es-CO");
  const itemsHtml = sale.items.map((i) =>
    `<div class="flex justify-between"><span>${i.qty}x ${i.name}</span><span>${cop(i.unitPrice * i.qty)}</span></div>`).join("");
  const paymentsHtml = sale.payments.map((p) =>
    `<div class="flex justify-between"><span class="capitalize">${p.method}</span><span>${cop(p.amount)}</span></div>`).join("");

  document.getElementById("receiptContent").innerHTML = `
    <div class="text-center mb-3">
      <p class="font-display text-xl text-goldsoft">BAHÍA 1525</p>
      <p class="text-cream/40 text-xs">Del amanecer al brindis</p>
    </div>
    <div class="border-t border-gold/15 pt-3 space-y-1 text-cream/70 text-xs">
      <p>Fecha: ${dateStr}</p>
      <p>Cajero: ${sale.cashierName}</p>
      ${sale.table ? `<p>Mesa: ${sale.table.number}${sale.table.label ? " · " + sale.table.label : ""}</p>` : ""}
      <p>Cliente: ${sale.clientData.name}${sale.clientData.docNumber ? " · " + sale.clientData.docNumber : ""}</p>
    </div>
    <div class="border-t border-gold/15 mt-3 pt-3 space-y-1">${itemsHtml}</div>
    <div class="border-t border-gold/15 mt-3 pt-3 space-y-1">
      <div class="flex justify-between text-cream/60"><span>Subtotal</span><span>${cop(sale.subtotal)}</span></div>
      ${sale.tip ? `<div class="flex justify-between text-cream/60"><span>Propina</span><span>${cop(sale.tip)}</span></div>` : ""}
      <div class="flex justify-between text-goldsoft font-semibold"><span>Total</span><span>${cop(sale.total)}</span></div>
    </div>
    <div class="border-t border-gold/15 mt-3 pt-3 space-y-1">
      <p class="text-cream/50 text-xs mb-1">Forma de pago</p>${paymentsHtml}
    </div>
    <p class="text-cream/30 text-[10px] mt-4 text-center">Venta registrada ante la DIAN a nombre de: ${sale.clientData.name}</p>`;
  openModal("modalReceipt");
}
document.getElementById("closeReceiptBtn").addEventListener("click", () => closeModal("modalReceipt"));
document.getElementById("printReceiptBtn").addEventListener("click", () => window.print());

/* ============================================================
   PIN DE ADMINISTRADOR (anulaciones)
   ============================================================ */
function requireAdminPin(onSuccess) {
  document.getElementById("adminPinInput").value = "";
  openModal("modalAdminPin");
  document.getElementById("confirmAdminPin").onclick = async () => {
    const pin = document.getElementById("adminPinInput").value;
    const snap = await getDocs(query(col("users"), where("pin", "==", pin), where("role", "==", "admin_contador")));
    if (snap.empty) { toast("PIN incorrecto", "error"); return; }
    closeModal("modalAdminPin");
    onSuccess();
  };
}

// Igual que requireAdminPin, pero acepta el PIN de CUALQUIER usuario
// activo (mesero, cajero o admin) — para acciones de menor riesgo,
// como liberar una mesa abierta por error.
function requireAnyPin(onSuccess) {
  document.getElementById("adminPinInput").value = "";
  openModal("modalAdminPin");
  document.getElementById("confirmAdminPin").onclick = async () => {
    const pin = document.getElementById("adminPinInput").value;
    const snap = await getDocs(query(col("users"), where("pin", "==", pin), where("active", "==", true)));
    if (snap.empty) { toast("PIN incorrecto", "error"); return; }
    closeModal("modalAdminPin");
    onSuccess();
  };
}
document.getElementById("cancelAdminPin").addEventListener("click", () => closeModal("modalAdminPin"));

/* ============================================================
   CAJA / TURNOS
   ============================================================ */
async function loadBaseFija() {
  try {
    const snap = await getDoc(docRef("settings", "caja"));
    state.baseFija = snap.exists() ? (snap.data().baseFija || 0) : 0;
  } catch {
    state.baseFija = 0;
  }
}

async function loadOpenShift() {
  const snap = await getDocs(query(col("shifts"), where("status", "==", "abierto"), limit(1)));
  state.shift = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function renderShiftScreen() {
  showScreen("screen-shift");
  const wrap = document.getElementById("shiftContent");
  await Promise.all([loadOpenShift(), loadBaseFija()]);

  if (!state.shift) {
    wrap.innerHTML = `
      <p class="text-cream/70 mb-4">No hay un turno abierto. Ingresa la base inicial de caja para comenzar.</p>
      <label class="label">Base inicial en efectivo</label>
      <input type="number" id="initialCash" class="input mb-2" value="${state.baseFija || ""}" placeholder="Base inicial en efectivo" />
      <p class="text-cream/40 text-xs mb-4">Sugerida desde la base fija configurada en Administración (${cop(state.baseFija)}). Puedes cambiarla si este turno empieza distinto.</p>
      <button id="openShiftBtn" class="btn-primary w-full">Abrir turno</button>`;
    document.getElementById("openShiftBtn").addEventListener("click", async () => {
      const initialCash = parseFloat(document.getElementById("initialCash").value) || 0;
      const ref = await addDoc(col("shifts"), {
        openedBy: state.user.id, openedAt: serverTimestamp(), initialCash, status: "abierto",
      });
      state.shift = { id: ref.id, initialCash, status: "abierto" };
      toast("Turno abierto", "ok");
      renderShiftScreen();
    });
    return;
  }

  const totals = await computeShiftTotals(state.shift.id);
  const sobranteRetirar = totals.expectedCash - state.baseFija;
  wrap.innerHTML = `
    <div class="grid grid-cols-2 gap-4 text-sm mb-6">
      <div><p class="text-cream/50">Base inicial</p><p class="text-lg text-goldsoft">${cop(state.shift.initialCash)}</p></div>
      <div><p class="text-cream/50">Ventas efectivo</p><p class="text-lg text-goldsoft">${cop(totals.cash)}</p></div>
      <div><p class="text-cream/50">Ventas tarjeta</p><p class="text-lg text-goldsoft">${cop(totals.card)}</p></div>
      <div><p class="text-cream/50">Ventas transferencia</p><p class="text-lg text-goldsoft">${cop(totals.transfer)}</p></div>
      <div><p class="text-cream/50">Egresos (total)</p><p class="text-lg text-goldsoft">${cop(totals.expenses)}</p></div>
      <div><p class="text-cream/50">Egresos en efectivo</p><p class="text-lg text-goldsoft">${cop(totals.expensesCash)}</p></div>
      <div><p class="text-cream/50">Propinas del turno</p><p class="text-lg text-goldsoft">${cop(totals.tips)}</p></div>
      <div><p class="text-cream/50">Efectivo esperado</p><p class="text-lg text-goldsoft">${cop(totals.expectedCash)}</p></div>
    </div>
    <label class="label">Efectivo real contado</label>
    <input type="number" id="actualCash" class="input mb-2" placeholder="0" />
    <div id="cierrePreview" class="text-xs text-cream/50 mb-4 space-y-1">
      <p>Base fija configurada: ${cop(state.baseFija)}</p>
      <p>Base que debería quedar en caja: ${cop(state.baseFija)}</p>
      <p>Sobrante a retirar (según lo esperado): ${cop(sobranteRetirar)}</p>
    </div>
    <button id="closeShiftBtn" class="btn-primary w-full">Cerrar caja</button>`;

  document.getElementById("closeShiftBtn").addEventListener("click", () => {
    requireAnyPin(async () => {
      const actualCash = parseFloat(document.getElementById("actualCash").value) || 0;
      const difference = actualCash - totals.expectedCash;
      const sobranteReal = actualCash - state.baseFija;
      await updateDoc(docRef("shifts", state.shift.id), {
        status: "cerrado", closedAt: serverTimestamp(), closedBy: state.user.id,
        totals: {
          ...totals, actualCash, difference,
          baseFija: state.baseFija,
          baseDejada: state.baseFija,
          sobranteRetirado: sobranteReal,
        },
      });
      toast(`Caja cerrada. Diferencia: ${cop(difference)} · Sobrante a retirar: ${cop(sobranteReal)}`, difference === 0 ? "ok" : "info");
      state.shift = null;
      renderShiftScreen();
    });
  });
}

async function computeShiftTotals(shiftId) {
  const salesSnap = await getDocs(query(col("sales"), where("shiftId", "==", shiftId)));
  const expSnap = await getDocs(query(col("expenses"), where("shiftId", "==", shiftId)));
  let cash = 0, card = 0, transfer = 0, tips = 0;
  let expensesCash = 0, expensesCard = 0, expensesTransfer = 0;
  salesSnap.forEach((d) => {
    const s = d.data();
    tips += s.tip || 0;
    s.payments.forEach((p) => {
      if (p.method === "efectivo") cash += p.amount;
      if (p.method === "tarjeta") card += p.amount;
      if (p.method === "transferencia") transfer += p.amount;
    });
  });
  expSnap.forEach((d) => {
    const e = d.data();
    if (e.method === "efectivo") expensesCash += e.amount;
    else if (e.method === "tarjeta") expensesCard += e.amount;
    else if (e.method === "transferencia") expensesTransfer += e.amount;
  });
  const expenses = expensesCash + expensesCard + expensesTransfer;
  const shiftSnap = await getDoc(docRef("shifts", shiftId));
  const initialCash = shiftSnap.data().initialCash || 0;
  // Solo los egresos pagados EN EFECTIVO salen físicamente de la caja;
  // los pagados con tarjeta/transferencia no afectan el efectivo esperado.
  const expectedCash = initialCash + cash - expensesCash;
  return { cash, card, transfer, expenses, expensesCash, tips, expectedCash };
}

/* ============================================================
   EGRESOS
   ============================================================ */
async function loadExpenseCategories() {
  let snap = await getDocs(query(col("expenseCategories"), orderBy("name")));
  if (snap.empty) {
    const defaults = ["Insumos frescos", "Mantenimiento", "Domicilios / transporte", "Pagos menores", "Otro"];
    for (const name of defaults) await addDoc(col("expenseCategories"), { name });
    snap = await getDocs(query(col("expenseCategories"), orderBy("name")));
  }
  state.expenseCategories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const sel = document.getElementById("expCategory");
  if (sel) sel.innerHTML = state.expenseCategories.map((c) => `<option value="${c.name}">${c.name}</option>`).join("");
}

document.getElementById("expenseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await loadOpenShift();
  if (!state.shift) return toast("Debes abrir un turno de caja primero", "error");
  await addDoc(col("expenses"), {
    amount: parseFloat(document.getElementById("expAmount").value) || 0,
    category: document.getElementById("expCategory").value,
    method: document.getElementById("expMethod").value,
    description: document.getElementById("expDescription").value,
    registeredBy: state.user.id,
    shiftId: state.shift.id,
    createdAt: serverTimestamp(),
  });
  document.getElementById("expAmount").value = "";
  document.getElementById("expDescription").value = "";
  toast("Egreso registrado", "ok");
});

/* ============================================================
   DESAYUNOS HOTEL
   Se registran a diario en su propia colección (hotelBreakfasts),
   SIN tocar "sales" — por eso no afectan la caja del día. Solo se
   convierten en un ingreso real de caja el día que el hotel paga,
   momento en el que sí se crea una venta normal en "sales".
   ============================================================ */
const BREAKFAST_PRICE = 15000;

async function renderBreakfastScreen() {
  showScreen("screen-breakfast");
  const snap = await getDocs(query(col("hotelBreakfasts"), where("paid", "==", false)));
  const pending = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const totalQty = pending.reduce((s, p) => s + p.qty, 0);
  const totalAmount = pending.reduce((s, p) => s + p.total, 0);

  document.getElementById("breakfastPendingTotal").textContent = cop(totalAmount);
  document.getElementById("breakfastPendingCount").textContent = `${totalQty} desayuno(s) sin cobrar`;

  const rows = pending
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((p) => `<tr><td>${p.date}</td><td>${p.qty}</td><td>${cop(p.total)}</td></tr>`)
    .join("");
  document.getElementById("breakfastHistoryTable").innerHTML = `<table class="data">
    <thead><tr><th>Fecha</th><th>Cantidad</th><th>Valor</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="3" class="text-cream/40 text-center py-6">No hay desayunos pendientes por cobrar</td></tr>`}</tbody>
  </table>`;
}

document.getElementById("breakfastForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const qty = parseFloat(document.getElementById("breakfastQty").value) || 0;
  if (qty <= 0) return;
  const today = new Date().toLocaleDateString("es-CO");
  await addDoc(col("hotelBreakfasts"), {
    date: today, qty, unitPrice: BREAKFAST_PRICE, total: qty * BREAKFAST_PRICE,
    paid: false, createdBy: state.user.id, createdAt: serverTimestamp(),
  });
  document.getElementById("breakfastQty").value = "";
  toast(`${qty} desayuno(s) registrados — no afecta la caja de hoy`, "info");
  renderBreakfastScreen();
});

document.getElementById("registerBreakfastPaymentBtn").addEventListener("click", async () => {
  const snap = await getDocs(query(col("hotelBreakfasts"), where("paid", "==", false)));
  const pending = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const totalAmount = pending.reduce((s, p) => s + p.total, 0);
  if (!pending.length) return toast("No hay desayunos pendientes por cobrar", "info");
  document.getElementById("breakfastPaymentAmount").value = totalAmount;
  openModal("modalBreakfastPayment");
});
document.getElementById("cancelBreakfastPayment").addEventListener("click", () => closeModal("modalBreakfastPayment"));

document.getElementById("confirmBreakfastPayment").addEventListener("click", async () => {
  if (!state.shift) return toast("Debes abrir un turno de caja primero", "error");
  const amount = parseFloat(document.getElementById("breakfastPaymentAmount").value) || 0;
  const method = document.getElementById("breakfastPaymentMethod").value;

  const snap = await getDocs(query(col("hotelBreakfasts"), where("paid", "==", false)));
  const pending = snap.docs;

  const batch = writeBatch(db);
  const saleRef = doc(col("sales"));
  batch.set(saleRef, {
    isHotelBreakfastPayment: true,
    subtotal: amount, tip: 0, total: amount,
    payments: [{ method, amount }],
    cashierId: state.user.id,
    shiftId: state.shift.id,
    createdAt: serverTimestamp(),
  });
  pending.forEach((d) => batch.update(d.ref, { paid: true, paidAt: serverTimestamp(), paymentSaleId: saleRef.id }));
  await batch.commit();

  closeModal("modalBreakfastPayment");
  toast("Pago del hotel registrado — ya se sumó a la caja de hoy", "ok");
  renderBreakfastScreen();
});

/* ============================================================
   ADMINISTRACIÓN
   ============================================================ */
async function renderAdminScreen() {
  showScreen("screen-admin");
  await Promise.all([loadCategoriesAndProducts(), loadAllProductsForAdmin(), loadExpenseCategories(), loadBaseFija()]);
  renderAdminCategories();
  renderExpenseCategoriesChips();
  document.getElementById("baseFijaInput").value = state.baseFija || "";
  renderAdminProducts();
  renderLowStockBanner();
  renderShiftHistory();
  renderDailyCashSummary();
}

function renderAdminCategories() {
  const wrap = document.getElementById("categoriesTable");
  if (!wrap) return;
  const rows = state.categories.map((c) => `<tr>
    <td>${c.name}</td>
    <td>
      <select class="input catDeptSelect" data-id="${c.id}">
        <option value="bar" ${(c.department || "bar") === "bar" ? "selected" : ""}>Bar</option>
        <option value="cocina" ${c.department === "cocina" ? "selected" : ""}>Cocina</option>
      </select>
    </td>
    <td><button class="deleteCategoryBtn text-danger/70 hover:text-danger text-xs" data-id="${c.id}">Eliminar</button></td>
  </tr>`).join("");
  wrap.innerHTML = `<table class="data">
    <thead><tr><th>Categoría</th><th>Departamento</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="3" class="text-cream/40 text-center py-6">Aún no hay categorías</td></tr>`}</tbody>
  </table>`;

  wrap.querySelectorAll(".catDeptSelect").forEach((sel) =>
    sel.addEventListener("change", async () => {
      await updateDoc(docRef("categories", sel.dataset.id), { department: sel.value });
      toast("Departamento actualizado", "ok");
      await loadCategoriesAndProducts();
    }));
  wrap.querySelectorAll(".deleteCategoryBtn").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("¿Eliminar esta categoría? Los productos que la usan quedarán sin categoría visible.")) return;
      await deleteDoc(docRef("categories", b.dataset.id));
      toast("Categoría eliminada", "info");
      await loadCategoriesAndProducts();
      renderAdminCategories();
    }));
}

document.getElementById("categoryForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("newCategoryName");
  const name = input.value.trim();
  if (!name) return;
  const department = document.getElementById("newCategoryDept").value;
  await addDoc(col("categories"), { name, type: "otro", department, order: state.categories.length + 1 });
  input.value = "";
  toast("Categoría creada", "ok");
  await loadCategoriesAndProducts();
  renderAdminCategories();
});

/* ---- Categorías de egresos ---- */
function renderExpenseCategoriesChips() {
  const wrap = document.getElementById("expenseCategoriesChips");
  if (!wrap) return;
  wrap.innerHTML = state.expenseCategories.map((c) =>
    `<span class="chip active flex items-center gap-2">${c.name}
      <button class="deleteExpenseCatBtn text-danger/70 hover:text-danger" data-id="${c.id}">✕</button>
    </span>`).join("") || `<span class="text-cream/40 text-sm">Aún no hay categorías de egresos</span>`;

  wrap.querySelectorAll(".deleteExpenseCatBtn").forEach((b) =>
    b.addEventListener("click", async () => {
      await deleteDoc(docRef("expenseCategories", b.dataset.id));
      toast("Categoría de egreso eliminada", "info");
      await loadExpenseCategories();
      renderExpenseCategoriesChips();
    }));
}

document.getElementById("expenseCategoryForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("newExpenseCategoryName");
  const name = input.value.trim();
  if (!name) return;
  await addDoc(col("expenseCategories"), { name });
  input.value = "";
  toast("Categoría de egreso creada", "ok");
  await loadExpenseCategories();
  renderExpenseCategoriesChips();
});

/* ---- Base fija de caja ---- */
document.getElementById("saveBaseFijaBtn")?.addEventListener("click", async () => {
  const val = parseFloat(document.getElementById("baseFijaInput").value) || 0;
  await setDoc(docRef("settings", "caja"), { baseFija: val }, { merge: true });
  state.baseFija = val;
  toast("Base fija guardada", "ok");
});

// A diferencia de loadCategoriesAndProducts (que solo trae productos
// ACTIVOS para vender), aquí traemos también los inactivos, para que
// el administrador pueda reactivarlos si los desactivó por error.
async function loadAllProductsForAdmin() {
  const snap = await getDocs(col("products"));
  state.adminProducts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function renderAdminProducts() {
  const wrap = document.getElementById("adminProductsTable");
  const rows = state.adminProducts.map((p) => {
    const isEditing = state.editingProductId === p.id;
    const cat = state.categories.find((c) => c.id === p.categoryId)?.name || "—";

    if (isEditing) {
      const catOptions = state.categories.map((c) =>
        `<option value="${c.id}" ${c.id === p.categoryId ? "selected" : ""}>${c.name}</option>`).join("");
      const taxOptions = ["IVA 19%", "IVA 5%", "INC 8%", "Exento"].map((t) =>
        `<option value="${t}" ${p.taxType === t ? "selected" : ""}>${t}</option>`).join("");
      return `<tr class="bg-gold/5">
        <td><input class="input inlineName" value="${p.name || ""}" /></td>
        <td><select class="input inlineCategory">${catOptions}</select></td>
        <td><input type="number" class="input inlinePrice" value="${p.price || 0}" /></td>
        <td><input type="number" class="input inlineCost" value="${p.cost || 0}" /></td>
        <td><select class="input inlineTax">${taxOptions}</select></td>
        <td><input type="number" class="input inlineStock" value="${p.currentStock ?? ""}" placeholder="—" /></td>
        <td><span class="chip ${p.active ? "active" : ""}">${p.active ? "Activo" : "Inactivo"}</span></td>
        <td class="flex gap-2">
          <button class="saveInlineBtn text-success/80 hover:text-success text-xs" data-id="${p.id}">Guardar ✓</button>
          <button class="cancelInlineBtn text-cream/50 hover:text-cream text-xs" data-id="${p.id}">Cancelar</button>
        </td>
      </tr>`;
    }

    const margin = (p.price || 0) - (p.cost || 0);
    const marginPct = p.price ? Math.round((margin / p.price) * 100) : 0;
    return `<tr>
      <td>${p.name}</td><td>${cat}</td><td>${cop(p.price)}</td>
      <td>${cop(margin)} <span class="text-cream/40 text-xs">(${marginPct}%)</span></td>
      <td>${p.taxType || "—"}</td>
      <td>${p.currentStock !== undefined ? p.currentStock : "por receta"}</td>
      <td><span class="chip ${p.active ? "active" : ""}">${p.active ? "Activo" : "Inactivo"}</span></td>
      <td class="flex gap-2">
        <button class="editRowBtn text-gold/70 hover:text-gold" data-id="${p.id}" title="Editar">✎</button>
        ${p.currentStock !== undefined ? `<button class="restockBtn text-xs text-success/70 hover:text-success" data-id="${p.id}">Reabastecer</button>` : ""}
        <button class="toggleProductBtn text-xs ${p.active ? "text-danger/70 hover:text-danger" : "text-success/70 hover:text-success"}" data-id="${p.id}">
          ${p.active ? "Desactivar" : "Reactivar"}
        </button>
      </td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table class="data">
    <thead><tr><th>Producto</th><th>Categoría</th><th>Precio</th><th>Margen / Impuesto</th><th></th><th>Stock</th><th>Estado</th><th>Acciones</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8" class="text-cream/40 text-center py-6">Aún no hay productos</td></tr>`}</tbody>
  </table>`;

  wrap.querySelectorAll(".editRowBtn").forEach((b) =>
    b.addEventListener("click", () => { state.editingProductId = b.dataset.id; renderAdminProducts(); }));
  wrap.querySelectorAll(".cancelInlineBtn").forEach((b) =>
    b.addEventListener("click", () => { state.editingProductId = null; renderAdminProducts(); }));
  wrap.querySelectorAll(".saveInlineBtn").forEach((b) =>
    b.addEventListener("click", (e) => saveInlineEdit(e.target.closest("tr"), b.dataset.id)));
  wrap.querySelectorAll(".toggleProductBtn").forEach((b) =>
    b.addEventListener("click", () => toggleProductActive(b.dataset.id)));
  wrap.querySelectorAll(".restockBtn").forEach((b) =>
    b.addEventListener("click", () => openRestockModal(b.dataset.id)));
}

function openRestockModal(productId) {
  const p = state.adminProducts.find((x) => x.id === productId);
  state.restockingProductId = productId;
  document.getElementById("restockProductName").textContent =
    `${p.name} · stock actual: ${p.currentStock} · costo actual: ${cop(p.cost)}`;
  document.getElementById("restockQty").value = "";
  document.getElementById("restockUnitCost").value = "";
  document.getElementById("restockPreview").textContent = "";
  openModal("modalRestock");
}

function updateRestockPreview() {
  const p = state.adminProducts.find((x) => x.id === state.restockingProductId);
  const qty = parseFloat(document.getElementById("restockQty").value) || 0;
  const unitCost = parseFloat(document.getElementById("restockUnitCost").value) || 0;
  if (!qty || !p) { document.getElementById("restockPreview").textContent = ""; return; }
  const newStock = (p.currentStock || 0) + qty;
  const newAvgCost = ((p.currentStock || 0) * (p.cost || 0) + qty * unitCost) / newStock;
  document.getElementById("restockPreview").textContent =
    `Nuevo stock: ${newStock} · Nuevo costo promedio: ${cop(newAvgCost)}`;
}
document.getElementById("restockQty").addEventListener("input", updateRestockPreview);
document.getElementById("restockUnitCost").addEventListener("input", updateRestockPreview);
document.getElementById("cancelRestock").addEventListener("click", () => closeModal("modalRestock"));

document.getElementById("confirmRestock").addEventListener("click", async () => {
  const p = state.adminProducts.find((x) => x.id === state.restockingProductId);
  const qty = parseFloat(document.getElementById("restockQty").value) || 0;
  const unitCost = parseFloat(document.getElementById("restockUnitCost").value) || 0;
  if (qty <= 0) return toast("Ingresa una cantidad válida", "error");
  const newStock = (p.currentStock || 0) + qty;
  // Costo promedio ponderado: mezcla lo que ya tenías en existencia
  // con lo nuevo que compraste, sin perder de vista cuánto cuesta
  // realmente cada unidad en bodega en promedio.
  const newAvgCost = ((p.currentStock || 0) * (p.cost || 0) + qty * unitCost) / newStock;
  await updateDoc(docRef("products", p.id), { currentStock: newStock, cost: newAvgCost });
  toast(`Stock actualizado: ${newStock} unidades · costo promedio ${cop(newAvgCost)}`, "ok");
  closeModal("modalRestock");
  await Promise.all([loadCategoriesAndProducts(), loadAllProductsForAdmin()]);
  renderAdminProducts();
  renderLowStockBanner();
});

async function saveInlineEdit(row, productId) {
  const stockVal = row.querySelector(".inlineStock").value;
  const data = {
    name: row.querySelector(".inlineName").value,
    categoryId: row.querySelector(".inlineCategory").value,
    price: parseFloat(row.querySelector(".inlinePrice").value) || 0,
    cost: parseFloat(row.querySelector(".inlineCost").value) || 0,
    taxType: row.querySelector(".inlineTax").value,
  };
  if (stockVal !== "") {
    data.currentStock = parseFloat(stockVal) || 0;
  }
  await updateDoc(docRef("products", productId), data);
  state.editingProductId = null;
  toast("Producto actualizado", "ok");
  await Promise.all([loadCategoriesAndProducts(), loadAllProductsForAdmin()]);
  renderAdminProducts();
  renderLowStockBanner();
}

async function toggleProductActive(productId) {
  const p = state.adminProducts.find((x) => x.id === productId);
  await updateDoc(docRef("products", productId), { active: !p.active });
  toast(p.active ? "Producto desactivado" : "Producto reactivado", "info");
  await loadAllProductsForAdmin();
  renderAdminProducts();
  await loadCategoriesAndProducts();
}

function openProductModal() {
  const sel = document.getElementById("pCategory");
  sel.innerHTML = state.categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  document.getElementById("productForm").reset();
  document.querySelector("#modalProduct h3").textContent = "Nuevo producto";
  state.editingProductId = null;
  document.getElementById("pStock").classList.add("hidden");
  document.getElementById("pMinStock").classList.add("hidden");
  openModal("modalProduct");
}

async function renderLowStockBanner() {
  const low = state.adminProducts.filter((p) => p.active && p.currentStock !== undefined && p.currentStock <= (p.minStockAlert ?? 0));
  const banner = document.getElementById("lowStockBanner");
  if (low.length) {
    banner.classList.remove("hidden");
    banner.textContent = `⚠ ${low.length} producto(s) con stock bajo: ${low.map((p) => p.name).join(", ")}`;
  } else banner.classList.add("hidden");
}

async function renderShiftHistory() {
  const snap = await getDocs(query(col("shifts"), where("status", "==", "cerrado"), orderBy("closedAt", "desc"), limit(15)));
  const rows = snap.docs.map((d) => {
    const s = d.data();
    const date = s.closedAt?.toDate ? s.closedAt.toDate().toLocaleString("es-CO") : "—";
    return `<tr>
      <td>${date}</td><td>${cop(s.totals?.cash)}</td><td>${cop(s.totals?.card)}</td>
      <td>${cop(s.totals?.transfer)}</td><td>${cop(s.totals?.expenses)}</td>
      <td>${cop(s.totals?.tips)}</td>
      <td class="${s.totals?.difference === 0 ? "text-success" : "text-warn"}">${cop(s.totals?.difference)}</td>
      <td><button class="deleteShiftBtn text-danger/70 hover:text-danger text-xs" data-id="${d.id}">Eliminar</button></td>
    </tr>`;
  }).join("");
  document.getElementById("shiftHistoryTable").innerHTML = `<table class="data">
    <thead><tr><th>Cierre</th><th>Efectivo</th><th>Tarjeta</th><th>Transferencia</th><th>Egresos</th><th>Propinas</th><th>Diferencia</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8" class="text-cream/40 text-center py-6">Sin cierres registrados</td></tr>`}</tbody>
  </table>`;

  document.querySelectorAll(".deleteShiftBtn").forEach((b) =>
    b.addEventListener("click", () => {
      if (!confirm("¿Eliminar este cierre de caja registrado? Esta acción no se puede deshacer.")) return;
      deleteDoc(docRef("shifts", b.dataset.id)).then(() => {
        toast("Cierre eliminado", "info");
        renderShiftHistory();
      });
    }));
}

/* ---- Caja del día: solo visible para el administrador ---- */
async function renderDailyCashSummary() {
  const wrap = document.getElementById("dailyCashSummary");
  if (!wrap) return;
  wrap.innerHTML = `<p class="text-cream/40 text-sm">Calculando...</p>`;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const snap = await getDocs(query(col("sales"), where("createdAt", ">=", Timestamp.fromDate(startOfToday))));
  let cash = 0, card = 0, transfer = 0, tips = 0, count = 0;
  snap.forEach((d) => {
    const s = d.data();
    tips += s.tip || 0;
    count += 1;
    (s.payments || []).forEach((p) => {
      if (p.method === "efectivo") cash += p.amount;
      if (p.method === "tarjeta") card += p.amount;
      if (p.method === "transferencia") transfer += p.amount;
    });
  });
  const total = cash + card + transfer;

  wrap.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
      <div><p class="text-cream/50">Efectivo hoy</p><p class="text-lg text-goldsoft">${cop(cash)}</p></div>
      <div><p class="text-cream/50">Tarjeta hoy</p><p class="text-lg text-goldsoft">${cop(card)}</p></div>
      <div><p class="text-cream/50">Transferencia hoy</p><p class="text-lg text-goldsoft">${cop(transfer)}</p></div>
      <div><p class="text-cream/50">Total del día</p><p class="text-lg text-goldsoft">${cop(total)}</p></div>
    </div>
    <p class="text-cream/40 text-xs mt-3">${count} venta(s) registradas hoy · Propinas acumuladas: ${cop(tips)}</p>
    <button id="refreshDailyCash" class="btn-outline text-xs mt-3">Actualizar</button>`;
  document.getElementById("refreshDailyCash").addEventListener("click", renderDailyCashSummary);
}

/* ---- Modal para crear producto nuevo (la edición es inline en la tabla) ---- */
document.getElementById("newProductBtn").addEventListener("click", () => openProductModal());
document.getElementById("cancelProduct").addEventListener("click", () => closeModal("modalProduct"));
document.getElementById("pTracksStock").addEventListener("change", (e) => {
  document.getElementById("pStock").classList.toggle("hidden", !e.target.checked);
  document.getElementById("pMinStock").classList.toggle("hidden", !e.target.checked);
});

document.getElementById("productForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tracksStock = document.getElementById("pTracksStock").checked;
  const data = {
    name: document.getElementById("pName").value,
    categoryId: document.getElementById("pCategory").value,
    price: parseFloat(document.getElementById("pPrice").value) || 0,
    cost: parseFloat(document.getElementById("pCost").value) || 0,
    taxType: document.getElementById("pTax").value,
    isRecipe: false, // las recetas con múltiples ingredientes se asocian luego en /recipes
    active: true,
  };
  if (tracksStock) {
    data.currentStock = parseFloat(document.getElementById("pStock").value) || 0;
    data.minStockAlert = parseFloat(document.getElementById("pMinStock").value) || 0;
  }

  await addDoc(col("products"), data);
  toast("Producto creado", "ok");
  closeModal("modalProduct");
  await Promise.all([loadCategoriesAndProducts(), loadAllProductsForAdmin()]);
  renderAdminProducts();
  renderLowStockBanner();
});

/* ============================================================
   LOGOUT
   ============================================================ */
document.getElementById("logoutBtn").addEventListener("click", logout);

/* ============================================================
   INICIO
   ============================================================ */
renderKeypad();
showScreen("screen-login");

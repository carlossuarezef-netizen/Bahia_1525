import { db, ORG_ID } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc,
  query, where, orderBy, limit, onSnapshot, runTransaction,
  serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

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
  products: [],
  tables: [],
  currentTable: null,
  currentOrder: null,    // { id, tableId, items: [] }
  activeCategory: null,
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
    div.innerHTML = `<span>Mesa ${t.number}</span><span class="text-xs uppercase tracking-wide opacity-70">${t.status.replace("_"," ")}</span>`;
    div.addEventListener("click", () => openTable(t));
    grid.appendChild(div);
  });
  showScreen("screen-tables");
}

async function openTable(table) {
  state.currentTable = table;
  document.getElementById("posTableLabel").textContent = `Mesa ${table.number}`;

  // Buscar orden abierta para esta mesa, o crear una nueva
  const snap = await getDocs(query(col("orders"), where("tableId", "==", table.id), where("status", "in", ["abierta", "en_cocina", "servida"])));
  if (!snap.empty) {
    const d = snap.docs[0];
    state.currentOrder = { id: d.id, ...d.data() };
  } else {
    const newOrder = {
      tableId: table.id,
      waiterId: state.user.id,
      status: "abierta",
      items: [],
      createdAt: serverTimestamp(),
    };
    const ref = await addDoc(col("orders"), newOrder);
    state.currentOrder = { id: ref.id, ...newOrder, items: [] };
    await updateDoc(docRef("tables", table.id), { status: "ocupada" });
  }
  state.activeCategory = state.categories[0]?.id || null;
  renderCategoryTabs();
  renderProductsGrid();
  renderCart();
  showScreen("screen-pos");
}

document.getElementById("backToTables").addEventListener("click", () => loadTables());

async function releaseTable() {
  const doRelease = async () => {
    await setDoc(docRef("orders", state.currentOrder.id), { status: "cancelada" }, { merge: true });
    await updateDoc(docRef("tables", state.currentTable.id), { status: "libre" });
    toast("Mesa liberada", "info");
    loadTables();
  };
  if (state.currentOrder.items.length === 0) {
    doRelease();
  } else {
    requireAnyPin(doRelease);
  }
}
document.getElementById("releaseTableBtn").addEventListener("click", releaseTable);

/* ============================================================
   CATEGORÍAS Y PRODUCTOS
   ============================================================ */
async function loadCategoriesAndProducts() {
  let catSnap = await getDocs(query(col("categories"), orderBy("order")));
  if (catSnap.empty) {
    const defaults = [
      { name: "Cócteles de autor", type: "coctel", order: 1 },
      { name: "Bebidas", type: "bebida", order: 2 },
      { name: "Platos", type: "plato", order: 3 },
    ];
    for (const c of defaults) await addDoc(col("categories"), c);
    catSnap = await getDocs(query(col("categories"), orderBy("order")));
  }
  state.categories = catSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const prodSnap = await getDocs(query(col("products"), where("active", "==", true)));
  state.products = prodSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function renderCategoryTabs() {
  const wrap = document.getElementById("categoryTabs");
  wrap.innerHTML = "";
  state.categories.forEach((c) => {
    const b = document.createElement("button");
    b.className = `chip whitespace-nowrap ${state.activeCategory === c.id ? "active" : ""}`;
    b.textContent = c.name;
    b.addEventListener("click", () => { state.activeCategory = c.id; renderCategoryTabs(); renderProductsGrid(); });
    wrap.appendChild(b);
  });
}

function renderProductsGrid() {
  const grid = document.getElementById("productsGrid");
  grid.innerHTML = "";
  state.products
    .filter((p) => p.categoryId === state.activeCategory)
    .forEach((p) => {
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

    if (document.getElementById("needsInvoice").checked) {
      await addDoc(col("invoices"), {
        saleId: saleRef.id,
        clientData: {
          docNumber: document.getElementById("invDoc").value,
          name: document.getElementById("invName").value,
          email: document.getElementById("invEmail").value,
        },
        dianStatus: "pendiente",
        createdAt: serverTimestamp(),
      });
      toast("Venta registrada. Factura en proceso de emisión ante la DIAN.", "ok");
    } else {
      toast("Venta registrada con éxito", "ok");
    }

    closeModal("modalCheckout");
    await loadCategoriesAndProducts();
    loadTables();
  } catch (err) {
    console.error(err);
    toast("Error al procesar la venta", "error");
  }
}

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
async function loadOpenShift() {
  const snap = await getDocs(query(col("shifts"), where("status", "==", "abierto"), limit(1)));
  state.shift = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function renderShiftScreen() {
  showScreen("screen-shift");
  const wrap = document.getElementById("shiftContent");
  await loadOpenShift();

  if (!state.shift) {
    wrap.innerHTML = `
      <p class="text-cream/70 mb-4">No hay un turno abierto. Ingresa la base inicial de caja para comenzar.</p>
      <input type="number" id="initialCash" class="input mb-4" placeholder="Base inicial en efectivo" />
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
  wrap.innerHTML = `
    <div class="grid grid-cols-2 gap-4 text-sm mb-6">
      <div><p class="text-cream/50">Base inicial</p><p class="text-lg text-goldsoft">${cop(state.shift.initialCash)}</p></div>
      <div><p class="text-cream/50">Ventas efectivo</p><p class="text-lg text-goldsoft">${cop(totals.cash)}</p></div>
      <div><p class="text-cream/50">Ventas tarjeta</p><p class="text-lg text-goldsoft">${cop(totals.card)}</p></div>
      <div><p class="text-cream/50">Ventas transferencia</p><p class="text-lg text-goldsoft">${cop(totals.transfer)}</p></div>
      <div><p class="text-cream/50">Egresos</p><p class="text-lg text-goldsoft">${cop(totals.expenses)}</p></div>
      <div><p class="text-cream/50">Efectivo esperado</p><p class="text-lg text-goldsoft">${cop(totals.expectedCash)}</p></div>
    </div>
    <label class="label">Efectivo real contado</label>
    <input type="number" id="actualCash" class="input mb-4" placeholder="0" />
    <button id="closeShiftBtn" class="btn-primary w-full">Cerrar caja</button>`;

  document.getElementById("closeShiftBtn").addEventListener("click", () => {
    requireAdminPin(async () => {
      const actualCash = parseFloat(document.getElementById("actualCash").value) || 0;
      const difference = actualCash - totals.expectedCash;
      await updateDoc(docRef("shifts", state.shift.id), {
        status: "cerrado", closedAt: serverTimestamp(), closedBy: state.user.id,
        totals: { ...totals, actualCash, difference },
      });
      toast(`Caja cerrada. Diferencia: ${cop(difference)}`, difference === 0 ? "ok" : "info");
      state.shift = null;
      renderShiftScreen();
    });
  });
}

async function computeShiftTotals(shiftId) {
  const salesSnap = await getDocs(query(col("sales"), where("shiftId", "==", shiftId)));
  const expSnap = await getDocs(query(col("expenses"), where("shiftId", "==", shiftId)));
  let cash = 0, card = 0, transfer = 0, expenses = 0;
  salesSnap.forEach((d) => d.data().payments.forEach((p) => {
    if (p.method === "efectivo") cash += p.amount;
    if (p.method === "tarjeta") card += p.amount;
    if (p.method === "transferencia") transfer += p.amount;
  }));
  expSnap.forEach((d) => { expenses += d.data().amount; });
  const shiftSnap = await getDoc(docRef("shifts", shiftId));
  const initialCash = shiftSnap.data().initialCash || 0;
  const expectedCash = initialCash + cash - expenses;
  return { cash, card, transfer, expenses, expectedCash };
}

/* ============================================================
   EGRESOS
   ============================================================ */
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
  e.target.reset();
  toast("Egreso registrado", "ok");
});

/* ============================================================
   ADMINISTRACIÓN
   ============================================================ */
async function renderAdminScreen() {
  showScreen("screen-admin");
  await loadCategoriesAndProducts();
  renderAdminProducts();
  await renderLowStockBanner();
  await renderShiftHistory();
}

function renderAdminProducts() {
  const wrap = document.getElementById("adminProductsTable");
  const rows = state.products.map((p) => {
    const cat = state.categories.find((c) => c.id === p.categoryId)?.name || "—";
    return `<tr>
      <td>${p.name}</td><td>${cat}</td><td>${cop(p.price)}</td>
      <td>${p.currentStock !== undefined ? p.currentStock : "por receta"}</td>
      <td><span class="chip ${p.active ? "active" : ""}">${p.active ? "Activo" : "Inactivo"}</span></td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table class="data">
    <thead><tr><th>Producto</th><th>Categoría</th><th>Precio</th><th>Stock</th><th>Estado</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="text-cream/40 text-center py-6">Aún no hay productos</td></tr>`}</tbody>
  </table>`;
}

async function renderLowStockBanner() {
  const low = state.products.filter((p) => p.currentStock !== undefined && p.currentStock <= (p.minStockAlert ?? 0));
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
      <td class="${s.totals?.difference === 0 ? "text-success" : "text-warn"}">${cop(s.totals?.difference)}</td>
    </tr>`;
  }).join("");
  document.getElementById("shiftHistoryTable").innerHTML = `<table class="data">
    <thead><tr><th>Cierre</th><th>Efectivo</th><th>Tarjeta</th><th>Transferencia</th><th>Egresos</th><th>Diferencia</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="text-cream/40 text-center py-6">Sin cierres registrados</td></tr>`}</tbody>
  </table>`;
}

/* ---- Modal nuevo producto ---- */
document.getElementById("newProductBtn").addEventListener("click", () => {
  const sel = document.getElementById("pCategory");
  sel.innerHTML = state.categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  document.getElementById("productForm").reset();
  document.getElementById("pStock").classList.add("hidden");
  document.getElementById("pMinStock").classList.add("hidden");
  openModal("modalProduct");
});
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
    active: true,
    isRecipe: false, // las recetas con múltiples ingredientes se asocian luego en /recipes
  };
  if (tracksStock) {
    data.currentStock = parseFloat(document.getElementById("pStock").value) || 0;
    data.minStockAlert = parseFloat(document.getElementById("pMinStock").value) || 0;
  }
  await addDoc(col("products"), data);
  closeModal("modalProduct");
  toast("Producto creado", "ok");
  await loadCategoriesAndProducts();
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

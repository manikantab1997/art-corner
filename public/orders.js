if (localStorage.getItem("isAdmin") !== "true") window.location.href = "login.html";
function goBack() { window.history.back(); }
let allOrders = [];
const tbody = document.querySelector("#ordersTable tbody");
tbody.innerHTML = '<tr><td colspan="6">Loading orders…</td></tr>';
async function loadOrders() {
  try {
    const response = await fetch("/api/orders");
    if (!response.ok) throw new Error("Orders could not be loaded.");
    allOrders = await response.json();
    renderOrders(allOrders);
  } catch (error) {
    console.error("Order list request failed:", error);
    tbody.innerHTML = '<tr><td colspan="6" role="alert">Orders are temporarily unavailable. Please refresh.</td></tr>';
  }
}
function renderOrders(orders) {
  tbody.innerHTML = "";
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="6">No matching orders.</td></tr>';
    return;
  }
  orders.forEach(order => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${order.orderId || ""}</td><td>${order.customer?.name || ""}</td><td>${order.customer?.phone || ""}</td><td>${(order.items || []).map(item => `${item.name || "Item"} (x${item.qty || 0})`).join("<br>")}</td><td>${order.status || ""}</td><td><select aria-label="Status for ${order.orderId}"><option ${order.status === "Placed" ? "selected" : ""}>Placed</option><option ${order.status === "Shipped" ? "selected" : ""}>Shipped</option><option ${order.status === "Delivered" ? "selected" : ""}>Delivered</option></select></td>`;
    const select = tr.querySelector("select");
    select.addEventListener("change", () => updateStatus(order.orderId, select.value));
    tbody.appendChild(tr);
  });
}
async function updateStatus(orderId, status) {
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Order status could not be updated.");
    await loadOrders();
  } catch (error) { alert(error.message || "Order status could not be updated."); }
}
document.getElementById("search").oninput = filterOrders;
document.getElementById("filter").onchange = filterOrders;
function filterOrders() {
  const query = document.getElementById("search").value.toLowerCase();
  const status = document.getElementById("filter").value;
  renderOrders(allOrders.filter(order =>
    String(order.orderId || "").toLowerCase().includes(query) ||
    String(order.customer?.name || "").toLowerCase().includes(query)
  ).filter(order => status === "all" || order.status === status));
}
loadOrders();

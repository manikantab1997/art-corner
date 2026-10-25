
function goBack() { window.history.back(); }
let allOrders = [];
const tbody = document.querySelector("#ordersTable tbody");
const notificationFeedback = document.getElementById("notificationFeedback");
tbody.innerHTML = '<tr><td colspan="7">Loading orders…</td></tr>';
async function loadOrders() {
  try {
    const response = await fetch("/api/orders");
    if (!response.ok) throw new Error("Orders could not be loaded.");
    allOrders = await response.json();
    renderOrders(allOrders);
  } catch (error) {
    console.error("Order list request failed:", error);
    tbody.innerHTML = '<tr><td colspan="7" role="alert">Orders are temporarily unavailable. Please refresh.</td></tr>';
  }
}
function renderOrders(orders) {
  tbody.innerHTML = "";
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="7">No matching orders.</td></tr>';
    return;
  }
  orders.forEach(order => {
    const tr = document.createElement("tr");
    const makeCell = value => {
      const cell = document.createElement("td");
      cell.textContent = value == null ? "" : String(value);
      return cell;
    };
    tr.appendChild(makeCell(order.orderId || ""));
    tr.appendChild(makeCell(order.customer?.name || ""));
    tr.appendChild(makeCell(order.customer?.phone || ""));

    const itemsCell = document.createElement("td");
    (Array.isArray(order.items) ? order.items : []).forEach(item => {
      const line = document.createElement("div");
      line.textContent = `${item?.name || "Item"} (x${item?.qty || 0})`;
      itemsCell.appendChild(line);
    });
    tr.appendChild(itemsCell);
    tr.appendChild(makeCell(order.status || ""));

    const statusCell = document.createElement("td");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Order status");
    ["Placed", "Shipped", "Delivered"].forEach(status => {
      const option = document.createElement("option");
      option.value = status;
      option.textContent = status;
      select.appendChild(option);
    });
    if (["Placed", "Shipped", "Delivered"].includes(order.status)) select.value = order.status;
    statusCell.appendChild(select);
    tr.appendChild(statusCell);
    select.addEventListener("change", () => updateStatus(order.orderId, select.value));
    const notificationStatus = order.whatsappNotificationStatus || "not_configured";
    const noticeCell = makeCell(notificationStatus);
    tr.appendChild(noticeCell);
    if (["pending", "failed", "not_configured"].includes(order.whatsappNotificationStatus)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry notice";
      retry.addEventListener("click", () => retryWhatsAppNotice(order.orderId));
      noticeCell.appendChild(retry);
    } else if (["unknown", "sending"].includes(order.whatsappNotificationStatus) && Date.now() - new Date(order.whatsappNotificationAttemptedAt || 0).getTime() >= 5 * 60 * 1000) {
      const reconcile = document.createElement("button");
      reconcile.type = "button";
      reconcile.textContent = "Confirm sent";
      reconcile.addEventListener("click", () => confirmWhatsAppSent(order.orderId));
      noticeCell.appendChild(reconcile);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Confirm not sent and retry";
      retry.addEventListener("click", () => confirmNotSentAndRetry(order.orderId));
      noticeCell.append(" Check Meta delivery records first. ");
      noticeCell.appendChild(retry);
    }
    tbody.appendChild(tr);
  });
}
async function retryWhatsAppNotice(orderId) {
  notificationFeedback.textContent = "Retrying notification…";
  try {
    const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/whatsapp-notification/retry`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Notification retry failed.");
    notificationFeedback.textContent = "WhatsApp notification sent.";
    await loadOrders();
  } catch (error) { notificationFeedback.textContent = error.message || "Notification retry failed."; }
}
async function confirmWhatsAppSent(orderId) {
  if (!confirm("Only continue after checking Meta delivery records and confirming this order notification was delivered.")) return;
  notificationFeedback.textContent = "Reconciling notification…";
  try {
    const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/whatsapp-notification/confirm-sent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Notification reconciliation failed.");
    notificationFeedback.textContent = "Notification marked as sent.";
    await loadOrders();
  } catch (error) { notificationFeedback.textContent = error.message || "Notification reconciliation failed."; }
}
async function confirmNotSentAndRetry(orderId) {
  if (!confirm("Only continue after checking Meta delivery records and confirming no message was accepted or delivered. A new notification will be sent.")) return;
  notificationFeedback.textContent = "Reconciling and retrying notification…";
  try {
    const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/whatsapp-notification/confirm-not-sent-retry`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmedNotSent: true })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Notification reconciliation failed.");
    notificationFeedback.textContent = "Notification retry completed.";
    await loadOrders();
  } catch (error) { notificationFeedback.textContent = error.message || "Notification reconciliation failed."; }
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
requireAdminPage().then(isAdmin => { if (isAdmin) loadOrders(); });

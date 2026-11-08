let allOrders = [];
const tbody = document.querySelector("#ordersTable tbody");
const notificationFeedback = document.getElementById("notificationFeedback");
const fulfillmentStatuses = ["Placed", "Preparing", "Shipped", "Delivered", "Cancelled"];
tbody.innerHTML = '<tr><td colspan="8">Loading orders…</td></tr>';

async function loadOrders() {
  try {
    const response = await fetch("/api/orders");
    if (!response.ok) throw new Error("Orders could not be loaded.");
    allOrders = await response.json();
    renderOrders(allOrders);
  } catch (error) {
    console.error("Order list request failed:", error);
    tbody.innerHTML = '<tr><td colspan="8" role="alert">Orders are temporarily unavailable. Please refresh.</td></tr>';
  }
}

function makeCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value == null ? "" : String(value);
  return cell;
}

function makeButton(label, callback) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", callback);
  return button;
}

function renderOrders(orders) {
  tbody.replaceChildren();
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="8">No matching orders.</td></tr>';
    return;
  }
  orders.forEach(order => {
    const tr = document.createElement("tr");
    const orderId = String(order.orderId || "");
    const displayedReference = typeof order.publicReference === "string" && order.publicReference
      ? order.publicReference : orderId ? `Legacy: ${orderId}` : "Reference unavailable";
    tr.append(makeCell(displayedReference), makeCell(order.customer?.name || ""), makeCell(order.customer?.phone || ""));

    const itemsCell = document.createElement("td");
    (Array.isArray(order.items) ? order.items : []).forEach(item => {
      const line = document.createElement("div");
      line.textContent = `${item?.name || "Item"} (x${item?.qty || 0})`;
      itemsCell.appendChild(line);
    });
    tr.appendChild(itemsCell);

    const paymentCell = makeCell(order.paymentStatus || "Legacy — payment state unavailable");
    if (Number.isFinite(order.paymentAmount)) {
      const amount = document.createElement("p");
      amount.textContent = `Amount: ₹${order.paymentAmount.toFixed(2)} ${order.currency || "INR"}`;
      paymentCell.appendChild(amount);
    }
    if (order.paymentReference) {
      const utr = document.createElement("p");
      utr.textContent = `UTR: ${order.paymentReference}`;
      paymentCell.appendChild(utr);
    }
    if (["Pending", "Verification Pending"].includes(order.paymentStatus)) {
      const referenceInput = document.createElement("input");
      referenceInput.type = "text";
      referenceInput.maxLength = 100;
      referenceInput.autocomplete = "off";
      referenceInput.placeholder = "UTR / transaction reference";
      referenceInput.setAttribute("aria-label", `UTR for ${displayedReference}`);
      const referenceButton = makeButton("Record UTR", () => updatePayment(orderId, "record_reference", referenceInput.value));
      const verifyButton = makeButton("Verify payment", () => updatePayment(orderId, "verify", referenceInput.value));
      const mismatchButton = makeButton("Flag mismatch", () => updatePayment(orderId, "mismatch", referenceInput.value));
      paymentCell.append(referenceInput, referenceButton, verifyButton, mismatchButton);
    }
    tr.appendChild(paymentCell);
    tr.appendChild(makeCell(order.status || ""));

    const statusCell = document.createElement("td");
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Fulfilment status for ${displayedReference}`);
    fulfillmentStatuses.forEach(status => {
      const option = document.createElement("option"); option.value = status; option.textContent = status; select.appendChild(option);
    });
    if (fulfillmentStatuses.includes(order.status)) select.value = order.status;
    statusCell.appendChild(select);
    select.addEventListener("change", () => updateStatus(orderId, select.value));
    tr.appendChild(statusCell);

    const noticeCell = makeCell(order.whatsappNotificationStatus || "not_configured");
    if (["pending", "failed", "not_configured"].includes(order.whatsappNotificationStatus)) {
      noticeCell.appendChild(makeButton("Retry admin notice", () => retryWhatsAppNotice(orderId)));
    } else if (["unknown", "sending"].includes(order.whatsappNotificationStatus) && Date.now() - new Date(order.whatsappNotificationAttemptedAt || 0).getTime() >= 5 * 60 * 1000) {
      noticeCell.append(makeButton("Confirm sent", () => confirmWhatsAppSent(orderId)), " Check Meta records first. ", makeButton("Confirm not sent and retry", () => confirmNotSentAndRetry(orderId)));
    }
    (Array.isArray(order.whatsappOutbox) ? order.whatsappOutbox : []).forEach(event => {
      const item = document.createElement("p");
      item.textContent = `${event.type}: ${event.status}`;
      noticeCell.appendChild(item);
      if (["pending", "failed", "not_configured"].includes(event.status)) noticeCell.appendChild(makeButton("Retry customer notice", () => retryCustomerNotice(orderId, event.key)));
      else if (["unknown", "sending"].includes(event.status) && Date.now() - new Date(event.attemptedAt || 0).getTime() >= 5 * 60 * 1000) {
        noticeCell.append(makeButton("Confirm customer notice sent", () => reconcileCustomerNotice(orderId, event.key, true)), " Check Meta records first. ", makeButton("Confirm not sent and retry", () => reconcileCustomerNotice(orderId, event.key, false)));
      }
    });
    tr.appendChild(noticeCell);
    tbody.appendChild(tr);
  });
}

async function requestOrderAction(url, body, method = "POST") {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The order action could not be completed.");
  return data;
}

async function updatePayment(orderId, action, paymentReference) {
  if (action === "verify" && !confirm("Confirm that you checked the UPI payment in the business account and the amount matches this order?")) return;
  if (action === "mismatch" && !confirm("Flag this payment as failed or mismatched? It will not be marked paid.")) return;
  notificationFeedback.textContent = "Updating payment…";
  try {
    const body = { action };
    if (paymentReference?.trim()) body.paymentReference = paymentReference.trim();
    await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/payment-verification`, body);
    notificationFeedback.textContent = action === "verify" ? "Payment verified; fulfilment is Preparing." : action === "mismatch" ? "Payment flagged for review." : "UTR recorded for verification.";
    await loadOrders();
  } catch (error) { notificationFeedback.textContent = error.message || "Payment update failed."; }
}

async function retryWhatsAppNotice(orderId) {
  notificationFeedback.textContent = "Retrying admin notification…";
  try { const result = await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/whatsapp-notification/retry`); notificationFeedback.textContent = `Admin notification: ${result.status}.`; await loadOrders(); }
  catch (error) { notificationFeedback.textContent = error.message || "Notification retry failed."; }
}
async function confirmWhatsAppSent(orderId) {
  if (!confirm("Only continue after checking Meta delivery records and confirming the admin notification was delivered.")) return;
  try { await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/whatsapp-notification/confirm-sent`, { confirmed: true }); notificationFeedback.textContent = "Admin notification marked sent."; await loadOrders(); }
  catch (error) { notificationFeedback.textContent = error.message || "Notification reconciliation failed."; }
}
async function confirmNotSentAndRetry(orderId) {
  if (!confirm("Only continue after checking Meta records and confirming no message was accepted or delivered.")) return;
  try { const result = await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/whatsapp-notification/confirm-not-sent-retry`, { confirmedNotSent: true }); notificationFeedback.textContent = `Admin notification: ${result.status}.`; await loadOrders(); }
  catch (error) { notificationFeedback.textContent = error.message || "Notification reconciliation failed."; }
}
async function retryCustomerNotice(orderId, key) {
  notificationFeedback.textContent = "Retrying customer notification…";
  try { const result = await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/notifications/${encodeURIComponent(key)}/retry`, {}); notificationFeedback.textContent = `Customer notification: ${result.status}.`; await loadOrders(); }
  catch (error) { notificationFeedback.textContent = error.message || "Customer notification retry failed."; }
}
async function reconcileCustomerNotice(orderId, key, sent) {
  const message = sent ? "Confirm the customer message was delivered after checking Meta records?" : "Confirm no message was accepted or delivered? A retry will follow.";
  if (!confirm(message)) return;
  const action = sent ? "confirm-sent" : "confirm-not-sent-retry";
  try { await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/notifications/${encodeURIComponent(key)}/${action}`, sent ? { confirmed: true } : { confirmedNotSent: true }); notificationFeedback.textContent = "Customer notification reconciled."; await loadOrders(); }
  catch (error) { notificationFeedback.textContent = error.message || "Customer notification reconciliation failed."; }
}
async function updateStatus(orderId, status) {
  try { await requestOrderAction(`/api/orders/${encodeURIComponent(orderId)}`, { status }, "PUT"); notificationFeedback.textContent = "Fulfilment status updated."; await loadOrders(); }
  catch (error) { notificationFeedback.textContent = error.message || "Order status could not be updated."; await loadOrders(); }
}

document.getElementById("search").oninput = filterOrders;
document.getElementById("filter").onchange = filterOrders;
function filterOrders() {
  const query = document.getElementById("search").value.toLowerCase();
  const status = document.getElementById("filter").value;
  renderOrders(allOrders.filter(order => String(order.publicReference || "").toLowerCase().includes(query) || String(order.orderId || "").toLowerCase().includes(query) || String(order.customer?.name || "").toLowerCase().includes(query))
    .filter(order => status === "all" || order.status === status));
}
requireAdminPage().then(isAdmin => { if (isAdmin) loadOrders(); });

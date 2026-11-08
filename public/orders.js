let allOrders = [];
let activeOrderId = null;
let previouslyFocused = null;

const tbody = document.querySelector("#ordersTable tbody");
const cards = document.getElementById("ordersCards");
const searchInput = document.getElementById("search");
const statusFilter = document.getElementById("filter");
const dateFilter = document.getElementById("dateFilter");
const ordersCount = document.getElementById("ordersCount");
const notificationFeedback = document.getElementById("notificationFeedback");
const detailFeedback = document.getElementById("detailFeedback");
const detailsView = document.getElementById("orderDetailsView");
const detailsContent = document.getElementById("orderDetailsContent");
const detailsTitle = document.getElementById("orderDetailsTitle");
const closeDetailsButton = document.getElementById("closeOrderDetails");
const fulfillmentStatuses = ["Placed", "Preparing", "Shipped", "Delivered", "Cancelled"];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function makeButton(label, callback, className = "") {
  const button = element("button", className, label);
  button.type = "button";
  button.addEventListener("click", callback);
  return button;
}

function publicReference(order) {
  if (typeof order.publicReference === "string" && order.publicReference.trim()) return order.publicReference.trim();
  return order.orderId ? `Legacy: ${order.orderId}` : "Reference unavailable";
}

function orderDate(order) {
  const date = new Date(order.createdAt || order.orderDate || "");
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDate(value, includeTime = true) {
  const date = value instanceof Date ? value : new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}

function paymentStatus(order) {
  return typeof order.paymentStatus === "string" && order.paymentStatus ? order.paymentStatus : "Legacy";
}

function badge(text, kind) {
  return element("span", `order-status-badge order-status-${kind}`, text);
}

function paymentKind(status) {
  if (status === "Paid") return "paid";
  if (status === "Pending") return "pending";
  if (status === "Verification Pending") return "verification";
  if (status === "Failed / Mismatch") return "mismatch";
  if (status === "Refunded") return "refunded";
  return "legacy";
}

function fulfilmentKind(status) {
  if (status === "Delivered") return "delivered";
  if (status === "Shipped") return "shipped";
  if (status === "Preparing") return "preparing";
  if (status === "Cancelled") return "cancelled";
  return "placed";
}

function currencyCode(order) {
  return typeof order.currency === "string" && /^[A-Z]{3}$/.test(order.currency) ? order.currency : "INR";
}

function orderAmount(order) {
  const amount = Number.isFinite(order.paymentAmount) ? order.paymentAmount : Number.isFinite(order.total) ? order.total : null;
  return amount === null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: currencyCode(order) }).format(amount);
}

function itemCount(order) {
  return Array.isArray(order.items) ? order.items.reduce((sum, item) => sum + (Number.isFinite(Number(item?.qty)) ? Number(item.qty) : 0), 0) : 0;
}

function safeOrderImageUrl(value) {
  if (typeof value !== "string") return "";
  const source = value.trim();
  if (!source || /[\u0000-\u001f\u007f<>"'`]/.test(source)) return "";
  if (source.startsWith("/")) {
    if (source.startsWith("//") || source.includes("\\") || source.split(/[?#]/, 1)[0].split("/").includes("..")) return "";
    return source;
  }
  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : "";
  } catch { return ""; }
}

async function loadOrders() {
  try {
    const response = await fetch("/api/orders", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Orders could not be loaded.");
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error("Orders could not be loaded.");
    allOrders = result;
    filterOrders();
    if (activeOrderId) {
      const updated = allOrders.find(order => String(order.orderId || "") === activeOrderId);
      if (updated) {
        previouslyFocused = [...cards.children].find(card => card.getAttribute("data-order-id") === activeOrderId) ||
          [...tbody.children].find(row => row.getAttribute("data-order-id") === activeOrderId) || previouslyFocused;
        renderOrderDetails(updated);
        closeDetailsButton.focus();
      }
      else closeOrderDetails();
    }
  } catch (error) {
    console.error("Order list request failed:", error);
    tbody.replaceChildren();
    cards.replaceChildren(element("p", "orders-empty-state", "Orders are temporarily unavailable. Please refresh."));
    ordersCount.textContent = "";
    if (activeOrderId) setActionFeedback("Orders could not be refreshed. Your action may have completed; reload before trying again.", true);
  }
}

function makeCell(value, className = "") {
  const cell = element("td", className, value == null ? "" : value);
  return cell;
}

function renderOrders(orders) {
  tbody.replaceChildren();
  cards.replaceChildren();
  ordersCount.textContent = `Showing ${orders.length} of ${allOrders.length} orders`;
  if (!orders.length) {
    tbody.appendChild(element("tr", "orders-empty-row"));
    const emptyCell = element("td", "", "No matching orders.");
    emptyCell.colSpan = 8;
    tbody.children[0].appendChild(emptyCell);
    cards.appendChild(element("p", "orders-empty-state", "No matching orders."));
    return;
  }

  orders.forEach(order => {
    const id = String(order.orderId || "");
    const ref = publicReference(order);
    const customer = order.customer || {};
    const items = itemCount(order);
    const date = orderDate(order);
    const payment = paymentStatus(order);
    const fulfilment = typeof order.status === "string" && order.status ? order.status : "Placed";

    const row = element("tr", "order-list-row");
    row.setAttribute("data-order-id", id);
    row.tabIndex = 0;
    row.setAttribute("aria-label", `Open order ${ref}`);
    row.addEventListener("click", () => openOrderDetails(id, row));
    row.addEventListener("keydown", event => {
      if (event.target !== row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openOrderDetails(id, row);
      }
    });
    row.append(
      makeCell(ref, "order-reference-cell"),
      makeCell(customer.name || "Name unavailable"),
      makeCell(date ? formatDate(date) : "Date unavailable"),
      makeCell(items === 1 ? "1 item" : `${items} items`),
      makeCell(orderAmount(order), "order-amount-cell")
    );
    const paymentCell = element("td");
    paymentCell.appendChild(badge(payment, paymentKind(payment)));
    row.appendChild(paymentCell);
    const fulfilmentCell = element("td");
    fulfilmentCell.appendChild(badge(fulfilment, fulfilmentKind(fulfilment)));
    row.appendChild(fulfilmentCell);
    const actionCell = element("td");
    const viewButton = makeButton("View details", event => {
      event?.stopPropagation?.();
      openOrderDetails(id, viewButton);
    }, "order-view-button");
    viewButton.setAttribute("aria-label", `View details for ${ref}`);
    actionCell.appendChild(viewButton);
    row.appendChild(actionCell);
    tbody.appendChild(row);

    const card = element("button", "order-mobile-card");
    card.type = "button";
    card.setAttribute("data-order-id", id);
    card.setAttribute("aria-label", `Open order ${ref}`);
    card.addEventListener("click", () => openOrderDetails(id, card));
    const cardHeading = element("span", "order-mobile-card-heading");
    const cardReference = element("strong", "order-mobile-reference", ref);
    const cardDate = element("time", "order-mobile-date", date ? formatDate(date) : "Date unavailable");
    cardHeading.append(cardReference, cardDate);
    const cardCustomer = element("span", "order-mobile-customer", customer.name || "Name unavailable");
    const cardInfo = element("span", "order-mobile-info");
    cardInfo.append(element("span", "", items === 1 ? "1 item" : `${items} items`), element("strong", "", orderAmount(order)));
    const cardStatuses = element("span", "order-mobile-statuses");
    cardStatuses.append(badge(payment, paymentKind(payment)), badge(fulfilment, fulfilmentKind(fulfilment)));
    card.append(cardHeading, cardCustomer, cardInfo, cardStatuses, element("span", "order-card-open-indicator", "›"));
    cards.appendChild(card);
  });
}

function matchesDate(order, range) {
  if (range === "all") return true;
  const date = orderDate(order);
  if (!date) return false;
  const now = new Date();
  if (range === "today") return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (range === "7days") return date >= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) && date <= now;
  if (range === "month") return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  return true;
}

function filterOrders() {
  const query = (searchInput?.value || "").trim().toLowerCase();
  const status = statusFilter?.value || "all";
  const dateRange = dateFilter?.value || "all";
  const visible = allOrders.filter(order => {
    const matchesSearch = [order.publicReference, order.orderId, order.customer?.name, order.customer?.phone]
      .some(value => String(value || "").toLowerCase().includes(query));
    return matchesSearch && (status === "all" || order.status === status) && matchesDate(order, dateRange);
  });
  renderOrders(visible);
}

function createSection(title, className = "") {
  const section = element("section", `order-detail-section ${className}`.trim());
  section.appendChild(element("h3", "order-detail-section-title", title));
  return section;
}

function addDetailLine(parent, label, value) {
  const line = element("div", "order-detail-line");
  line.append(element("span", "order-detail-label", label), element("strong", "order-detail-value", value || "Not provided"));
  parent.appendChild(line);
}

function addNotificationRow(parent, title, status, action) {
  const row = element("div", "notification-status-row");
  const name = element("span", "notification-status-name", title);
  const state = badge(status || "Not configured", status === "sent" ? "paid" : ["pending", "sending", "unknown"].includes(status) ? "pending" : "legacy");
  row.append(name, state);
  if (action) row.appendChild(action);
  parent.appendChild(row);
}

function isStaleNotification(status, attemptedAt) {
  const time = new Date(attemptedAt || 0).getTime();
  return ["unknown", "sending"].includes(status) && Number.isFinite(time) && Date.now() - time >= 5 * 60 * 1000;
}

function renderOrderDetails(order) {
  const id = String(order.orderId || "");
  const ref = publicReference(order);
  const customer = order.customer || {};
  const status = fulfillmentStatuses.includes(order.status) ? order.status : "Placed";
  const payStatus = paymentStatus(order);
  const pendingPayment = ["Pending", "Verification Pending"].includes(order.paymentStatus);
  const orderItems = Array.isArray(order.items) ? order.items : [];
  detailsTitle.textContent = `Order Details — ${ref}`;
  detailsContent.replaceChildren();

  const summary = createSection("Order overview", "order-detail-summary");
  addDetailLine(summary, "Order reference", ref);
  const summaryStatuses = element("div", "order-summary-statuses");
  summaryStatuses.append(element("span", "", "Payment"), badge(payStatus, paymentKind(payStatus)), element("span", "", "Fulfilment"), badge(status, fulfilmentKind(status)));
  summary.appendChild(summaryStatuses);
  detailsContent.appendChild(summary);

  const customerSection = createSection("Customer details", "order-detail-customer");
  addDetailLine(customerSection, "Name", customer.name);
  addDetailLine(customerSection, "Phone", customer.phone);
  addDetailLine(customerSection, "Email", customer.email);
  addDetailLine(customerSection, "Delivery address", customer.address);
  detailsContent.appendChild(customerSection);

  const summarySection = createSection("Order summary", "order-detail-meta");
  addDetailLine(summarySection, "Order date", formatDate(order.createdAt || order.orderDate));
  addDetailLine(summarySection, "Total items", String(itemCount(order)));
  addDetailLine(summarySection, "Total amount", orderAmount(order));
  detailsContent.appendChild(summarySection);

  const products = createSection(`Products (${orderItems.length})`, "order-detail-products");
  const productHead = element("div", "order-product-head");
  productHead.append(element("span"), element("span"), element("span", "", "Qty"), element("span", "", "Unit price"), element("span", "", "Line total"));
  products.appendChild(productHead);
  orderItems.forEach(item => {
    const line = element("article", "order-product-line");
    const imageUrl = safeOrderImageUrl(item?.image);
    if (imageUrl) {
      const image = element("img", "order-product-image");
      image.src = imageUrl;
      image.alt = "";
      image.loading = "lazy";
      line.appendChild(image);
    } else {
      line.appendChild(element("span", "order-product-image order-product-image-empty", "Art"));
    }
    const name = element("strong", "order-product-name", item?.name || "Item");
    const quantity = Number.isFinite(Number(item?.qty)) ? Number(item.qty) : 0;
    const price = Number.isFinite(Number(item?.price)) ? Number(item.price) : 0;
    const lineTotal = Number.isFinite(Number(item?.lineTotal)) ? Number(item.lineTotal) : quantity * price;
    line.append(name, element("span", "order-product-quantity", String(quantity)), element("span", "order-product-price", new Intl.NumberFormat("en-IN", { style: "currency", currency: currencyCode(order) }).format(price)), element("strong", "order-product-total", new Intl.NumberFormat("en-IN", { style: "currency", currency: currencyCode(order) }).format(lineTotal)));
    products.appendChild(line);
  });
  detailsContent.appendChild(products);

  const payment = createSection("Payment management (UPI)", "order-detail-payment");
  addDetailLine(payment, "Payment method", order.paymentMethod || (order.paymentStatus ? "UPI" : "Not recorded"));
  addDetailLine(payment, "Payment amount", orderAmount({ ...order, paymentAmount: Number.isFinite(order.paymentAmount) ? order.paymentAmount : order.total }));
  const paymentState = element("div", "order-detail-line");
  paymentState.append(element("span", "order-detail-label", "Payment status"), badge(payStatus, paymentKind(payStatus)));
  payment.appendChild(paymentState);
  if (order.paymentReference) addDetailLine(payment, "UTR / transaction reference", order.paymentReference);
  if (pendingPayment) {
    const referenceInput = element("input", "order-utr-input");
    referenceInput.type = "text";
    referenceInput.maxLength = 100;
    referenceInput.autocomplete = "off";
    referenceInput.placeholder = "Enter UTR / transaction reference";
    referenceInput.setAttribute("aria-label", `UTR or transaction reference for ${ref}`);
    payment.appendChild(referenceInput);
    const actions = element("div", "order-action-buttons");
    actions.append(
      makeButton("Record UTR", () => updatePayment(id, "record_reference", referenceInput.value), "order-secondary-button"),
      makeButton("Verify payment", () => updatePayment(id, "verify", referenceInput.value), "order-primary-button"),
      makeButton("Flag mismatch", () => updatePayment(id, "mismatch", referenceInput.value), "order-outline-button")
    );
    payment.appendChild(actions);
  } else {
    payment.appendChild(element("p", "order-management-note", order.paymentStatus ? "Payment actions are unavailable for this payment state." : "Legacy order: payment state is unavailable."));
  }
  detailsContent.appendChild(payment);

  const fulfilment = createSection("Fulfilment management", "order-detail-fulfilment");
  const fulfilmentLabel = element("label", "order-detail-label", "Fulfilment status");
  const statusSelect = element("select", "order-status-select");
  statusSelect.setAttribute("aria-label", `Fulfilment status for ${ref}`);
  fulfillmentStatuses.forEach(value => {
    const option = element("option", "", value);
    option.value = value;
    statusSelect.appendChild(option);
  });
  statusSelect.value = status;
  fulfilmentLabel.appendChild(statusSelect);
  fulfilment.append(fulfilmentLabel, makeButton("Update status", () => updateStatus(id, statusSelect.value), "order-primary-button"));
  detailsContent.appendChild(fulfilment);

  const timeline = createSection("Order timeline", "order-detail-timeline");
  renderTimeline(timeline, order);
  detailsContent.appendChild(timeline);

  const notifications = createSection("WhatsApp notifications", "order-detail-notifications");
  renderNotifications(notifications, order);
  detailsContent.appendChild(notifications);
}

function renderTimeline(section, order) {
  const events = (Array.isArray(order.statusHistory) ? order.statusHistory : [])
    .filter(event => fulfillmentStatuses.includes(event?.status))
    .map(event => ({ label: `Order ${event.status}`, status: event.status, at: event.at }));
  if (!events.some(event => event.status === "Placed")) events.unshift({ label: "Order Placed", status: "Placed", at: order.createdAt });
  if (order.paymentVerifiedAt) events.push({ label: "Payment Verified", status: "Payment Verified", at: order.paymentVerifiedAt });
  if (["Verification Pending", "Failed / Mismatch", "Refunded"].includes(order.paymentStatus)) events.push({ label: order.paymentStatus, status: order.paymentStatus, at: null });
  events.sort((a, b) => {
    const first = new Date(a.at || 0).getTime();
    const second = new Date(b.at || 0).getTime();
    if (!a.at) return b.at ? 1 : 0;
    if (!b.at) return -1;
    return first - second;
  });
  const list = element("ol", "order-timeline-list");
  if (!events.length) {
    section.appendChild(element("p", "order-management-note", "No timeline events are available for this legacy order."));
    return;
  }
  events.forEach((event, index) => {
    const item = element("li", `order-timeline-event${index === events.length - 1 ? " is-current" : ""}`);
    item.appendChild(element("strong", "", event.label));
    item.appendChild(element("time", "", event.at ? formatDate(event.at) : "Time unavailable"));
    list.appendChild(item);
  });
  section.appendChild(list);
}

function renderNotifications(section, order) {
  const adminStatus = typeof order.whatsappNotificationStatus === "string" && order.whatsappNotificationStatus
    ? order.whatsappNotificationStatus : "not_configured";
  const adminAttempt = order.whatsappNotificationAttemptedAt;
  let adminAction = null;
  if (["pending", "failed", "not_configured"].includes(adminStatus)) {
    adminAction = makeButton("Retry", () => retryWhatsAppNotice(order.orderId), "order-outline-button");
  } else if (isStaleNotification(adminStatus, adminAttempt)) {
    adminAction = makeButton("Confirm sent", () => confirmWhatsAppSent(order.orderId), "order-outline-button");
    adminAction = element("div", "notification-action-pair");
    adminAction.append(makeButton("Confirm sent", () => confirmWhatsAppSent(order.orderId), "order-outline-button"), makeButton("Confirm not sent & retry", () => confirmNotSentAndRetry(order.orderId), "order-outline-button"));
  }
  addNotificationRow(section, "Admin order notice", adminStatus.replaceAll("_", " "), adminAction);

  const eventTypes = [
    ["customer_order", "Customer order confirmation"],
    ["customer_payment_success", "Customer payment confirmation"],
    ["customer_fulfilment", "Customer fulfilment update"]
  ];
  const outbox = Array.isArray(order.whatsappOutbox) ? order.whatsappOutbox : [];
  eventTypes.forEach(([type, title]) => {
    const event = [...outbox].reverse().find(entry => entry.type === type);
    const eventStatus = typeof event?.status === "string" && event.status ? event.status : "";
    let status = eventStatus || (order.customerWhatsAppOptIn ? "not queued" : "not opted in");
    let action = null;
    if (event && ["pending", "failed", "not_configured"].includes(eventStatus)) {
      action = makeButton("Retry", () => retryCustomerNotice(order.orderId, event.key), "order-outline-button");
    } else if (event && isStaleNotification(eventStatus, event.attemptedAt)) {
      action = element("div", "notification-action-pair");
      action.append(makeButton("Confirm sent", () => reconcileCustomerNotice(order.orderId, event.key, true), "order-outline-button"), makeButton("Confirm not sent & retry", () => reconcileCustomerNotice(order.orderId, event.key, false), "order-outline-button"));
    }
    if (status === "not_configured") status = "Not configured";
    else if (status === "not opted in") status = "Not opted in";
    else if (status === "not queued") status = "Not queued";
    else status = status.replaceAll("_", " ");
    addNotificationRow(section, title, status, action);
  });
}

function openOrderDetails(orderId, opener) {
  const order = allOrders.find(item => String(item.orderId || "") === String(orderId));
  if (!order) return;
  if (!activeOrderId) previouslyFocused = opener || document.activeElement;
  activeOrderId = String(order.orderId || "");
  detailFeedback.textContent = "";
  renderOrderDetails(order);
  detailsView.hidden = false;
  detailsView.setAttribute("aria-hidden", "false");
  document.body.classList.add("order-details-open");
  closeDetailsButton.focus();
}

function closeOrderDetails() {
  if (!detailsView || detailsView.hidden) return;
  activeOrderId = null;
  detailsView.hidden = true;
  detailsView.setAttribute("aria-hidden", "true");
  document.body.classList.remove("order-details-open");
  if (previouslyFocused?.focus) previouslyFocused.focus();
  previouslyFocused = null;
}

function setActionFeedback(message, isError = false) {
  detailFeedback.textContent = message;
  detailFeedback.classList.toggle("is-error", isError);
  notificationFeedback.textContent = message;
  notificationFeedback.classList.toggle("is-error", isError);
}

async function requestOrderAction(url, body, method = "POST") {
  const response = await fetch(url, { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The order action could not be completed.");
  return data;
}

async function finishOrderAction(message) {
  setActionFeedback(message);
  await loadOrders();
}

async function updatePayment(orderId, action, paymentReference) {
  if (action === "record_reference" && !paymentReference?.trim()) {
    setActionFeedback("Enter the UTR or transaction reference first.", true);
    return;
  }
  if (action === "verify" && !confirm("Confirm that you checked the UPI payment in the business account and the amount matches this order?")) return;
  if (action === "mismatch" && !confirm("Flag this payment as failed or mismatched? It will not be marked paid.")) return;
  setActionFeedback("Updating payment…");
  try {
    const body = { action };
    if (paymentReference?.trim()) body.paymentReference = paymentReference.trim();
    await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/payment-verification`, body, "PUT");
    await finishOrderAction(action === "verify" ? "Payment verified; fulfilment is Preparing." : action === "mismatch" ? "Payment flagged for review." : "UTR recorded for verification.");
  } catch (error) { setActionFeedback(error.message || "Payment update failed.", true); }
}

async function retryWhatsAppNotice(orderId) {
  setActionFeedback("Retrying admin notification…");
  try { const result = await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/whatsapp-notification/retry`); await finishOrderAction(`Admin notification: ${result.status}.`); }
  catch (error) { setActionFeedback(error.message || "Notification retry failed.", true); }
}

async function confirmWhatsAppSent(orderId) {
  if (!confirm("Only continue after checking Meta delivery records and confirming the admin notification was delivered.")) return;
  try { await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/whatsapp-notification/confirm-sent`, { confirmed: true }); await finishOrderAction("Admin notification marked sent."); }
  catch (error) { setActionFeedback(error.message || "Notification reconciliation failed.", true); }
}

async function confirmNotSentAndRetry(orderId) {
  if (!confirm("Only continue after checking Meta records and confirming no message was accepted or delivered.")) return;
  try { const result = await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/whatsapp-notification/confirm-not-sent-retry`, { confirmedNotSent: true }); await finishOrderAction(`Admin notification: ${result.status}.`); }
  catch (error) { setActionFeedback(error.message || "Notification reconciliation failed.", true); }
}

async function retryCustomerNotice(orderId, key) {
  setActionFeedback("Retrying customer notification…");
  try { const result = await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/notifications/${encodeURIComponent(key)}/retry`, {}); await finishOrderAction(`Customer notification: ${result.status}.`); }
  catch (error) { setActionFeedback(error.message || "Customer notification retry failed.", true); }
}

async function reconcileCustomerNotice(orderId, key, sent) {
  const message = sent ? "Confirm the customer message was delivered after checking Meta records?" : "Confirm no message was accepted or delivered? A retry will follow.";
  if (!confirm(message)) return;
  const action = sent ? "confirm-sent" : "confirm-not-sent-retry";
  try {
    await requestOrderAction(`/api/admin/orders/${encodeURIComponent(orderId)}/notifications/${encodeURIComponent(key)}/${action}`, sent ? { confirmed: true } : { confirmedNotSent: true });
    await finishOrderAction("Customer notification reconciled.");
  } catch (error) { setActionFeedback(error.message || "Notification reconciliation failed.", true); }
}

async function updateStatus(orderId, status) {
  setActionFeedback("Updating fulfilment status…");
  try { await requestOrderAction(`/api/orders/${encodeURIComponent(orderId)}`, { status }, "PUT"); await finishOrderAction("Fulfilment status updated."); }
  catch (error) { setActionFeedback(error.message || "Order status could not be updated.", true); await loadOrders(); }
}

function onDetailsKeydown(event) {
  if (event.key === "Escape" && activeOrderId) {
    event.preventDefault();
    closeOrderDetails();
    return;
  }
  if (event.key === "Tab" && activeOrderId) {
    const focusable = [...detailsView.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]")]
      .filter(node => !node.hidden);
    if (!focusable.length) {
      event.preventDefault();
      closeDetailsButton.focus();
    } else if (event.shiftKey && document.activeElement === focusable[0]) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
      event.preventDefault();
      focusable[0].focus();
    }
  }
}

searchInput.addEventListener("input", filterOrders);
statusFilter.addEventListener("change", filterOrders);
dateFilter.addEventListener("change", filterOrders);
closeDetailsButton.addEventListener("click", closeOrderDetails);
detailsView.addEventListener("click", event => { if (event.target === detailsView) closeOrderDetails(); });
document.addEventListener("keydown", onDetailsKeydown);
requireAdminPage().then(isAdmin => {
  if (!isAdmin) return;
  tbody.appendChild(element("tr", "orders-loading-row"));
  const loadingCell = element("td", "", "Loading orders…");
  loadingCell.colSpan = 8;
  tbody.children[0].appendChild(loadingCell);
  cards.appendChild(element("p", "orders-empty-state", "Loading orders…"));
  loadOrders();
});

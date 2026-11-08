const lookupForm = document.getElementById("orderLookupForm");
const lookupFeedback = document.getElementById("orderLookupFeedback");
const lookupButton = document.getElementById("orderLookupButton");
const lookupResult = document.getElementById("orderLookupResult");
const paymentPanel = document.getElementById("trackedPaymentPanel");
const qrImage = document.getElementById("trackedQrImage");
const qrStatus = document.getElementById("trackedQrStatus");
const payButton = document.getElementById("trackedPayButton");
const sharePayment = document.getElementById("trackedSharePayment");
const contactLink = document.getElementById("trackedContactLink");

function safeOrderImage(value) {
  if (typeof value !== "string") return "";
  const source = value.trim();
  if (!source || /[\u0000-\u001f\u007f<>"'`]/.test(source)) return "";
  if (source.startsWith("/")) return !source.startsWith("//") && !source.includes("\\") && !source.split(/[?#]/, 1)[0].split("/").includes("..") ? source : "";
  try { const url = new URL(source); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; }
  catch { return ""; }
}

function safeWhatsAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "wa.me" && !url.username && !url.password && !url.port && /^\/?\d{8,15}$/.test(url.pathname) ? url.href : "";
  }
  catch { return ""; }
}

function safeUpiUri(payment) {
  if (!payment || typeof payment.uri !== "string" || payment.currency !== "INR" ||
      !Number.isFinite(payment.amount) || payment.amount <= 0 || typeof payment.reference !== "string") return "";
  try {
    const uri = new URL(payment.uri);
    return uri.protocol === "upi:" && uri.hostname === "pay" && !uri.username && !uri.password && !uri.port && uri.searchParams.get("pa") === payment.upiId &&
      uri.searchParams.get("pn") === payment.payeeName && uri.searchParams.get("am") === Number(payment.amount).toFixed(2) &&
      uri.searchParams.get("cu") === "INR" && uri.searchParams.get("tn") === payment.reference ? payment.uri : "";
  } catch { return ""; }
}

function formatDate(value) {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) return "Date not recorded";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function renderOrder(data) {
  lookupResult.hidden = false;
  document.getElementById("trackedOrderReference").textContent = data.publicReference || "Order reference unavailable";
  document.getElementById("trackedOrderDate").textContent = data.orderDate ? `Placed ${formatDate(data.orderDate)}` : "Order date not recorded";
  document.getElementById("trackedPaymentStatus").textContent = data.paymentStatus || "Payment details unavailable (legacy order)";
  document.getElementById("trackedFulfilmentStatus").textContent = data.status || "Placed";
  const itemContainer = document.getElementById("trackedOrderItems");
  itemContainer.replaceChildren();
  (Array.isArray(data.items) ? data.items : []).forEach(item => {
    const row = document.createElement("article");
    row.className = "tracked-order-item";
    const imageUrl = safeOrderImage(item.image);
    if (imageUrl) {
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = typeof item.name === "string" ? item.name : "Handmade product";
      image.loading = "lazy";
      image.addEventListener("error", () => image.remove());
      row.appendChild(image);
    }
    const description = document.createElement("div");
    const name = document.createElement("h4");
    name.textContent = typeof item.name === "string" ? item.name : "Handmade item";
    const quantity = Number.isSafeInteger(Number(item.qty)) && Number(item.qty) > 0 ? Number(item.qty) : null;
    const meta = document.createElement("p");
    meta.textContent = `Quantity: ${quantity ?? "unavailable"} · ${Number.isFinite(item.price) ? `₹${item.price.toFixed(2)} each` : "Price unavailable"}`;
    const lineTotal = document.createElement("strong");
    lineTotal.textContent = Number.isFinite(item.lineTotal) ? `₹${item.lineTotal.toFixed(2)}` : "";
    description.append(name, meta, lineTotal);
    row.appendChild(description);
    itemContainer.appendChild(row);
  });
  document.getElementById("trackedOrderTotal").textContent = Number.isFinite(data.total) ? `₹${data.total.toFixed(2)}${data.currency ? ` ${data.currency}` : ""}` : "Total unavailable";

  const timeline = document.getElementById("trackedOrderTimeline");
  timeline.replaceChildren();
  const events = Array.isArray(data.timeline) ? data.timeline : [];
  events.forEach(event => {
    const entry = document.createElement("li");
    entry.className = `tracking-event${event.status === "Cancelled" || event.status === "Failed / Mismatch" ? " is-attention" : ""}`;
    const label = document.createElement("strong");
    label.textContent = event.status || "Order update";
    const date = document.createElement("time");
    if (typeof event.at === "string" && Number.isFinite(new Date(event.at).getTime())) {
      date.dateTime = event.at;
      date.textContent = formatDate(event.at);
    } else date.textContent = "Date not recorded";
    entry.append(label, date);
    timeline.appendChild(entry);
  });
  document.getElementById("trackedTimelineEmpty").hidden = events.length > 0;

  const isPaymentPending = ["Pending", "Verification Pending"].includes(data.paymentStatus);
  paymentPanel.hidden = !isPaymentPending;
  if (isPaymentPending) {
    document.getElementById("trackedPaymentMessage").textContent = data.paymentStatus === "Pending"
      ? "Payment is due. Use the order-specific UPI details below, then allow the store to verify it manually."
      : "Your payment details are awaiting manual verification. Please do not pay again while verification is in progress.";
    const amount = Number.isFinite(data.paymentAmount) ? data.paymentAmount : data.total;
    document.getElementById("trackedAmountDue").textContent = Number.isFinite(amount) ? `Amount ${data.paymentStatus === "Pending" ? "due" : "submitted"}: ₹${amount.toFixed(2)} ${data.currency || "INR"}` : "Payment amount is unavailable.";
    qrImage.hidden = true;
    qrImage.removeAttribute("src");
    payButton.hidden = true;
    sharePayment.hidden = true;
    if (data.paymentStatus === "Pending" && safeUpiUri(data.upiPayment) && data.upiPayment.amount === amount && data.upiPayment.reference === data.publicReference) {
      const payment = data.upiPayment;
      document.getElementById("trackedPayeeName").textContent = `Pay to ${payment.payeeName}`;
      document.getElementById("trackedUpiId").textContent = `UPI ID: ${payment.upiId}`;
      payButton.href = payment.uri;
      payButton.textContent = `Pay ₹${payment.amount.toFixed(2)} using UPI`;
      payButton.hidden = false;
      if (typeof payment.qrCodeDataUrl === "string" && payment.qrCodeDataUrl.length < 500000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(payment.qrCodeDataUrl)) {
        qrStatus.textContent = "Loading order payment QR…";
        qrImage.alt = `UPI payment QR for ${data.publicReference}, amount ₹${payment.amount.toFixed(2)}`;
        qrImage.onload = () => { qrImage.hidden = false; qrStatus.textContent = "Scan this QR with a UPI app."; };
        qrImage.onerror = () => { qrImage.hidden = true; qrStatus.textContent = "QR code unavailable; use the UPI button."; };
        qrImage.src = payment.qrCodeDataUrl;
      } else qrStatus.textContent = "QR code unavailable; use the UPI button.";
    } else {
      qrStatus.textContent = data.paymentStatus === "Pending" ? "Order-specific UPI instructions are unavailable. Contact the store before paying." : "Payment verification is pending; no additional payment is required now.";
      document.getElementById("trackedPayeeName").textContent = "";
      document.getElementById("trackedUpiId").textContent = "";
    }
    const safeShare = safeWhatsAppUrl(data.sharePaymentDetailsUrl);
    if (safeShare) { sharePayment.href = safeShare; sharePayment.hidden = false; }
  }
  const safeContact = safeWhatsAppUrl(data.contactWhatsAppUrl);
  contactLink.hidden = !safeContact;
  if (safeContact) contactLink.href = safeContact;
}

lookupForm.addEventListener("submit", async event => {
  event.preventDefault();
  const orderReference = document.getElementById("orderReferenceInput").value.trim();
  const phone = document.getElementById("orderPhoneInput").value.trim();
  lookupResult.hidden = true;
  lookupFeedback.setAttribute("role", "status");
  if (!orderReference || !phone) {
    lookupFeedback.textContent = "Enter both your order reference and registered mobile number.";
    lookupFeedback.setAttribute("role", "alert");
    return;
  }
  lookupButton.disabled = true;
  lookupFeedback.textContent = "Finding your order…";
  try {
    const response = await fetch("/api/order-lookup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderReference, phone })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "We couldn't find an order with those details.");
    renderOrder(data);
    lookupFeedback.textContent = "Order found. Your details have been verified.";
  } catch (error) {
    lookupFeedback.textContent = error.message || "Order lookup is temporarily unavailable. Please try again.";
    lookupFeedback.setAttribute("role", "alert");
  } finally { lookupButton.disabled = false; }
});

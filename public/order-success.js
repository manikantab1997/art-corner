const confirmationStorageKey = "artcorner.order.confirmation";
const heading = document.getElementById("orderSuccessHeading");
const message = document.getElementById("orderSuccessMessage");
const details = document.getElementById("orderSuccessDetails");
const card = document.getElementById("orderSuccessCard");
const successMark = document.getElementById("orderSuccessMark");
const paymentPanel = document.getElementById("upiPaymentPanel");
const paymentAmount = document.getElementById("upiPaymentAmount");
const paymentReference = document.getElementById("upiPaymentReference");
const qrImage = document.getElementById("upiQrImage");
const qrStatus = document.getElementById("upiQrStatus");
const payeeName = document.getElementById("upiPayeeName");
const upiIdValue = document.getElementById("upiIdValue");
const copyUpiIdButton = document.getElementById("copyUpiIdButton");
const upiPayButton = document.getElementById("upiPayButton");
const upiAppHelp = document.getElementById("upiAppHelp");
const paymentUnavailable = document.getElementById("upiPaymentUnavailable");
const sharePaymentDetailsLink = document.getElementById("sharePaymentDetailsLink");

function showRecovery(reference, messageText) {
  heading.textContent = "We couldn't verify the order details in this tab";
  message.textContent = messageText;
  if (typeof reference === "string" && reference) {
    const label = document.createElement("p");
    label.className = "unverified-order-reference";
    label.textContent = `Reference from this browser (not verified): ${reference}`;
    details.replaceChildren(label);
    details.hidden = false;
  }
  card.setAttribute("aria-busy", "false");
}

function validUpiPayment(data) {
  if (!data || typeof data !== "object" || typeof data.uri !== "string" ||
      typeof data.upiId !== "string" || typeof data.payeeName !== "string" ||
      typeof data.amount !== "number" || !Number.isFinite(data.amount) || data.amount <= 0 ||
      data.currency !== "INR" || typeof data.reference !== "string") return false;
  try {
    const uri = new URL(data.uri);
    const params = uri.searchParams;
    return uri.protocol === "upi:" && uri.hostname === "pay" &&
      params.get("pa") === data.upiId && params.get("pn") === data.payeeName &&
      params.get("am") === data.amount.toFixed(2) && params.get("cu") === "INR" &&
      params.get("tn") === data.reference;
  } catch { return false; }
}

function showPaymentPending(data) {
  paymentPanel.hidden = false;
  heading.textContent = "Order received — payment pending";
  message.textContent = "Your order has been received. Complete the UPI payment below, then return to this page.";
  paymentAmount.textContent = Number.isFinite(data.paymentAmount) && data.paymentAmount >= 0
    ? `Amount to pay: ₹${data.paymentAmount.toFixed(2)} ${data.currency || "INR"}`
    : "Payment amount is unavailable. Please contact the store.";
  paymentReference.textContent = `Order reference: ${data.publicReference}`;
  if (sharePaymentDetailsLink) {
    const safeShareUrl = typeof data.sharePaymentDetailsUrl === "string" ? (() => { try { const value = new URL(data.sharePaymentDetailsUrl); return value.protocol === "https:" && value.hostname === "wa.me" && !value.username && !value.password && !value.port && /^\/?\d{8,15}$/.test(value.pathname) ? value.href : null; } catch { return null; } })() : null;
    sharePaymentDetailsLink.hidden = !safeShareUrl;
    if (safeShareUrl) sharePaymentDetailsLink.href = safeShareUrl;
  }
  upiPayButton.hidden = true;
  copyUpiIdButton.hidden = true;
  upiIdValue.textContent = "";
  payeeName.textContent = "";
  qrImage.hidden = true;
  qrImage.removeAttribute("src");
  paymentUnavailable.hidden = true;

  const payment = data.upiPayment;
  if (!validUpiPayment(payment) || !Number.isFinite(data.paymentAmount) || payment.amount !== data.paymentAmount ||
      payment.reference !== data.publicReference) {
    qrStatus.textContent = "An order-specific UPI payment link is unavailable.";
    paymentUnavailable.textContent = "Your order is still pending payment. Please contact the store using the contact link in the footer for payment instructions.";
    paymentUnavailable.hidden = false;
    upiAppHelp.textContent = "No payment has been verified yet.";
    return;
  }

  payeeName.textContent = payment.payeeName;
  upiIdValue.textContent = payment.upiId;
  upiPayButton.textContent = `Pay ₹${payment.amount.toFixed(2)} using UPI`;
  upiPayButton.href = payment.uri;
  upiPayButton.hidden = false;
  copyUpiIdButton.hidden = false;
  upiAppHelp.textContent = "This opens a supported UPI app when your device and browser handle UPI links. If it does not open, scan the QR code with a UPI app or copy the UPI ID.";
  copyUpiIdButton.addEventListener("click", async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(payment.upiId);
        copyUpiIdButton.textContent = "UPI ID copied";
        return;
      } catch { /* Fall through to the manual-copy guidance. */ }
    }
    copyUpiIdButton.textContent = "Copy unavailable — select the UPI ID above";
  });

  if (typeof payment.qrCodeDataUrl === "string" && payment.qrCodeDataUrl.length < 500000 &&
      /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(payment.qrCodeDataUrl)) {
    qrStatus.textContent = "Loading your order-specific QR code…";
    qrImage.alt = `UPI payment QR for ${payment.reference}, amount ₹${payment.amount.toFixed(2)}`;
    qrImage.onload = () => { qrImage.hidden = false; qrStatus.textContent = "Scan this QR with a UPI app."; };
    qrImage.onerror = () => { qrImage.hidden = true; qrStatus.textContent = "The QR code could not be displayed. Use the UPI button or copy the UPI ID."; };
    qrImage.src = payment.qrCodeDataUrl;
  } else {
    qrStatus.textContent = "QR code unavailable. Use the UPI button or copy the UPI ID.";
  }
}

async function loadOrderConfirmation() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(confirmationStorageKey) || "null"); }
  catch { saved = null; }
  if (!saved || typeof saved.token !== "string") {
    showRecovery(saved?.publicReference, "If checkout completed, use the reference saved from that checkout when contacting the store. No order details are shown until the server verifies the confirmation.");
    return;
  }

  try {
    const response = await fetch("/api/order-confirmation", {
      headers: { "X-Order-Confirmation": saved.token },
      credentials: "same-origin"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.publicReference !== "string" || !Array.isArray(data.items)) {
      throw new Error("The confirmation could not be verified.");
    }
    const paymentStatus = ["Pending", "Verification Pending", "Paid", "Failed / Mismatch", "Refunded"].includes(data.paymentStatus)
      ? data.paymentStatus : null;
    const statusCopy = {
      "Pending": {
        mark: "₹", heading: "Order received — payment pending",
        message: "Your order has been received. Complete the UPI payment below, then return to this page."
      },
      "Verification Pending": {
        mark: "…", heading: "Payment submitted — verification pending",
        message: "We have your payment details. The store is checking the payment; please do not pay again while verification is in progress."
      },
      "Paid": {
        mark: "✓", heading: "Payment verified — thank you!",
        message: "Your payment is confirmed and your order is moving to preparation."
      },
      "Failed / Mismatch": {
        mark: "!", heading: "Payment needs review",
        message: "The store could not match the payment details. Contact the store before making another payment."
      },
      "Refunded": {
        mark: "↺", heading: "Payment refunded",
        message: "The payment for this order has been refunded. Contact the store if you need help."
      }
    }[paymentStatus];
    const paymentIsPending = paymentStatus === "Pending";
    successMark.textContent = statusCopy?.mark || "✓";
    heading.textContent = statusCopy?.heading || "Order received";
    message.textContent = statusCopy?.message || "Your order has been received. Payment details are unavailable for this order.";
    const referenceLabel = document.createElement("p");
    referenceLabel.className = "order-reference-label";
    referenceLabel.textContent = "Your order reference";
    const reference = document.createElement("strong");
    reference.className = "order-reference-value";
    reference.textContent = data.publicReference;
    const status = document.createElement("p");
    status.className = "order-confirmation-status";
    status.textContent = `Confirmation status: ${data.status || "Placed"}`;
    const itemList = document.createElement("ul");
    itemList.className = "order-confirmation-items";
    data.items.forEach(item => {
      const row = document.createElement("li");
      const quantity = Number.isSafeInteger(Number(item.qty)) && Number(item.qty) > 0 ? Number(item.qty) : 1;
      const name = typeof item.name === "string" ? item.name : "Handmade item";
      row.textContent = `${name} × ${quantity}${Number.isFinite(item.price) ? ` — ₹${(item.price * quantity).toFixed(2)}` : ""}`;
      itemList.appendChild(row);
    });
    const nextSteps = document.createElement("p");
    nextSteps.className = "order-next-steps";
    nextSteps.textContent = "Keep this reference for any questions about your order.";
    details.replaceChildren(referenceLabel, reference, status, itemList, nextSteps);
    details.hidden = false;
    if (paymentIsPending) showPaymentPending(data);
    card.setAttribute("aria-busy", "false");
  } catch {
    showRecovery(saved.publicReference, "If checkout completed, keep the reference from this browser and contact the store using the details in the footer. No order details are shown because the server could not verify them.");
  }
}

loadOrderConfirmation();

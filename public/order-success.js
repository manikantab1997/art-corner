const confirmationStorageKey = "artcorner.order.confirmation";
const heading = document.getElementById("orderSuccessHeading");
const message = document.getElementById("orderSuccessMessage");
const details = document.getElementById("orderSuccessDetails");
const card = document.getElementById("orderSuccessCard");

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
    heading.textContent = "Thank you for your order!";
    message.textContent = "Your order has been received. We’ll follow up using the contact details you provided.";
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
    card.setAttribute("aria-busy", "false");
  } catch {
    showRecovery(saved.publicReference, "If checkout completed, keep the reference from this browser and contact the store using the details in the footer. No order details are shown because the server could not verify them.");
  }
}

loadOrderConfirmation();

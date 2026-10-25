function goBack() { window.history.back(); }
const form = document.getElementById("checkoutForm");
const feedback = document.getElementById("checkoutFeedback");
const orderIdFromUrl = new URLSearchParams(window.location.search).get("orderId");
const validOrderId = value => /^ORD-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");
const validPublicReference = value => /^AC-[A-HJ-NP-Z2-9]{5}$/.test(value || "") || /^ORD-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");
const checkoutKeyName = "artcorner.checkout.idempotencyKey";
const confirmationStorageKey = "artcorner.order.confirmation";
const checkoutSummaryItems = document.getElementById("checkoutSummaryItems");
const checkoutSummaryTotal = document.getElementById("checkoutSummaryTotal");
const placeOrderButton = document.getElementById("placeOrderButton");

function readCart() {
  try {
    const cart = JSON.parse(localStorage.getItem("cart") || "[]");
    return Array.isArray(cart) ? cart.filter(item => item && typeof item === "object" && typeof item._id === "string").map(item => ({
      ...item,
      qty: Number.isSafeInteger(Number(item.qty)) && Number(item.qty) > 0 ? Math.min(Number(item.qty), 99) : 1
    })) : [];
  } catch { return []; }
}

function renderCheckoutSummary(cart) {
  checkoutSummaryItems.replaceChildren();
  let total = 0;
  cart.forEach(item => {
    const row = document.createElement("div");
    row.className = "checkout-summary-item";
    const description = document.createElement("span");
    const quantity = Number.isSafeInteger(Number(item.qty)) && Number(item.qty) > 0 ? Number(item.qty) : 1;
    description.textContent = `${item.name || "Handmade product"} · ${quantity}`;
    const price = Number(item.price);
    const amount = document.createElement("strong");
    if (Number.isFinite(price) && price >= 0) {
      amount.textContent = `₹${(price * quantity).toFixed(2)}`;
      total += price * quantity;
    } else {
      amount.textContent = "Price unavailable";
    }
    row.append(description, amount);
    checkoutSummaryItems.appendChild(row);
  });
  checkoutSummaryTotal.textContent = `₹${total.toFixed(2)}`;
}

function getCheckoutIdempotencyKey() {
  let key = sessionStorage.getItem(checkoutKeyName);
  if (!key) {
    if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") throw new Error("Secure checkout is unavailable in this browser. Please try a current browser.");
    key = crypto.randomUUID();
    sessionStorage.setItem(checkoutKeyName, key);
  }
  return key;
}

const cart = readCart();
renderCheckoutSummary(cart);
if (!cart.length) {
  feedback.textContent = "Your cart is empty. Add a product before checking out.";
  placeOrderButton.disabled = true;
}

if (validOrderId(orderIdFromUrl)) {
  form.hidden = true;
  const legacyNotice = document.getElementById("legacyOrderNotice");
  legacyNotice.hidden = false;
  document.getElementById("legacyOrderNoticeText").textContent = `The older reference ${orderIdFromUrl} cannot be verified from this link. Contact the store if you need help with this order.`;
} else {
  const fields = [
    { id: "name", message: "Enter your full name (at least 2 characters).", valid: value => value.trim().length >= 2 },
    { id: "phone", message: "Enter a phone number using 7–20 digits or common phone symbols.", valid: value => /^[+0-9() .-]{7,20}$/.test(value.trim()) && /\d{7,}/.test(value) },
    { id: "email", message: "Enter a valid email address.", valid: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) },
    { id: "address", message: "Enter a delivery address with at least 8 characters.", valid: value => value.trim().length >= 8 }
  ];
  fields.forEach(field => {
    const input = document.getElementById(field.id);
    input.addEventListener("input", () => {
      input.setCustomValidity("");
      document.getElementById(`${field.id}Error`).textContent = "";
    });
  });

  form.onsubmit = async event => {
    event.preventDefault();
    const currentCart = readCart();
    if (!currentCart.length) {
      feedback.textContent = "Your cart is empty. Add a product before checking out.";
      return;
    }
    if (currentCart.some(item => !Number.isFinite(Number(item.price)) || Number(item.price) < 0)) {
      feedback.textContent = "An item has an invalid saved price. Return to your cart and remove it before continuing.";
      return;
    }
    let valid = true;
    for (const field of fields) {
      const input = document.getElementById(field.id);
      const error = document.getElementById(`${field.id}Error`);
      const isValid = field.valid(input.value);
      error.textContent = isValid ? "" : field.message;
      input.setCustomValidity(isValid ? "" : field.message);
      if (!isValid) valid = false;
    }
    if (!valid) {
      feedback.textContent = "Please check the highlighted details.";
      form.reportValidity();
      return;
    }
    const orderData = {
      customer: {
        name: document.getElementById("name").value.trim(),
        phone: document.getElementById("phone").value.trim(),
        email: document.getElementById("email").value.trim(),
        address: document.getElementById("address").value.trim()
      },
      items: currentCart
    };
    feedback.textContent = "Placing your order…";
    placeOrderButton.disabled = true;
    placeOrderButton.textContent = "Placing order…";
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": getCheckoutIdempotencyKey() },
        body: JSON.stringify(orderData)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && /checkout key was already used/i.test(data.error || "")) {
          sessionStorage.removeItem(checkoutKeyName);
          throw new Error("Your checkout details changed since the previous attempt. Review them and place the order again.");
        }
        throw new Error(data.error || "We couldn't place your order. Please try again.");
      }
      if (!validOrderId(data.orderId) || !validPublicReference(data.publicReference) || typeof data.confirmationToken !== "string") {
        throw new Error("The order may have been saved, but its confirmation could not be verified. Your cart is still saved; retry to recover the confirmation.");
      }
      sessionStorage.setItem(confirmationStorageKey, JSON.stringify({ token: data.confirmationToken, publicReference: data.publicReference }));
      localStorage.removeItem("cart");
      sessionStorage.removeItem(checkoutKeyName);
      if (typeof announceCartUpdated === "function") announceCartUpdated();
      window.location.href = "order-success.html";
    } catch (error) {
      feedback.textContent = error.message || "Unable to reach the store. Your cart is saved; please try again.";
    } finally {
      placeOrderButton.disabled = false;
      placeOrderButton.textContent = "Place Order";
    }
  };
}

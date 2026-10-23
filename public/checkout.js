function goBack() { window.history.back(); }
const form = document.getElementById("checkoutForm");
const feedback = document.getElementById("checkoutFeedback");
const confirmation = document.getElementById("orderConfirmation");
const confirmationId = document.getElementById("orderConfirmationId");
const orderIdFromUrl = new URLSearchParams(window.location.search).get("orderId");
const validOrderId = value => /^ORD-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");

if (validOrderId(orderIdFromUrl)) {
  form.hidden = true;
  confirmation.hidden = false;
  confirmationId.textContent = orderIdFromUrl;
} else {
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    let cart;
    try { cart = JSON.parse(localStorage.getItem("cart") || "[]"); }
    catch { cart = []; }
    if (!Array.isArray(cart) || cart.length === 0) {
      feedback.textContent = "Your cart is empty. Add a product before checking out.";
      return;
    }
    const orderData = {
      customer: {
        name: document.getElementById("name").value.trim(),
        phone: document.getElementById("phone").value.trim(),
        email: document.getElementById("email").value.trim(),
        address: document.getElementById("address").value.trim()
      },
      items: cart
    };
    feedback.textContent = "Placing your order…";
    button.disabled = true;
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderData)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "We couldn't place your order. Please try again.");
      if (!validOrderId(data.orderId)) {
        throw new Error("The server did not confirm your order. Your cart is still saved; please check before trying again.");
      }
      localStorage.removeItem("cart");
      window.location.href = `checkout.html?orderId=${encodeURIComponent(data.orderId)}`;
    } catch (error) {
      feedback.textContent = error.message || "Unable to reach the store. Your cart is saved; please try again.";
    } finally {
      button.disabled = false;
    }
  };
}

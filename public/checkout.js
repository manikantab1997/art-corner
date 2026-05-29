function goBack() {
  window.history.back();
}

document.getElementById("checkoutForm").onsubmit = async (e) => {
  e.preventDefault();

  const cart = JSON.parse(localStorage.getItem("cart")) || [];

  if (cart.length === 0) {
    alert("Cart is empty!");
    return;
  }

  const orderData = {
    customer: {
      name: document.getElementById("name").value,
      phone: document.getElementById("phone").value,
      email: document.getElementById("email").value,
      address: document.getElementById("address").value,
    },
    items: cart
  };

  const res = await fetch("/api/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(orderData)
  });

  const data = await res.json();

  alert("Order placed! ID: " + data.orderId);

  localStorage.removeItem("cart");

  window.location.href = "index.html";
};
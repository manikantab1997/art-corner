function goBack() {
    window.history.back();
}
let cart = JSON.parse(localStorage.getItem("cart")) || [];

const container = document.getElementById("cart");
const totalEl = document.getElementById("total");

function renderCart() {
    container.innerHTML = "";
    let total = 0;

    if (cart.length === 0) {
        container.innerHTML = "<p>Cart is empty</p>";
        totalEl.innerText = "";
        return;
    }

    cart.forEach(item => {
        const div = document.createElement("div");
        div.className = "card";

        div.innerHTML = `
  <img src="${item.image}" width="100" />
  <h3>${item.name}</h3>
  <p>₹${item.price}</p>
  <p>Qty: ${item.qty}</p>

  <button onclick="increase('${item._id}')">+</button>
  <button onclick="decrease('${item._id}')">-</button>
  <button onclick="removeItem('${item._id}')">Remove</button>
`;

        total += item.price * item.qty;

        container.appendChild(div);
    });

    totalEl.innerText = "Total: ₹" + total;
}

// ➕ Increase
function increase(id) {
    const item = cart.find(p => p.id === id);
    item.qty += 1;
    updateCart();
}

// ➖ Decrease
function decrease(id) {
    const item = cart.find(p => p.id === id);

    if (item.qty > 1) {
        item.qty -= 1;
    } else {
        cart = cart.filter(p => p.id !== id);
    }

    updateCart();
}

// ❌ Remove
function removeItem(id) {
    cart = cart.filter(p => p.id !== id);
    updateCart();
}

// 🔄 Save & Refresh
function updateCart() {
    localStorage.setItem("cart", JSON.stringify(cart));
    renderCart();
}

// First load
renderCart();
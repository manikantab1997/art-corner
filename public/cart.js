function goBack() { window.history.back(); }
let cart = [];
try {
    const savedCart = JSON.parse(localStorage.getItem("cart") || "[]");
    cart = Array.isArray(savedCart) ? savedCart : [];
} catch (error) {
    console.error("Could not read saved cart:", error);
}

const container = document.getElementById("cart");
const totalEl = document.getElementById("total");

function renderCart() {
    container.innerHTML = "";
    let total = 0;
    if (cart.length === 0) {
        container.innerHTML = "<p>Your cart is empty. Browse products to add something handmade.</p>";
        totalEl.innerText = "";
        return;
    }
    cart.forEach(item => {
        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = `
          <img src="${item.image}" alt="${item.name}" width="100" />
          <h3>${item.name}</h3><p>₹${item.price}</p><p>Qty: ${item.qty}</p>
          <button onclick="increase('${item._id}')" aria-label="Increase ${item.name} quantity">+</button>
          <button onclick="decrease('${item._id}')" aria-label="Decrease ${item.name} quantity">−</button>
          <button onclick="removeItem('${item._id}')">Remove</button>`;
        total += Number(item.price) * Number(item.qty);
        container.appendChild(div);
    });
    totalEl.innerText = "Total: ₹" + total;
}

function increase(id) {
    const item = cart.find(product => product._id === id);
    if (!item) return;
    item.qty = Number(item.qty || 1) + 1;
    updateCart();
}
function decrease(id) {
    const item = cart.find(product => product._id === id);
    if (!item) return;
    if (Number(item.qty) > 1) item.qty -= 1;
    else cart = cart.filter(product => product._id !== id);
    updateCart();
}
function removeItem(id) {
    cart = cart.filter(product => product._id !== id);
    updateCart();
}
function updateCart() {
    localStorage.setItem("cart", JSON.stringify(cart));
    renderCart();
}
renderCart();

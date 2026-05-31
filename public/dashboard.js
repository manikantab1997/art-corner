if (
    localStorage.getItem("isAdmin")
    !== "true"
) {

    window.location.href =
        "login.html";
}
if (localStorage.getItem("isAdmin") !== "true") {
    window.location.href = "login.html";
}
function goBack() {
    window.history.back();
}

function logout() {
    localStorage.removeItem("isAdmin");
    window.location.href = "login.html";
}

async function loadStats() {
    const ordersRes = await fetch("/api/orders");
    const orders = await ordersRes.json();

    const productsRes = await fetch("/api/products");
    const products = await productsRes.json();

    const totalOrders = orders.length;

    let revenue = 0;

    orders.forEach(order => {
        order.items.forEach(item => {
            revenue += item.price * item.qty;
        });
    });

    const totalProducts = products.length;

    document.getElementById("stats").innerHTML = `
    <div class="card">
      <h2>${totalOrders}</h2>
      <p>Total Orders</p>
    </div>

    <div class="card">
      <h2>₹${revenue}</h2>
      <p>Total Revenue</p>
    </div>

    <div class="card">
      <h2>${totalProducts}</h2>
      <p>Total Products</p>
    </div>
  `;
}

loadStats();
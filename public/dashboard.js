if (localStorage.getItem("isAdmin") !== "true") window.location.href = "login.html";
function goBack() { window.history.back(); }
function logout() { localStorage.removeItem("isAdmin"); window.location.href = "login.html"; }
const stats = document.getElementById("stats");
stats.innerHTML = "<p role=\"status\">Loading dashboard…</p>";
async function loadStats() {
  try {
    const [ordersResponse, productsResponse] = await Promise.all([fetch("/api/orders"), fetch("/api/products")]);
    if (!ordersResponse.ok || !productsResponse.ok) throw new Error("Dashboard data could not be loaded.");
    const [orders, products] = await Promise.all([ordersResponse.json(), productsResponse.json()]);
    const revenue = orders.reduce((sum, order) => sum + (order.items || []).reduce((subtotal, item) => subtotal + Number(item.price || 0) * Number(item.qty || 0), 0), 0);
    stats.innerHTML = `<div class="card"><h2>${orders.length}</h2><p>Total Orders</p></div><div class="card"><h2>₹${revenue}</h2><p>Total Revenue</p></div><div class="card"><h2>${products.length}</h2><p>In-stock Products</p></div>`;
  } catch (error) {
    console.error("Dashboard request failed:", error);
    stats.innerHTML = "<p role=\"alert\">Dashboard data is temporarily unavailable. Please refresh.</p>";
  }
}
loadStats();

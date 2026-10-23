if (localStorage.getItem("isAdmin") !== "true") window.location.href = "login.html";
function goBack() { window.history.back(); }
const productsContainer = document.getElementById("products");
productsContainer.innerHTML = "<p role=\"status\">Loading products…</p>";
async function loadProducts() {
  try {
    const response = await fetch("/api/products");
    if (!response.ok) throw new Error("Could not load products.");
    const products = await response.json();
    productsContainer.innerHTML = "";
    if (!products.length) {
      productsContainer.innerHTML = "<p>No in-stock products are available in this list.</p>";
      return;
    }
    products.forEach(product => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<img src="${product.image}" alt="${product.name}" width="100"><h3>${product.name}</h3><p>₹${product.price}</p><p>In Stock</p><button onclick="deleteProduct('${product._id}')">Delete</button><button onclick="toggleStock('${product._id}')">Toggle Stock</button>`;
      productsContainer.appendChild(card);
    });
  } catch (error) {
    console.error("Admin product list request failed:", error);
    productsContainer.innerHTML = "<p role=\"alert\">Products could not be loaded. Please refresh and try again.</p>";
  }
}
async function addProduct() {
  const name = document.getElementById("name").value.trim();
  const price = document.getElementById("price").value.trim();
  const categoryId = document.getElementById("category").value.trim();
  const file = document.getElementById("image").files[0];
  if (!name || price === "" || !Number.isFinite(Number(price)) || Number(price) < 0 || !/^[1-9]\d*$/.test(categoryId) || !file) {
    alert("Enter a product name, valid price and category ID, and choose an image.");
    return;
  }
  const formData = new FormData();
  formData.append("name", name);
  formData.append("price", price);
  formData.append("categoryId", categoryId);
  formData.append("image", file);
  try {
    const response = await fetch("/api/products", { method: "POST", body: formData });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Product could not be added.");
    alert("Product added.");
    await loadProducts();
  } catch (error) {
    alert(error.message || "Product could not be added. Please try again.");
  }
}
async function deleteProduct(id) {
  try {
    const response = await fetch(`/api/products/${encodeURIComponent(id)}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Product could not be deleted.");
    await loadProducts();
  } catch (error) { alert(error.message); }
}
async function toggleStock(id) {
  try {
    const response = await fetch(`/api/products/${encodeURIComponent(id)}`, { method: "PUT" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Stock could not be updated.");
    await loadProducts();
  } catch (error) { alert(error.message); }
}
loadProducts();

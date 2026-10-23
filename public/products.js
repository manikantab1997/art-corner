function goBack() { window.history.back(); }
let allProducts = [];
const params = new URLSearchParams(window.location.search);
const categoryId = params.get("category");
const pageTitle = document.getElementById("pageTitle");
const categoryFilter = document.getElementById("categoryFilter");
const productContainer = document.getElementById("products");
const categoryNames = { "1": "🕯️ Candles", "2": "🎨 Resin Art", "3": "📿 Bracelets" };
productContainer.innerHTML = "<p role=\"status\">Loading products…</p>";
if (categoryFilter) {
  categoryFilter.value = categoryId || "";
  categoryFilter.addEventListener("change", () => {
    const query = categoryFilter.value ? `?category=${encodeURIComponent(categoryFilter.value)}` : "";
    window.location.href = `products.html${query}`;
  });
}
fetch("/api/products")
  .then(async response => {
    if (!response.ok) throw new Error("Products could not be loaded.");
    return response.json();
  })
  .then(data => {
    if (!Array.isArray(data)) throw new Error("The product response was invalid.");
    allProducts = data.filter(product => product.inStock);
    if (categoryId) {
      allProducts = allProducts.filter(product => String(product.categoryId) === categoryId);
      if (pageTitle) pageTitle.innerText = categoryNames[categoryId] || "Products";
    } else if (pageTitle) pageTitle.innerText = "✨ All Products";
    renderProducts(allProducts);
  })
  .catch(error => {
    console.error("Product request failed:", error);
    productContainer.innerHTML = "<p role=\"alert\">Products are temporarily unavailable. Please try again shortly.</p>";
  });
function renderProducts(products) {
  productContainer.innerHTML = "";
  if (!products.length) {
    productContainer.innerHTML = "<p>No products match your search yet.</p>";
    return;
  }
  products.forEach(product => {
    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.innerHTML = `<img src="${product.image}" alt="${product.name}" /><h3>${product.name}</h3><p>₹${product.price}</p>`;
    const openProduct = () => { window.location.href = `product.html?id=${encodeURIComponent(product._id)}`; };
    card.addEventListener("click", openProduct);
    card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openProduct(); } });
    productContainer.appendChild(card);
  });
}
const searchInput = document.getElementById("search");
if (searchInput) searchInput.addEventListener("input", filterProducts);
function filterProducts() {
  const search = searchInput.value.toLowerCase().trim();
  renderProducts(allProducts.filter(product => String(product.name || "").toLowerCase().includes(search)));
}

function goBack() { window.history.back(); }
let allProducts = [];
const params = new URLSearchParams(window.location.search);
const categoryId = params.get("category");
const pageTitle = document.getElementById("pageTitle");
const categoryFilter = document.getElementById("categoryFilter");
const productContainer = document.getElementById("products");
const categoryFeedback = document.getElementById("categoryFeedback");
productContainer.innerHTML = "<p role=\"status\">Loading products…</p>";
const categoriesById = new Map();
let selectedCategoryId = categoryId;
if (categoryFilter) {
  categoryFilter.addEventListener("change", () => {
    const query = categoryFilter.value ? `?category=${encodeURIComponent(categoryFilter.value)}` : "";
    window.location.href = `products.html${query}`;
  });
}

async function loadCatalog() {
  try {
    const categoriesResponse = await fetch("/api/categories");
    if (!categoriesResponse.ok) throw new Error("Categories could not be loaded.");
    const categories = await categoriesResponse.json();
    if (!Array.isArray(categories)) throw new Error("The category response was invalid.");
    categories.forEach(category => {
      if (!Number.isInteger(Number(category.id)) || typeof category.name !== "string") return;
      const id = String(category.id);
      categoriesById.set(id, category.name);
      if (categoryFilter) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = category.name;
        categoryFilter.appendChild(option);
      }
    });
  } catch (error) {
    console.error("Category request failed:", error);
    if (selectedCategoryId) {
      selectedCategoryId = null;
      if (window.history.replaceState) window.history.replaceState(null, "", "products.html");
      if (categoryFilter) categoryFilter.value = "";
      if (pageTitle) pageTitle.textContent = "✨ All Products";
    }
    if (categoryFeedback) {
      categoryFeedback.textContent = "Category filters are temporarily unavailable; all products are still shown.";
      categoryFeedback.setAttribute("role", "alert");
    }
  }

  if (categoryFilter && categoriesById.has(selectedCategoryId)) categoryFilter.value = selectedCategoryId;
  if (pageTitle && !selectedCategoryId) pageTitle.textContent = "✨ All Products";
  else if (pageTitle) pageTitle.textContent = selectedCategoryId && categoriesById.has(selectedCategoryId)
    ? categoriesById.get(selectedCategoryId)
    : "✨ All Products";

  try {
    const response = await fetch("/api/products");
    if (!response.ok) throw new Error("Products could not be loaded.");
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("The product response was invalid.");
    allProducts = data.filter(product => product.inStock);
    if (selectedCategoryId) allProducts = allProducts.filter(product => String(product.categoryId) === selectedCategoryId);
    renderProducts(allProducts);
  } catch (error) {
    console.error("Product request failed:", error);
    productContainer.innerHTML = "<p role=\"alert\">Products are temporarily unavailable. Please try again shortly.</p>";
  }
}
loadCatalog();
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

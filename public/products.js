function goBack() { window.history.back(); }
let allProducts = [];
const params = new URLSearchParams(window.location.search);
const categoryId = params.get("category");
const pageTitle = document.getElementById("pageTitle");
const categoryFilter = document.getElementById("categoryFilter");
const productContainer = document.getElementById("products");
const categoryFeedback = document.getElementById("categoryFeedback");
const searchToggle = document.getElementById("productSearchToggle");
const searchPanel = document.getElementById("productSearchPanel");
const searchClose = document.getElementById("productSearchClose");
productContainer.innerHTML = "<p role=\"status\">Loading products…</p>";
const categoriesById = new Map();
let selectedCategoryId = categoryId;

function safeProductImageUrl(value) {
  if (typeof value !== "string") return "";
  const source = value.trim();
  if (!source || /[\u0000-\u001f\u007f<>"'`]/.test(source)) return "";
  if (source.startsWith("/")) {
    if (source.startsWith("//") || source.includes("\\") || source.split(/[?#]/, 1)[0].split("/").includes("..")) return "";
    try { return new URL(source, "https://art-corner.invalid").origin === "https://art-corner.invalid" ? source : ""; }
    catch { return ""; }
  }
  try {
    const url = new URL(source);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
if (categoryFilter) {
  categoryFilter.addEventListener("change", () => {
    const query = categoryFilter.value ? `?category=${encodeURIComponent(categoryFilter.value)}` : "";
    window.location.href = `products.html${query}`;
  });
}

function closeProductSearch(returnFocus = true) {
  if (!searchPanel || searchPanel.hidden) return;
  searchPanel.hidden = true;
  searchToggle?.setAttribute("aria-expanded", "false");
  searchToggle?.setAttribute("aria-label", "Open product search");
  if (returnFocus) searchToggle?.focus();
}

searchToggle?.addEventListener("click", () => {
  const opening = searchPanel.hidden;
  searchPanel.hidden = !opening;
  searchToggle.setAttribute("aria-expanded", String(opening));
  searchToggle.setAttribute("aria-label", opening ? "Close product search" : "Open product search");
  if (opening) searchInput?.focus();
});
searchClose?.addEventListener("click", () => closeProductSearch());
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && searchPanel && !searchPanel.hidden) closeProductSearch();
});

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
  productContainer.replaceChildren();
  if (!products.length) {
    const empty = document.createElement("p");
    empty.className = "products-empty-state";
    empty.textContent = "No products match your search yet.";
    productContainer.appendChild(empty);
    return;
  }
  products.forEach(product => {
    const card = document.createElement("article");
    card.className = "product-listing-card";
    const productLink = document.createElement("a");
    productLink.className = "product-listing-link";
    productLink.href = `product.html?id=${encodeURIComponent(product._id)}`;
    const imageUrl = safeProductImageUrl(product.image);
    if (imageUrl) {
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = typeof product.name === "string" ? product.name : "Handmade product";
      image.loading = "lazy";
      productLink.appendChild(image);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "product-listing-image-placeholder";
      placeholder.textContent = "Image unavailable";
      placeholder.setAttribute("aria-label", "Product image unavailable");
      productLink.appendChild(placeholder);
    }
    const details = document.createElement("span");
    details.className = "product-listing-details";
    const title = document.createElement("h3");
    title.textContent = typeof product.name === "string" ? product.name : "Handmade product";
    const price = document.createElement("p");
    price.textContent = `₹${Number.isFinite(Number(product.price)) ? Number(product.price) : "Price unavailable"}`;
    details.append(title, price);
    productLink.appendChild(details);
    const addButton = document.createElement("button");
    addButton.className = "product-listing-add-button";
    addButton.type = "button";
    addButton.textContent = "Add to Cart";
    addButton.setAttribute("aria-label", `Add ${typeof product.name === "string" ? product.name : "handmade product"} to cart`);
    addButton.addEventListener("click", () => addProductToCart(product, addButton));
    card.append(productLink, addButton);
    productContainer.appendChild(card);
  });
}
const searchInput = document.getElementById("search");
if (searchInput) searchInput.addEventListener("input", filterProducts);
function filterProducts() {
  const search = searchInput.value.toLowerCase().trim();
  renderProducts(allProducts.filter(product => String(product.name || "").toLowerCase().includes(search)));
}

function addProductToCart(product, button) {
  if (!product?._id || product.inStock !== true) return;
  try {
    let cart = JSON.parse(localStorage.getItem("cart") || "[]");
    if (!Array.isArray(cart)) cart = [];
    const existing = cart.find(item => item?._id === product._id);
    if (existing) {
      const quantity = Number.isSafeInteger(Number(existing.qty)) && Number(existing.qty) > 0 ? Number(existing.qty) : 1;
      if (quantity >= 99) {
        button.textContent = "Maximum quantity reached";
        return;
      }
      existing.qty = quantity + 1;
    } else {
      cart.push({ ...product, qty: 1 });
    }
    localStorage.setItem("cart", JSON.stringify(cart));
    if (typeof announceCartUpdated === "function") announceCartUpdated();
    button.textContent = "Added to cart";
    button.setAttribute("aria-live", "polite");
  } catch (error) {
    console.error("Cart update failed:", error);
    button.textContent = "Could not add item";
  }
}

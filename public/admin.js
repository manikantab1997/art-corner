
function goBack() { window.history.back(); }
const productsContainer = document.getElementById("products");
productsContainer.innerHTML = "<p role=\"status\">Loading products…</p>";
const categorySelect = document.getElementById("category");
const categoryFeedback = document.getElementById("categoryFeedback");

async function loadCategories(selectedId = "") {
  const response = await fetch("/api/categories");
  if (!response.ok) throw new Error("Categories could not be loaded.");
  const categories = await response.json();
  if (!Array.isArray(categories)) throw new Error("The category response was invalid.");

  const options = [new Option("Choose a category", "")];
  categories.forEach(category => {
    if (!Number.isInteger(Number(category.id)) || typeof category.name !== "string") return;
    options.push(new Option(category.name, String(category.id)));
  });
  if (categories.length === 0) {
    options[0] = new Option("No categories yet — manage categories", "");
    categoryFeedback.textContent = "No categories exist yet. Create one on the Category Management page.";
    categoryFeedback.setAttribute("role", "status");
  }
  categorySelect.replaceChildren(...options);
  if (selectedId && categories.some(category => String(category.id) === String(selectedId))) {
    categorySelect.value = String(selectedId);
  }
  return categories;
}

async function loadProducts() {
  try {
    const response = await fetch("/api/admin/products");
    if (!response.ok) throw new Error("Could not load products.");
    const products = await response.json();
    if (!Array.isArray(products)) throw new Error("The product response was invalid.");
    productsContainer.innerHTML = "";
    if (!products.length) {
      productsContainer.innerHTML = "<p>No products are available in this list.</p>";
      return;
    }
    products.forEach(product => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<img src="${product.image}" alt="${product.name}" width="100"><h3>${product.name}</h3><p>₹${product.price}</p><p>${product.inStock ? "In Stock" : "Out of Stock"}</p><button onclick="deleteProduct('${product._id}')">Delete</button><button onclick="toggleStock('${product._id}')">Toggle Stock</button>`;
      const customizationLabel = document.createElement("label");
      customizationLabel.className = "admin-product-customization";
      const customizationCheckbox = document.createElement("input");
      customizationCheckbox.type = "checkbox";
      customizationCheckbox.checked = product.customizationEnabled === true;
      customizationCheckbox.setAttribute("aria-label", `Enable customization enquiries for ${product.name || "this product"}`);
      customizationCheckbox.addEventListener("change", () => updateCustomization(product._id, customizationCheckbox));
      customizationLabel.append(customizationCheckbox, document.createTextNode(" Enable customization enquiries"));
      card.appendChild(customizationLabel);
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
    alert("Enter a product name, valid price, choose a category, and select an image.");
    return;
  }
  const formData = new FormData();
  formData.append("name", name);
  formData.append("price", price);
  formData.append("categoryId", categoryId);
  formData.append("image", file);
  formData.append("customizationEnabled", document.getElementById("customizationEnabled").checked ? "true" : "false");
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
async function updateCustomization(id, checkbox) {
  const requestedValue = checkbox.checked;
  checkbox.disabled = true;
  try {
    const response = await fetch(`/api/products/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customizationEnabled: requestedValue })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Customization setting could not be saved.");
  } catch (error) {
    checkbox.checked = !requestedValue;
    alert(error.message || "Customization setting could not be saved.");
  } finally {
    checkbox.disabled = false;
  }
}
requireAdminPage().then(isAdmin => {
  if (!isAdmin) return;
  loadCategories().catch(error => {
    console.error("Category list request failed:", error);
    categorySelect.replaceChildren(new Option("Categories unavailable", ""));
    categoryFeedback.textContent = "Categories could not be loaded. Please refresh before adding a product.";
    categoryFeedback.setAttribute("role", "alert");
  });
  loadProducts();
});

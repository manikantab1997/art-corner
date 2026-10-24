const container = document.getElementById("categories");
const allProductsTab = document.createElement("a");
allProductsTab.className = "category-tab active";
allProductsTab.href = "products.html";
allProductsTab.textContent = "All Products";
allProductsTab.setAttribute("aria-current", "page");
container.appendChild(allProductsTab);

fetch("/api/categories")
  .then(async response => {
    if (!response.ok) throw new Error("Categories could not be loaded.");
    return response.json();
  })
  .then(categories => {
    if (!Array.isArray(categories)) throw new Error("The category response was invalid.");
    categories.forEach(category => {
      if (!Number.isInteger(Number(category.id)) || typeof category.name !== "string") return;
      const tab = document.createElement("a");
      tab.className = "category-tab";
      tab.href = `products.html?category=${encodeURIComponent(category.id)}`;
      tab.textContent = category.name;
      container.appendChild(tab);
    });
  })
  .catch(error => {
    console.error("Category request failed:", error);
    const message = document.createElement("p");
    message.className = "category-error";
    message.setAttribute("role", "alert");
    message.textContent = "Categories are temporarily unavailable. You can still browse all products.";
    container.appendChild(message);
  });

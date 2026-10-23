const container = document.getElementById("categories");
container.innerHTML = "<p role=\"status\">Loading categories…</p>";
fetch("/api/categories")
  .then(async response => {
    if (!response.ok) throw new Error("Categories could not be loaded.");
    return response.json();
  })
  .then(categories => {
    container.innerHTML = "";
    if (!Array.isArray(categories) || categories.length === 0) {
      container.innerHTML = "<p>No categories are available right now.</p>";
      return;
    }
    categories.forEach(category => {
      const card = document.createElement("a");
      card.className = "card";
      card.href = `products.html?category=${encodeURIComponent(category.id)}`;
      card.innerHTML = `<img src="${category.image}" alt="" /><h3>${category.name}</h3>`;
      container.appendChild(card);
    });
  })
  .catch(error => {
    console.error("Category request failed:", error);
    container.innerHTML = "<p role=\"alert\">Categories are temporarily unavailable. Please refresh to try again.</p>";
  });

function goBack() {
  window.history.back();
}

let allProducts = [];

const params = new URLSearchParams(window.location.search);
const categoryId = params.get("category");

const pageTitle = document.getElementById("pageTitle");

const categoryNames = {
  "1": "🕯️ Candles",
  "2": "🎨 Resin Art",
  "3": "📿 Bracelets"
};

fetch("/api/products")
  .then(res => {
    if (!res.ok) {
      throw new Error("Failed to load products");
    }
    return res.json();
  })
  .then(data => {

    // Show only in-stock products to customers
    data = data.filter(product => product.inStock);

    if (categoryId) {

      allProducts = data.filter(
        product => product.categoryId == categoryId
      );

      if (pageTitle) {
        pageTitle.innerText =
          categoryNames[categoryId] || "Products";
      }

    } else {

      allProducts = [...data];

      // Random order for All Products page
      allProducts.sort(() => Math.random() - 0.5);

      if (pageTitle) {
        pageTitle.innerText = "✨ All Products";
      }

    }

    renderProducts(allProducts);
  })
  .catch(error => {
    console.error(error);

    document.getElementById("products").innerHTML =
      "<p>Failed to load products.</p>";
  });

function renderProducts(products) {

  const container = document.getElementById("products");

  container.innerHTML = "";

  if (products.length === 0) {
    container.innerHTML = "<p>No products found</p>";
    return;
  }

  products.forEach(product => {

    const div = document.createElement("div");

    div.className = "card";

    div.innerHTML = `
            <img src="${product.image}" alt="${product.name}">
            <h3>${product.name}</h3>
            <p>₹${product.price}</p>
        `;

    div.onclick = () => {
      window.location.href =
        `product.html?id=${product._id}`;
    };

    container.appendChild(div);
  });
}

const searchInput = document.getElementById("search");

if (searchInput) {
  searchInput.addEventListener("input", filterProducts);
}

function filterProducts() {

  const search =
    document.getElementById("search")
      .value
      .toLowerCase();

  const filtered = allProducts.filter(product =>
    product.name.toLowerCase().includes(search)
  );

  renderProducts(filtered);
}
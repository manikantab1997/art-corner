function goBack() {
  window.history.back();
}

let allProducts = [];

const params = new URLSearchParams(window.location.search);
const categoryId = Number(params.get("category"));


console.log("Category ID:", categoryId);

// Fetch ALL products
fetch(`/api/products`)
  .then(res => res.json())
  .then(data => {
    // Filter by category
    allProducts = data.filter(p => p.categoryId == categoryId);
    renderProducts(allProducts);
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
      <img src="${product.image}" />
      <h3>${product.name}</h3>
      <p>₹${product.price}</p>
      <p style="color:${product.inStock ? 'green' : 'red'}">
        ${product.inStock ? 'Available' : 'Out of Stock'}
      </p>
    `;

    div.onclick = () => {
      if (!product.inStock) {
        alert("Out of stock");
        return;
      }

      window.location.href = `product.html?id=${product._id}`;
    };

    container.appendChild(div);
  });
}

// Search
document.getElementById("search").oninput = filterProducts;

function filterProducts() {
  const search = document.getElementById("search").value.toLowerCase();

  const filtered = allProducts.filter(p =>
    p.name.toLowerCase().includes(search)
  );

  renderProducts(filtered);
}
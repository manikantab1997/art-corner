// Back button
function goBack() {
  window.history.back();
}

// Get product ID
const params = new URLSearchParams(window.location.search);
const productId = params.get("id");

// ❗ Safety check
if (!productId) {
  alert("Invalid product");
  window.location.href = "index.html";
}

let currentProduct = null;

// Fetch product
fetch(`/api/product/${productId}`)
  .then(res => res.json())
  .then(product => {
    currentProduct = product;

    const container = document.getElementById("product");

    container.innerHTML = `
      <img src="${product.image}" width="200" />
      <h2>${product.name}</h2>
      <p>₹${product.price}</p>
      <p style="color:${product.inStock ? 'green' : 'red'}">
        ${product.inStock ? 'Available' : 'Out of Stock'}
      </p>
    `;
  });

// Add to cart
document.getElementById("addToCart").onclick = () => {

  if (!currentProduct.inStock) {
    alert("Product is out of stock");
    return;
  }

  let cart = JSON.parse(localStorage.getItem("cart")) || [];

  const existing = cart.find(item => item._id === currentProduct._id);

  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ ...currentProduct, qty: 1 });
  }

  localStorage.setItem("cart", JSON.stringify(cart));

  alert("Added to cart!");
};
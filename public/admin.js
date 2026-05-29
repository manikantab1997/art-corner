if (localStorage.getItem("isAdmin") !== "true") {
    window.location.href = "login.html";
}
function goBack() {
    window.history.back();
}

async function loadProducts() {
    const res = await fetch("/api/products");
    const products = await res.json();

    const container = document.getElementById("products");
    container.innerHTML = "";

    products.forEach(p => {
        const div = document.createElement("div");
        div.className = "card";

        div.innerHTML = `
      <img src="${p.image}" width="100">
        <h3>${p.name}</h3>
      <p>₹${p.price}</p>
      <p>${p.inStock ? "In Stock" : "Out of Stock"}</p>

      <button onclick="deleteProduct('${p._id}')">Delete</button>
      <button onclick="toggleStock('${p._id}')">Toggle Stock</button>
    `;

        container.appendChild(div);
    });
}

async function addProduct() {
    const formData = new FormData();

    formData.append("name", document.getElementById("name").value);
    formData.append("price", document.getElementById("price").value);

    // ✅ THIS LINE WAS MISSING (VERY IMPORTANT)
    formData.append("categoryId", document.getElementById("category").value);

    const file = document.getElementById("image").files[0];
    formData.append("image", file);

    await fetch("/api/products", {
        method: "POST",
        body: formData
    });

    alert("Product Added");
    loadProducts();
}

async function deleteProduct(id) {
    await fetch(`/api/products/${id}`, { method: "DELETE" });
    loadProducts();
}

async function toggleStock(id) {
    await fetch(`/api/products/${id}`, { method: "PUT" });
    loadProducts();
}

loadProducts();
function goBack() { window.history.back(); }
const params = new URLSearchParams(window.location.search);
const productId = params.get("id");
const productContainer = document.getElementById("product");
const addButton = document.getElementById("addToCart");
let currentProduct = null;
addButton.disabled = true;
if (!productId) {
  productContainer.innerHTML = "<p role=\"alert\">This product link is missing its ID. Return to the product list and choose an item.</p>";
} else {
  productContainer.innerHTML = "<p role=\"status\">Loading product…</p>";
  fetch(`/api/product/${encodeURIComponent(productId)}`)
    .then(async response => {
      const product = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(product.error || "Product could not be loaded.");
      return product;
    })
    .then(product => {
      currentProduct = product;
      productContainer.innerHTML = `<img src="${product.image}" alt="${product.name}" /><h2>${product.name}</h2><p>₹${product.price}</p><p style="color:${product.inStock ? 'green' : 'red'}">${product.inStock ? 'Available' : 'Out of Stock'}</p>`;
      if (product.customizationEnabled === true) {
        const enquiry = document.createElement("section");
        enquiry.className = "product-customization";
        enquiry.setAttribute("aria-labelledby", "customization-heading");
        const heading = document.createElement("h3");
        heading.id = "customization-heading";
        heading.textContent = "Discuss customization";
        const description = document.createElement("p");
        description.textContent = `Ask us about customizing ${product.name || "this product"}.`;
        const links = document.createElement("div");
        links.className = "product-customization-links";

        const message = `Hi, I'd like to ask about customizing ${product.name || "this product"}. Could you share the available options?`;
        const whatsapp = document.createElement("a");
        whatsapp.href = `https://wa.me/919380125087?text=${encodeURIComponent(message)}`;
        whatsapp.target = "_blank";
        whatsapp.rel = "noopener noreferrer";
        whatsapp.textContent = "Ask on WhatsApp";
        whatsapp.setAttribute("aria-label", `Ask about customizing ${product.name || "this product"} on WhatsApp`);

        const instagram = document.createElement("a");
        instagram.href = "https://www.instagram.com/art_corner_blr/";
        instagram.target = "_blank";
        instagram.rel = "noopener noreferrer";
        instagram.textContent = "Message us on Instagram";
        instagram.setAttribute("aria-label", "Message Art Corner Bengaluru on Instagram about customization");
        links.append(whatsapp, instagram);
        enquiry.append(heading, description, links);
        productContainer.appendChild(enquiry);
      }
      addButton.disabled = !product.inStock;
    })
    .catch(error => {
      console.error("Product detail request failed:", error);
      productContainer.innerHTML = `<p role="alert">${error.message || "Product could not be loaded. Please try again."}</p>`;
    });
}
addButton.onclick = () => {
  if (!currentProduct || !currentProduct.inStock) return;
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem("cart") || "[]"); } catch { cart = []; }
  const existing = cart.find(item => item._id === currentProduct._id);
  if (existing) existing.qty = Number(existing.qty || 1) + 1;
  else cart.push({ ...currentProduct, qty: 1 });
  localStorage.setItem("cart", JSON.stringify(cart));
  addButton.textContent = "Added to cart";
};

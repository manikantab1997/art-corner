function goBack() { window.history.back(); }
const params = new URLSearchParams(window.location.search);
const productId = params.get("id");
const productContainer = document.getElementById("product");
const addButton = document.getElementById("addToCart");
let currentProduct = null;
addButton.disabled = true;

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

function renderProduct(product) {
  productContainer.replaceChildren();
  const imageUrl = safeProductImageUrl(product.image);
  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = typeof product.name === "string" ? product.name : "Handmade product";
    image.loading = "lazy";
    productContainer.appendChild(image);
  }
  const title = document.createElement("h2");
  title.textContent = typeof product.name === "string" ? product.name : "Handmade product";
  const price = document.createElement("p");
  price.textContent = `₹${Number.isFinite(Number(product.price)) ? Number(product.price) : "Price unavailable"}`;
  const availability = document.createElement("p");
  availability.className = product.inStock ? "product-available" : "product-unavailable";
  availability.textContent = product.inStock ? "Available" : "Out of Stock";
  productContainer.append(title, price, availability);
}

function renderProductError(message) {
  productContainer.replaceChildren();
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  error.textContent = message;
  productContainer.appendChild(error);
}

if (!productId) {
  renderProductError("This product link is missing its ID. Return to the product list and choose an item.");
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
      renderProduct(product);
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
      renderProductError(error.message || "Product could not be loaded. Please try again.");
    });
}
addButton.onclick = () => {
  if (!currentProduct || !currentProduct.inStock) return;
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem("cart") || "[]"); } catch { cart = []; }
  const existing = cart.find(item => item._id === currentProduct._id);
  if (existing) {
    const quantity = Number.isSafeInteger(Number(existing.qty)) && Number(existing.qty) > 0 ? Number(existing.qty) : 1;
    if (quantity >= 99) {
      addButton.textContent = "Maximum quantity reached";
      return;
    }
    existing.qty = quantity + 1;
  }
  else cart.push({ ...currentProduct, qty: 1 });
  localStorage.setItem("cart", JSON.stringify(cart));
  if (typeof announceCartUpdated === "function") announceCartUpdated();
  addButton.textContent = "Added to cart";
};

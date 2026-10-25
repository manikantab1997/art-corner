function goBack() { window.history.back(); }
const container = document.getElementById("cart");
const subtotalEl = document.getElementById("subtotal");
const totalEl = document.getElementById("total");
const cartStatus = document.getElementById("cartStatus");
const checkoutLink = document.getElementById("checkoutLink");
let cart = readCart();
let availableProductIds = null;

function readCart() {
    try {
        const value = JSON.parse(localStorage.getItem("cart") || "[]");
        return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && typeof item._id === "string" && item._id.length > 0).map(item => ({
            ...item,
            qty: Number.isSafeInteger(Number(item.qty)) && Number(item.qty) > 0 ? Math.min(Number(item.qty), 99) : 1
        })) : [];
    } catch {
        return [];
    }
}

function safeImageUrl(value) {
    const source = typeof value === "string" ? value.trim() : "";
    if (source.startsWith("/") && !source.startsWith("//") && !source.includes("\\") && !source.split(/[?#]/, 1)[0].split("/").includes("..")) return source;
    try { return new URL(source).protocol === "https:" ? source : ""; }
    catch { return ""; }
}

function updateAvailabilityMessage() {
    if (!cart.length) return;
    const unavailable = availableProductIds && cart.some(item => !availableProductIds.has(item._id));
    const invalidPrice = cart.some(item => !Number.isFinite(Number(item.price)) || Number(item.price) < 0);
    if (invalidPrice) {
        cartStatus.textContent = "An item has an invalid saved price. Remove it before continuing.";
        cartStatus.setAttribute("role", "alert");
    } else if (unavailable) {
        cartStatus.textContent = "One or more items are currently unavailable. They remain in your cart; please review them before placing your order.";
        cartStatus.setAttribute("role", "status");
    } else if (availableProductIds === null) {
        cartStatus.textContent = "Availability could not be refreshed. Your saved cart is unchanged.";
        cartStatus.setAttribute("role", "status");
    } else {
        cartStatus.textContent = "All items are currently listed as in stock.";
        cartStatus.setAttribute("role", "status");
    }
    checkoutLink.setAttribute("aria-disabled", String(invalidPrice));
    checkoutLink.classList.toggle("is-disabled", invalidPrice);
    checkoutLink.tabIndex = invalidPrice ? -1 : 0;
}

function makeCartItem(item) {
    const card = document.createElement("article");
    card.className = "cart-item";
    const image = document.createElement("img");
    const visual = document.createElement("div");
    visual.className = "cart-item-visual";
    image.className = "cart-item-image";
    image.alt = item.name || "Handmade product";
    image.loading = "lazy";
    const source = safeImageUrl(item.image);
    if (source) image.src = source;
    else image.hidden = true;
    const imagePlaceholder = document.createElement("span");
    imagePlaceholder.className = "cart-item-placeholder";
    imagePlaceholder.textContent = "Image unavailable";
    imagePlaceholder.hidden = Boolean(source);
    image.addEventListener("error", () => { image.hidden = true; imagePlaceholder.hidden = false; });
    visual.append(image, imagePlaceholder);
    card.appendChild(visual);

    const details = document.createElement("div");
    details.className = "cart-item-details";
    const name = document.createElement("h2");
    name.textContent = item.name || "Handmade product";
    const price = document.createElement("p");
    price.className = "cart-item-price";
    const validPrice = Number.isFinite(Number(item.price)) && Number(item.price) >= 0;
    price.textContent = validPrice ? `₹${Number(item.price).toFixed(2)} each` : "Price unavailable";
    details.append(name, price);
    if (availableProductIds && !availableProductIds.has(item._id)) {
        card.classList.add("is-unavailable");
        const unavailable = document.createElement("p");
        unavailable.className = "cart-item-availability";
        unavailable.textContent = "Currently unavailable";
        details.appendChild(unavailable);
    }

    const controls = document.createElement("div");
    controls.className = "cart-item-controls";
    const quantityLabel = document.createElement("span");
    quantityLabel.className = "cart-quantity-label";
    quantityLabel.textContent = `Quantity: ${item.qty}`;
    const quantity = document.createElement("div");
    quantity.className = "quantity-control";
    const decreaseButton = document.createElement("button");
    decreaseButton.type = "button";
    decreaseButton.textContent = "−";
    decreaseButton.setAttribute("aria-label", `Decrease ${item.name || "product"} quantity`);
    decreaseButton.disabled = item.qty <= 1;
    decreaseButton.addEventListener("click", () => decrease(item._id));
    const quantityValue = document.createElement("span");
    quantityValue.textContent = String(item.qty);
    quantityValue.setAttribute("aria-live", "polite");
    const increaseButton = document.createElement("button");
    increaseButton.type = "button";
    increaseButton.textContent = "+";
    increaseButton.setAttribute("aria-label", `Increase ${item.name || "product"} quantity`);
    increaseButton.disabled = item.qty >= 99;
    increaseButton.addEventListener("click", () => increase(item._id));
    quantity.append(decreaseButton, quantityValue, increaseButton);
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-cart-item";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", `Remove ${item.name || "product"} from cart`);
    removeButton.addEventListener("click", () => removeItem(item._id));
    controls.append(quantityLabel, quantity, removeButton);
    card.append(details, controls);
    return card;
}

function renderCart() {
    container.replaceChildren();
    if (cart.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cart-empty-state";
        const title = document.createElement("h2");
        title.textContent = "Your cart is waiting for something lovely";
        const message = document.createElement("p");
        message.textContent = "Browse the handmade collection and add a piece you love.";
        const shop = document.createElement("a");
        shop.className = "primary-link-button";
        shop.href = "products.html";
        shop.textContent = "Shop Products";
        empty.append(title, message, shop);
        container.appendChild(empty);
        subtotalEl.textContent = "₹0.00";
        totalEl.textContent = "₹0.00";
        cartStatus.textContent = "";
        checkoutLink.hidden = true;
        return;
    }
    checkoutLink.hidden = false;
    let subtotal = 0;
    let hasInvalidPrice = false;
    cart.forEach(item => {
        const price = Number(item.price);
        if (!Number.isFinite(price) || price < 0) hasInvalidPrice = true;
        else subtotal += price * item.qty;
        container.appendChild(makeCartItem(item));
    });
    subtotalEl.textContent = `₹${subtotal.toFixed(2)}`;
    totalEl.textContent = `₹${subtotal.toFixed(2)}`;
    updateAvailabilityMessage();
    if (hasInvalidPrice) checkoutLink.setAttribute("aria-disabled", "true");
}

function increase(id) {
    const item = cart.find(product => product._id === id);
    if (!item || item.qty >= 99) return;
    item.qty += 1;
    updateCart();
}
function decrease(id) {
    const item = cart.find(product => product._id === id);
    if (!item || item.qty <= 1) return;
    item.qty -= 1;
    updateCart();
}
function removeItem(id) {
    cart = cart.filter(product => product._id !== id);
    updateCart();
}
function updateCart() {
    localStorage.setItem("cart", JSON.stringify(cart));
    if (typeof announceCartUpdated === "function") announceCartUpdated();
    renderCart();
}

async function refreshAvailability() {
    try {
        const response = await fetch("/api/products");
        if (!response.ok) throw new Error("Product availability unavailable");
        const products = await response.json();
        if (!Array.isArray(products)) throw new Error("Product availability response invalid");
        availableProductIds = new Set(products.filter(product => product?.inStock === true).map(product => String(product._id)));
    } catch {
        availableProductIds = null;
    }
    renderCart();
}

window.addEventListener("storage", event => {
    if (!event.key || event.key === "cart") {
        cart = readCart();
        renderCart();
    }
});
renderCart();
refreshAvailability();

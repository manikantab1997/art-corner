const cartUpdatedEventName = "artcorner:cart-updated";
const shopSoundPreferenceKey = "artcorner.sound-enabled";
let floatingCartFooterVisible = false;
let previousCartQuantity = null;
let shopToastElement = null;
let shopToastDismissTimer = null;
let shopToastHideTimer = null;
const cartButtonUnlockTimers = new WeakMap();

function getCartQuantity() {
    try {
        const cart = JSON.parse(localStorage.getItem("cart") || "[]");
        return Array.isArray(cart) ? cart.reduce((sum, item) => {
            const quantity = Number(item?.qty);
            return Number.isSafeInteger(quantity) && quantity > 0 ? sum + quantity : sum;
        }, 0) : 0;
    } catch {
        return 0;
    }
}

function updateCartBadges() {
    const quantity = getCartQuantity();
    const badges = [...document.querySelectorAll("[data-cart-count]")];
    badges.forEach(badge => {
        badge.textContent = quantity > 99 ? "99+" : String(quantity);
        badge.hidden = quantity === 0;
        const link = badge.closest("a");
        if (link) link.setAttribute("aria-label", `Cart, ${quantity} ${quantity === 1 ? "item" : "items"}`);
        if (previousCartQuantity !== null && previousCartQuantity !== quantity) {
            badge.classList.remove("cart-count-bounce");
            void badge.offsetWidth;
            badge.classList.add("cart-count-bounce");
        }
    });
    previousCartQuantity = quantity;
    const floatingCart = document.querySelector("[data-floating-cart]");
    if (floatingCart) {
        const page = (window.location.pathname || "").split("/").pop().toLowerCase();
        const cartControlsOnPage = page === "cart.html" || page === "checkout.html";
        const adminPage = ["admin.html", "dashboard.html", "orders.html", "categories.html"].includes(page);
        floatingCart.hidden = quantity === 0 || cartControlsOnPage || adminPage || floatingCartFooterVisible;
        floatingCart.setAttribute("aria-label", `Cart, ${quantity} ${quantity === 1 ? "item" : "items"}`);
    }
}

function addCartItemFromClick(product, button) {
    if (!product || typeof product._id !== "string" || !product._id || product.inStock !== true || button?.disabled) return false;
    if (button) button.disabled = true;
    try {
        let cart;
        try { cart = JSON.parse(localStorage.getItem("cart") || "[]"); }
        catch { cart = []; }
        if (!Array.isArray(cart)) cart = [];
        const existing = cart.find(item => item && item._id === product._id);
        if (existing) {
            const quantity = Number.isSafeInteger(Number(existing.qty)) && Number(existing.qty) > 0 ? Number(existing.qty) : 1;
            if (quantity >= 99) {
                if (button) button.textContent = "Maximum quantity reached";
                showShopToast("This product has reached the cart quantity limit.", { error: true });
                return false;
            }
            existing.qty = quantity + 1;
        } else {
            cart.push({ ...product, qty: 1 });
        }
        localStorage.setItem("cart", JSON.stringify(cart));
        announceCartUpdated();
        if (button) {
            button.textContent = "Added to cart";
            button.setAttribute("aria-live", "polite");
            button.classList.remove("cart-added-pop");
            void button.offsetWidth;
            button.classList.add("cart-added-pop");
        }
        showShopToast(`${typeof product.name === "string" && product.name.trim() ? product.name : "Product"} added to cart!`);
        playShopSound("cart");
        return true;
    } catch (error) {
        console.error("Cart update failed:", error);
        if (button) button.textContent = "Could not add item";
        showShopToast("Something went wrong. Please try again.", { error: true });
        return false;
    } finally {
        if (button) {
            clearTimeout(cartButtonUnlockTimers.get(button));
            const timer = setTimeout(() => {
                button.disabled = false;
                cartButtonUnlockTimers.delete(button);
            }, 180);
            cartButtonUnlockTimers.set(button, timer);
        }
    }
}

function showShopToast(message, { error = false, duration = 3000 } = {}) {
    if (!shopToastElement) {
        shopToastElement = document.createElement("div");
        shopToastElement.id = "shopToast";
        shopToastElement.className = "shop-toast";
        shopToastElement.hidden = true;
        document.body.appendChild(shopToastElement);
    }
    clearTimeout(shopToastDismissTimer);
    clearTimeout(shopToastHideTimer);
    shopToastElement.textContent = String(message || "");
    shopToastElement.setAttribute("role", error ? "alert" : "status");
    shopToastElement.setAttribute("aria-live", error ? "assertive" : "polite");
    shopToastElement.setAttribute("aria-atomic", "true");
    shopToastElement.classList.toggle("shop-toast-error", error);
    shopToastElement.hidden = false;
    shopToastElement.classList.remove("shop-toast-visible");
    const show = () => shopToastElement?.classList.add("shop-toast-visible");
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(show);
    else setTimeout(show, 0);
    shopToastDismissTimer = setTimeout(() => {
        shopToastElement?.classList.remove("shop-toast-visible");
        shopToastHideTimer = setTimeout(() => {
            if (shopToastElement) shopToastElement.hidden = true;
        }, 220);
    }, Math.max(1000, Number(duration) || 3000));
}

function areShopSoundsEnabled() {
    try { return localStorage.getItem(shopSoundPreferenceKey) !== "false"; }
    catch { return true; }
}

function updateShopSoundToggles(root = document) {
    const enabled = areShopSoundsEnabled();
    root.querySelectorAll("[data-shop-sound-toggle]").forEach(button => {
        if (button.getAttribute("role") === "switch") {
            button.setAttribute("aria-checked", String(enabled));
            button.classList.toggle("is-on", enabled);
            const state = button.querySelector("[data-sound-state]");
            if (state) state.textContent = enabled ? "ON" : "OFF";
        } else {
            button.setAttribute("aria-pressed", String(enabled));
            button.textContent = enabled ? "Sound on" : "Sound off";
            button.setAttribute("aria-label", `Sound effects ${enabled ? "on" : "off"}. Activate to turn ${enabled ? "off" : "on"}.`);
        }
    });
}

function setupShopSoundToggles(root, hide = false) {
    const toggles = [...root.querySelectorAll("[data-shop-sound-toggle]")];
    if (hide) {
        toggles.forEach(button => {
            button.hidden = true;
            const preferenceWrap = button.closest?.(".mobile-sound-preference-wrap");
            if (preferenceWrap) preferenceWrap.hidden = true;
        });
        return;
    }
    updateShopSoundToggles(root);
    toggles.forEach(button => button.addEventListener("click", () => {
        const enabled = !areShopSoundsEnabled();
        try { localStorage.setItem(shopSoundPreferenceKey, String(enabled)); }
        catch {
            showShopToast("Sound preference could not be saved in this browser.", { error: true });
            return;
        }
        updateShopSoundToggles(root);
        showShopToast(`Sound effects ${enabled ? "on" : "off"}.`);
    }));
}

function playShopSound(kind = "cart") {
    if (!areShopSoundsEnabled()) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    let context;
    try {
        context = new AudioContextClass();
        if (context.state === "suspended") context.resume().catch(() => {});
        const tones = kind === "order" ? [660, 880] : [740];
        const startAt = context.currentTime;
        tones.forEach((frequency, index) => {
            const start = startAt + index * 0.085;
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(frequency, start);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.035, start + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(start);
            oscillator.stop(start + 0.17);
        });
        setTimeout(() => context.close().catch(() => {}), 450);
    } catch {
        try { context?.close(); } catch { /* Sound is optional. */ }
    }
}

function setupContextualBackLink(root) {
    const backLink = root.querySelector("[data-contextual-back]");
    if (!backLink) return;
    const navbar = root.querySelector(".navbar");
    const page = (window.location.pathname || "").split("/").pop().toLowerCase();
    const destinations = {
        "product.html": ["products.html", "← Back to products"],
        "cart.html": ["products.html", "← Continue shopping"],
        "checkout.html": ["cart.html", "← Back to cart"]
    };
    const destination = destinations[page];
    if (!destination) {
        backLink.hidden = true;
        navbar?.classList.remove("navbar-has-contextual-back");
        return;
    }
    backLink.href = destination[0];
    backLink.textContent = destination[1];
    backLink.hidden = false;
    backLink.setAttribute("aria-label", destination[1].replace(/^←\s*/, ""));
    navbar?.classList.add("navbar-has-contextual-back");
}

function observeFooterForFloatingCart() {
    const footer = document.querySelector("#footer-container .footer");
    if (!footer || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
        floatingCartFooterVisible = entries.some(entry => entry.isIntersecting);
        updateCartBadges();
    }, { threshold: 0.01 });
    observer.observe(footer);
}

function announceCartUpdated() {
    updateCartBadges();
    window.dispatchEvent(new Event(cartUpdatedEventName));
}

window.addEventListener("storage", event => {
    if (!event.key || event.key === "cart") updateCartBadges();
});
window.addEventListener(cartUpdatedEventName, updateCartBadges);

function setupMobileNavigation(root = document) {
    const toggle = root.querySelector("#mobileMenuToggle");
    const menu = root.querySelector("#mobileMenu");
    const closeButton = root.querySelector("#mobileMenuClose");
    const backdrop = root.querySelector("#mobileMenuBackdrop");
    if (!toggle || !menu || !closeButton || !backdrop) return;

    let open = false;
    const closeMenu = (returnFocus = true) => {
        if (!open) return;
        open = false;
        menu.classList.remove("is-open");
        menu.setAttribute("aria-hidden", "true");
        menu.setAttribute("inert", "");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Open menu");
        backdrop.hidden = true;
        document.body.classList.remove("mobile-menu-open");
        if (returnFocus) toggle.focus();
    };
    const openMenu = () => {
        if (open) return;
        open = true;
        backdrop.hidden = false;
        menu.classList.add("is-open");
        menu.setAttribute("aria-hidden", "false");
        menu.removeAttribute("inert");
        toggle.setAttribute("aria-expanded", "true");
        toggle.setAttribute("aria-label", "Close menu");
        document.body.classList.add("mobile-menu-open");
        closeButton.focus();
    };

    toggle.addEventListener("click", () => open ? closeMenu(false) : openMenu());
    closeButton.addEventListener("click", () => closeMenu());
    backdrop.addEventListener("click", () => closeMenu());
    menu.querySelectorAll("a[href]").forEach(link => link.addEventListener("click", () => closeMenu(false)));
    document.addEventListener("keydown", event => {
        if (!open) return;
        if (event.key === "Escape") {
            event.preventDefault();
            closeMenu();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = [...menu.querySelectorAll("a[href]:not([hidden]), button:not([disabled]):not([hidden])")];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
}

async function getAdminSession() {
    try {
        const response = await fetch("/api/admin/session", { credentials: "same-origin" });
        if (!response.ok) return false;
        const result = await response.json();
        return result.authenticated === true;
    } catch (error) {
        console.error("Could not check admin session:", error);
        return false;
    }
}

async function requireAdminPage() {
    const authenticated = await getAdminSession();
    if (!authenticated) window.location.href = "login.html";
    return authenticated;
}

async function logoutAdmin() {
    try {
        const response = await fetch("/api/admin/logout", {
            method: "POST",
            credentials: "same-origin"
        });
        if (!response.ok) throw new Error("Logout failed");
        window.location.href = "index.html";
    } catch (error) {
        console.error("Logout request failed:", error);
        alert("Could not log out. Please try again.");
    }
}

async function loadNavbar() {
    const navbarContainer = document.getElementById("navbar-container");
    if (!navbarContainer) return;
    try {
        const response = await fetch("components/navbar.html");
        if (!response.ok) throw new Error("Navigation could not be loaded.");
        navbarContainer.innerHTML = await response.text();
        setupContextualBackLink(navbarContainer);
        const currentPage = (window.location.pathname || "").split("/").pop().toLowerCase();
        setupShopSoundToggles(navbarContainer, ["admin.html", "dashboard.html", "orders.html", "categories.html", "login.html"].includes(currentPage));
        const isAdmin = await getAdminSession();
        document.querySelectorAll("[data-nav-dashboard]").forEach(link => { link.hidden = !isAdmin; });
        document.querySelectorAll("[data-nav-logout]").forEach(link => { link.hidden = !isAdmin; });
        document.querySelectorAll("[data-nav-login]").forEach(link => { link.hidden = isAdmin; });
        document.querySelectorAll("[data-nav-logout]").forEach(logoutLink => logoutLink.addEventListener("click", event => {
            event.preventDefault();
            logoutAdmin();
        }));
        setupMobileNavigation(navbarContainer);
        updateCartBadges();
    } catch (error) {
        console.error("Navigation request failed:", error);
    }
}

async function loadFooter() {
    const footerContainer = document.getElementById("footer-container");
    if (!footerContainer) return;
    try {
        const response = await fetch("/components/footer.html");
        if (!response.ok) throw new Error("Footer could not be loaded.");
        footerContainer.innerHTML = await response.text();
        observeFooterForFloatingCart();
    } catch (error) {
        console.error("Footer request failed:", error);
    }
}

loadNavbar();
loadFooter();

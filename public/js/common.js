const cartUpdatedEventName = "artcorner:cart-updated";

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
    document.querySelectorAll("[data-cart-count]").forEach(badge => {
        badge.textContent = quantity > 99 ? "99+" : String(quantity);
        badge.hidden = quantity === 0;
        const link = badge.closest("a");
        if (link) link.setAttribute("aria-label", `Cart, ${quantity} ${quantity === 1 ? "item" : "items"}`);
    });
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
    } catch (error) {
        console.error("Footer request failed:", error);
    }
}

loadNavbar();
loadFooter();

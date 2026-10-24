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
        const loginLink = document.getElementById("loginLink");
        const dashboardLink = document.getElementById("dashboardLink");
        const logoutLink = document.getElementById("logoutLink");
        if (dashboardLink) dashboardLink.style.display = isAdmin ? "inline-block" : "none";
        if (logoutLink) logoutLink.style.display = isAdmin ? "inline-block" : "none";
        if (loginLink) loginLink.style.display = isAdmin ? "none" : "inline-block";
        if (logoutLink) logoutLink.addEventListener("click", event => {
            event.preventDefault();
            logoutAdmin();
        });
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

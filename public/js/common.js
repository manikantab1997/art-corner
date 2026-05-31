async function loadNavbar() {

    const navbar = await fetch("/components/navbar.html");
    const html = await navbar.text();

    document.getElementById("navbar-container").innerHTML = html;

    const isAdmin =
        localStorage.getItem("isAdmin") === "true";

    const loginLink =
        document.getElementById("loginLink");

    const dashboardLink =
        document.getElementById("dashboardLink");

    const logoutLink =
        document.getElementById("logoutLink");

    if (dashboardLink)
        dashboardLink.style.display =
            isAdmin ? "inline-block" : "none";

    if (logoutLink)
        logoutLink.style.display =
            isAdmin ? "inline-block" : "none";

    if (loginLink)
        loginLink.style.display =
            isAdmin ? "none" : "inline-block";

    if (logoutLink) {

        logoutLink.onclick = function () {

            localStorage.removeItem("isAdmin");

            window.location.href =
                "index.html";
        };
    }
}

async function loadFooter() {

    const footer = await fetch(
        "/components/footer.html"
    );

    const html = await footer.text();

    const footerContainer =
        document.getElementById(
            "footer-container"
        );

    if (footerContainer) {
        footerContainer.innerHTML = html;
    }
}

loadNavbar();
loadFooter();
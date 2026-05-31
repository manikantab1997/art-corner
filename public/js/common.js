async function loadNavbar() {

    const navbar = await fetch("/components/navbar.html");
    const html = await navbar.text();

    document.getElementById("navbar-container").innerHTML = html;

    const adminLink = document.getElementById("adminLink");

    if (
        adminLink &&
        localStorage.getItem("isAdmin") !== "true"
    ) {
        adminLink.style.display = "none";
    }
}

async function loadFooter() {

    const footer = await fetch("/components/footer.html");
    const html = await footer.text();

    const footerContainer =
        document.getElementById("footer-container");

    if (footerContainer) {
        footerContainer.innerHTML = html;
    }
}

loadNavbar();
loadFooter();
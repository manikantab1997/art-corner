const adminLink = document.getElementById("adminLink");

if (adminLink && localStorage.getItem("isAdmin") !== "true") {
  adminLink.style.display = "none";
}
function goBack() {
    window.history.back();
}
fetch("/api/categories")
    .then(res => res.json())
    .then(data => {
        const container = document.getElementById("categories");

        data.forEach(cat => {
            const div = document.createElement("div");
            div.className = "card";

            div.innerHTML = `
  <img src="${cat.image}" />
  <h3>${cat.name}</h3>
`;

            div.onclick = () => {
                window.location.href = `products.html?category=${cat.id}`;
            };

            container.appendChild(div);
        });
    });
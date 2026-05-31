function login() {

  const username =
    document.getElementById("username").value.trim();

  const password =
    document.getElementById("password").value.trim();

  const error =
    document.getElementById("loginError");

  error.innerText = "";

  if (
    username === "admin" &&
    password === "1234"
  ) {

    localStorage.setItem("isAdmin", "true");

    window.location.href = "dashboard.html";

  } else {

    error.innerText =
      "❌ Invalid username or password";

  }
}

document
  .getElementById("loginForm")
  .addEventListener("submit", function (e) {

    e.preventDefault();

    login();

  });
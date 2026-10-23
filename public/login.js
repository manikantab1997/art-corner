const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = loginForm.querySelector('[type="submit"]');
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  loginError.textContent = "";
  button.disabled = true;

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Login failed. Please try again.");
    if (result.authenticated !== true) throw new Error("Login was not confirmed by the server.");
    window.location.href = "dashboard.html";
  } catch (error) {
    loginError.textContent = error.message || "Unable to sign in. Please try again.";
  } finally {
    button.disabled = false;
  }
});

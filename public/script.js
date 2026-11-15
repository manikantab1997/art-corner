const categoriesContainer = document.getElementById("categories");
const categoriesStatus = document.getElementById("home-category-status");
const heroCollage = document.getElementById("hero-product-collage");
const heroCollageStatus = document.getElementById("hero-collage-status");

async function fetchHomeData(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} could not be loaded.`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(`The ${label.toLowerCase()} response was invalid.`);
  return data;
}

function isLocalPreviewProduct(product) {
  return typeof product?.name === "string" && product.name.startsWith("[LOCAL PREVIEW] ");
}

function getSavedProductImageSource(value) {
  const savedImage = typeof value === "string" ? value.trim() : "";
  if (savedImage.startsWith("/") && !savedImage.startsWith("//") && !savedImage.includes("\\") &&
      !savedImage.split(/[?#]/, 1)[0].split("/").includes("..")) {
    return savedImage;
  }
  if (savedImage) {
    try {
      if (new URL(savedImage).protocol === "https:") return savedImage;
    } catch {
      // Invalid or unsupported image values use the existing placeholder.
    }
  }
  return "";
}

function getProductImageSource(product) {
  const savedImage = getSavedProductImageSource(product?.image);
  if (savedImage) return savedImage;
  if (isLocalPreviewProduct(product) && Number(product.categoryId) === 1) {
    return "/uploads/candle.jpg";
  }
  return "";
}

function renderHeroCollage(products, emptyMessage = "No homepage picks are available right now.") {
  heroCollage.replaceChildren(heroCollageStatus);
  heroCollage.classList.remove("hero-product-collage-empty");
  heroCollage.classList.remove("hero-collage-count-1");
  heroCollage.classList.remove("hero-collage-count-2");
  heroCollage.classList.remove("hero-collage-count-3");
  heroCollageStatus.hidden = false;
  const featured = products
    .filter(product => product && product._id && product.inStock !== false)
    .slice(0, 3)
    .map(product => ({ product, imageSource: getSavedProductImageSource(product?.image) }));

  if (!featured.length) {
    heroCollage.classList.add("hero-product-collage-empty");
    heroCollageStatus.textContent = products.length ? "Selected product photos are not available right now." : emptyMessage;
    return;
  }
  heroCollage.classList.add(`hero-collage-count-${featured.length}`);
  heroCollageStatus.hidden = true;

  featured.forEach(({ product, imageSource }, index) => {
    const tile = document.createElement("a");
    tile.className = "hero-collage-tile";
    tile.href = `product.html?id=${encodeURIComponent(product._id)}`;
    tile.setAttribute("aria-label", `View ${product.name || "handmade product"}`);

    const photoPlaceholder = document.createElement("span");
    photoPlaceholder.className = "hero-collage-photo-placeholder";
    photoPlaceholder.textContent = "Loading photo…";
    photoPlaceholder.setAttribute("role", "img");
    photoPlaceholder.setAttribute("aria-label", `Loading photo for ${product.name || "handmade product"}`);

    if (imageSource) {
      const image = document.createElement("img");
      image.alt = product.name || "Handmade product";
      // The API caps this above-the-fold collage at three; eager loading avoids
      // lazy images waiting inside tiles that used to be hidden until load.
      image.loading = "eager";
      image.decoding = "async";
      image.fetchPriority = index === 0 ? "high" : "auto";
      image.hidden = true;
      image.addEventListener("load", () => {
        image.hidden = false;
        photoPlaceholder.hidden = true;
      });
      image.addEventListener("error", () => {
        image.hidden = true;
        photoPlaceholder.hidden = false;
        photoPlaceholder.textContent = "Product photo unavailable";
        photoPlaceholder.setAttribute("aria-label", `Product photo unavailable for ${product.name || "handmade product"}`);
        tile.classList.add("hero-collage-tile-unavailable");
      });
      tile.append(image);
      image.src = imageSource;
    } else {
      photoPlaceholder.textContent = "Product photo unavailable";
      photoPlaceholder.setAttribute("aria-label", `Product photo unavailable for ${product.name || "handmade product"}`);
      tile.classList.add("hero-collage-tile-unavailable");
    }
    const caption = document.createElement("span");
    caption.className = "hero-collage-caption";
    const formattedPrice = Number.isFinite(Number(product.price))
      ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(product.price))
      : "Price unavailable";
    caption.textContent = `${product.name || "Handmade favourite"} · ${formattedPrice}`;
    tile.append(photoPlaceholder, caption);
    heroCollage.appendChild(tile);
  });
}

function makeCategoryCard({ name, href, product, index, allProducts = false }) {
  const card = document.createElement("a");
  card.className = `category-card${allProducts ? " category-card-all" : ""}`;
  card.href = href;
  card.style.animationDelay = `${Math.min(index, 6) * 65}ms`;

  const visual = document.createElement("span");
  visual.className = "category-card-visual";
  visual.setAttribute("aria-hidden", "true");
  const art = document.createElement("span");
  art.className = "category-card-art";
  visual.appendChild(art);

  const imageSource = getProductImageSource(product);
  if (imageSource) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.hidden = true;
    image.addEventListener("load", () => { image.hidden = false; });
    image.src = imageSource;
    visual.appendChild(image);
  }

  const copy = document.createElement("span");
  copy.className = "category-card-copy";
  const title = document.createElement("span");
  title.className = "category-card-title";
  title.textContent = name;
  const action = document.createElement("span");
  action.className = "category-card-action";
  action.textContent = allProducts ? "Discover the full collection" : "Explore collection";
  copy.append(title, action);
  card.append(visual, copy);
  return card;
}

function renderCategories(categories, products) {
  categoriesContainer.replaceChildren();
  categoriesContainer.appendChild(makeCategoryCard({
    name: "All Products",
    href: "products.html",
    product: products[0],
    index: 0,
    allProducts: true
  }));

  const validCategories = categories.filter(category =>
    category && Number.isInteger(Number(category.id)) && typeof category.name === "string" && category.name.trim()
  );
  validCategories.forEach((category, index) => {
    const representativeProduct = products.find(product => String(product.categoryId) === String(category.id));
    categoriesContainer.appendChild(makeCategoryCard({
      name: category.name,
      href: `products.html?category=${encodeURIComponent(category.id)}`,
      product: representativeProduct,
      index: index + 1
    }));
  });

  categoriesStatus.textContent = validCategories.length
    ? "Choose a collection to find something made for you."
    : "No collections are available right now. You can still shop all products.";
}

async function loadHomePage() {
  const [categoryResult, productResult, homepageResult] = await Promise.allSettled([
    fetchHomeData("/api/categories", "Categories"),
    fetchHomeData("/api/products", "Products"),
    fetchHomeData("/api/homepage-products", "Homepage products")
  ]);
  const products = productResult.status === "fulfilled"
    ? productResult.value.filter(product => product && product.inStock === true)
    : [];

  if (productResult.status === "rejected") console.error("Product request failed:", productResult.reason);
  if (homepageResult.status === "fulfilled") renderHeroCollage(homepageResult.value);
  if (homepageResult.status === "rejected") console.error("Homepage product request failed:", homepageResult.reason);
  if (homepageResult.status === "rejected") renderHeroCollage([], "Homepage picks are temporarily unavailable.");

  if (categoryResult.status === "fulfilled") {
    renderCategories(categoryResult.value, products);
  } else {
    console.error("Category request failed:", categoryResult.reason);
    categoriesContainer.replaceChildren(makeCategoryCard({
      name: "All Products",
      href: "products.html",
      product: products[0],
      index: 0,
      allProducts: true
    }));
    categoriesStatus.textContent = "Collections are temporarily unavailable. You can still browse all products.";
  }
}

loadHomePage();

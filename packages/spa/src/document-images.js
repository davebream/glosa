// SPDX-License-Identifier: Apache-2.0
// Shared render policy: never put an untrusted Markdown destination in a live src attribute.
export function imageReference(source, documentPath = "") {
  const value = String(source ?? "");
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml|avif);base64,/i.test(value)) return { data: value };
  if (/^(?:https?:)?\/\//i.test(value)) return { error: "Remote images are not loaded" };
  if (/^[a-z][\w+.-]*:/i.test(value) || value.startsWith("/")) return { error: "Image path is not allowed" };
  try {
    const path = decodeURIComponent(value.split(/[?#]/)[0]);
    const segments = path.split("/").filter((part) => part !== ".");
    if (
      !path ||
      path.includes("\\") ||
      [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      segments.some((part) => !part || part === "..")
    )
      return { error: "Image path is not allowed" };
    const folder = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/") + 1) : "";
    return { path: folder + segments.join("/") };
  } catch {
    return { error: "Image path is not allowed" };
  }
}

export function installImageRules(md) {
  md.renderer.rules.image = (tokens, index, options, _env, self) => {
    const token = tokens[index];
    const source = token.attrGet("src") ?? "";
    const alt = self.renderInlineAsText(token.children ?? [], options, {});
    const escapeHtml = md.utils.escapeHtml;
    const reason = imageReference(source).error ?? "Loading image";
    return `<span class="glosa-image" data-image-src="${escapeHtml(source)}" data-image-alt="${escapeHtml(alt)}"><span class="glosa-image-placeholder">${escapeHtml([reason, alt, source].filter(Boolean).join(": "))}</span></span>`;
  };
}

export function imageNodeView(node) {
  const dom = document.createElement("span");
  dom.className = "glosa-image";
  dom.contentEditable = "false";
  const set = (value) => {
    dom.dataset.imageSrc = value.attrs.src ?? "";
    dom.dataset.imageAlt = value.attrs.alt ?? "";
    dom.title = value.attrs.title ?? "";
  };
  set(node);
  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false;
      set(next);
      return true;
    },
    ignoreMutation: (mutation) => mutation.type !== "selection",
  };
}

/** One pane owns requests and lifetime; rich editor nodes remain transport-free. */
export function mountDocumentImages(root, { dataAccess, slug, documentPath }) {
  let generation = 0;
  let disposed = false;
  let seen = new WeakMap();
  const pending = new Map();
  let layoutFrame = null;
  const notifyLayout = () => {
    if (layoutFrame !== null || disposed) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      if (!disposed) root.dispatchEvent(new CustomEvent("glosa-image-layout", { bubbles: false }));
    });
  };
  const load = (path) => {
    if (!pending.has(path)) pending.set(path, dataAccess.getImage(slug, path));
    return pending.get(path);
  };
  async function paint(element) {
    const source = element.dataset.imageSrc;
    const alt = element.dataset.imageAlt ?? "";
    const key = `${source}\0${alt}`;
    if (seen.get(element) === key) return;
    seen.set(element, key);
    const ticket = generation;
    const current = () => !disposed && ticket === generation && seen.get(element) === key;
    const placeholder = (reason) => {
      const text = document.createElement("span");
      text.className = "glosa-image-placeholder";
      text.textContent = [reason, alt, source].filter(Boolean).join(": ");
      element.replaceChildren(text);
      notifyLayout();
    };
    const ref = imageReference(source, documentPath);
    if (ref.error) {
      placeholder(ref.error);
      return;
    }
    placeholder("Loading image");
    try {
      const data = ref.data ? { url: ref.data } : await load(ref.path);
      if (!current()) return;
      const image = document.createElement("img");
      image.alt = alt;
      image.decoding = "async";
      image.addEventListener("load", notifyLayout, { once: true });
      image.addEventListener(
        "error",
        () => {
          if (current()) placeholder("Image could not be decoded");
        },
        { once: true },
      );
      image.src = data.url;
      element.replaceChildren(image);
    } catch (error) {
      if (current()) placeholder(error?.message || "Image is missing or unreadable");
    }
  }
  function refresh() {
    for (const element of root.querySelectorAll("[data-image-src]")) void paint(element);
  }
  const observer = new MutationObserver(refresh);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-image-src", "data-image-alt"],
  });
  refresh();
  return {
    refresh() {
      generation++;
      pending.clear();
      seen = new WeakMap();
      refresh();
    },
    destroy() {
      disposed = true;
      if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
      generation++;
      pending.clear();
      observer.disconnect();
    },
  };
}

export function imageMarkdown(path, alt = "") {
  const destination = path
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
  return `![${alt.replace(/[\\[\]]/g, "\\$&")}](${destination})`;
}

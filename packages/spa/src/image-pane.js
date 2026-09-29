// SPDX-License-Identifier: Apache-2.0
// React is loaded only for a live image tab; all I/O stays in data-access.
export function createImagePane(host, { dataAccess, slug, path, onStateChange = () => {} }) {
  const element = document.createElement("section");
  element.className = "glosa-pane glosa-image-pane";
  element.tabIndex = 0;
  element.setAttribute("aria-label", `Image: ${path}`);
  host.append(element);
  let disposed = false;
  let generation = 0;
  let reactRoot;
  let libraries;
  let missing = false;
  let contentUrl = null;
  let displayedImage = null;
  const ready = refresh();

  async function refresh() {
    const ticket = ++generation;
    try {
      const [lib, image] = await Promise.all([
        (libraries ??= import("./vendor/image-viewer.js")),
        dataAccess.getImage(slug, path),
      ]);
      if (disposed || ticket !== generation) return;
      missing = false;
      if (contentUrl === image.url && reactRoot) return;
      contentUrl = image.url;
      displayedImage = image;
      reactRoot ??= lib.createRoot(element);
      reactRoot.render(lib.React.createElement(ImageView, { lib, image, path }));
      onStateChange();
    } catch (error) {
      if (disposed || ticket !== generation) return;
      missing = true;
      reactRoot?.unmount();
      reactRoot = null;
      const message = document.createElement("p");
      message.className = "glosa-image-placeholder";
      message.textContent = `${path}: ${error.message || "Image is missing or unreadable."}`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.onclick = () => void refresh();
      element.replaceChildren(message, retry);
      onStateChange();
    }
  }
  element.textContent = "Loading image…";
  return {
    kind: "image",
    get path() {
      return path;
    },
    get title() {
      return path.split("/").pop();
    },
    retarget(nextPath) {
      path = nextPath;
      element.setAttribute("aria-label", `Image: ${path}`);
      if (reactRoot && libraries && displayedImage)
        void libraries.then((lib) => {
          if (!disposed) reactRoot.render(lib.React.createElement(ImageView, { lib, image: displayedImage, path }));
        });
    },
    element,
    ready,
    isMissing: () => missing,
    refreshImages: refresh,
    focus: () => (element.querySelector(".glosa-image-canvas") ?? element).focus(),
    destroy() {
      disposed = true;
      generation++;
      reactRoot?.unmount();
      element.remove();
    },
  };
}

function ImageView({ lib, image, path }) {
  const { React, TransformWrapper, TransformComponent } = lib;
  const h = React.createElement;
  const viewport = React.useRef(null);
  const controls = React.useRef(null);
  const fitted = React.useRef(true);
  const dimensions = React.useRef({ width: 0, height: 0 });
  const [size, setSize] = React.useState(null);
  const [percent, setPercent] = React.useState(null);
  const [initialized, setInitialized] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const scaleTo = (scale) => {
    const box = viewport.current?.getBoundingClientRect();
    const { width, height } = dimensions.current;
    if (!box || !width) return;
    controls.current?.setTransform((box.width - width * scale) / 2, (box.height - height * scale) / 2, scale, 0);
  };
  const fitImage = () => {
    fitted.current = true;
    const box = viewport.current?.getBoundingClientRect();
    const { width, height } = dimensions.current;
    if (box && width && height)
      scaleTo(Math.max(0.001, Math.min(1, (box.width - 32) / width, (box.height - 32) / height)));
  };
  const actual = () => {
    fitted.current = false;
    scaleTo(1);
  };
  const zoom = (inward) => {
    fitted.current = false;
    controls.current?.[inward ? "zoomIn" : "zoomOut"](0.25, 0);
  };
  React.useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (fitted.current) fitImage();
    });
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => setFailed(false), [image.url]);
  React.useEffect(() => {
    if (initialized && size && fitted.current) fitImage();
  }, [initialized, size]);
  const keydown = (event) => {
    if (!initialized || !size) return;
    if (event.target.closest("button, input, select")) return;
    if (["+", "=", "-", "0", "1", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))
      event.preventDefault();
    if (["+", "="].includes(event.key)) zoom(true);
    if (event.key === "-") zoom(false);
    if (event.key === "0") fitImage();
    if (event.key === "1") actual();
    if (event.key.startsWith("Arrow")) {
      const state = controls.current?.instance.state;
      if (!state) return;
      fitted.current = false;
      controls.current.setTransform(
        state.positionX + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0),
        state.positionY + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0),
        state.scale,
        0,
      );
    }
  };
  const button = (label, onClick) => h("button", { type: "button", onClick, disabled: !initialized || !size }, label);
  return h(
    "div",
    { className: "glosa-image-view", onKeyDown: keydown },
    h(
      "div",
      { className: "glosa-image-toolbar", role: "toolbar", "aria-label": "Image view" },
      button("Fit", fitImage),
      button("100%", actual),
      button("Zoom out", () => zoom(false)),
      button("Zoom in", () => zoom(true)),
      h("output", { "aria-label": "Zoom" }, percent === null ? "Loading…" : `${percent}%`),
    ),
    h(
      "div",
      {
        className: "glosa-image-canvas",
        ref: viewport,
        tabIndex: 0,
        "data-ready": String(initialized && !!size && percent !== null),
        "aria-label": "Image. Plus and minus zoom, arrows pan, zero fits, one shows actual size.",
      },
      failed
        ? h("p", { className: "glosa-image-placeholder" }, "Image could not be decoded.")
        : h(
            TransformWrapper,
            {
              ref: controls,
              onInit: () => {
                setInitialized(true);
                if (fitted.current) fitImage();
              },
              minScale: 0.001,
              maxScale: 16,
              limitToBounds: false,
              // Controls and gestures update immediately. Delayed alignment or inertia must
              // never override a subsequent Fit/100% command (also respects reduced motion).
              smooth: false,
              autoAlignment: { disabled: true },
              zoomAnimation: { disabled: true },
              velocityAnimation: { disabled: true },
              doubleClick: { animationTime: 0 },
              wheel: { activationKeys: (keys) => keys.includes("Control") || keys.includes("Meta") },
              onPanningStart: () => {
                fitted.current = false;
              },
              onPinchStart: () => {
                fitted.current = false;
              },
              onZoomStart: () => {
                fitted.current = false;
              },
              onTransform: (_ref, state) => setPercent(Math.round(state.scale * 100)),
            },
            h(
              TransformComponent,
              { wrapperClass: "glosa-image-transform", contentClass: "glosa-image-transform-content" },
              h("img", {
                src: image.url,
                alt: path.split("/").pop(),
                draggable: false,
                onError: () => setFailed(true),
                onLoad: (event) => {
                  const next = { width: event.target.naturalWidth, height: event.target.naturalHeight };
                  dimensions.current = next;
                  setSize(next);
                  if (fitted.current) fitImage();
                },
              }),
            ),
          ),
    ),
    h(
      "p",
      { className: "glosa-image-metadata" },
      `${path} · ${size ? `${size.width} × ${size.height} px · ` : ""}${new Intl.NumberFormat().format(image.size)} bytes`,
    ),
  );
}

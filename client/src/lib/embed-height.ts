// ----- Iframe height reporting -----
//
// The booking app is embedded in the Squarespace marketing site via an iframe.
// An iframe does not grow to fit its contents and the parent cannot measure a
// cross-origin document, so without this the parent has to hardcode a guess at
// the height (it used to be `min-height:1300px`). The page is several times
// taller than that on mobile, which gave the iframe its own inner scrollbar —
// the guest's scroll gesture got trapped in a small window inside the page.
//
// Fix: measure our own height here and post it to the parent, which resizes the
// iframe to match. The parent half of this lives in the Squarespace code block
// (see EMBEDDING.md) and is NOT in this repo.

// Origins permitted to embed the app and receive height messages. postMessage
// silently drops a message whose targetOrigin doesn't match the real parent, so
// listing both apex and www is safe — only the actual parent ever receives one.
// Add the Squarespace preview domain here too if you need to test in-editor.
export const ALLOWED_PARENT_ORIGINS = [
  "https://studioclyx.com",
  "https://www.studioclyx.com",
];

export const EMBED_HEIGHT_MESSAGE = "clyx-embed-height";
export const EMBED_HEIGHT_REQUEST = "clyx-request-height";

/** True when this document is running inside a frame. */
export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    // Reading window.top across origins throws — which itself proves we're framed.
    return true;
  }
}

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

// Parent -> child: which slice of our (very tall) document is actually on the
// visitor's screen right now. `position: fixed` inside an iframe resolves
// against the IFRAME's viewport, which since the height-sync change is the
// entire multi-thousand-pixel document -- so a centered dialog lands in the
// middle of the whole frame, usually far off-screen, while its overlay greys
// out everything. These coordinates let us pin dialogs to the visible slice.
export const EMBED_VIEWPORT_MESSAGE = "clyx-viewport";

// Set on <html> once the parent starts sending viewport coordinates. Gating the
// CSS on this class means an un-updated parent snippet (no viewport messages)
// simply keeps the old centering rather than breaking.
export const EMBEDDED_CLASS = "clyx-embedded";

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

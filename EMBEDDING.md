# Embedding the booking app in Squarespace

The booking app is embedded in the studioclyx.com marketing site via an iframe.
This file documents **both halves** of that embed, because one half lives in the
Squarespace editor and is therefore not version-controlled. If the booking page
ever shows an inner scrollbar or a tall blank gap again, start here.

## The problem this solves

An iframe does not grow to fit its contents, and a parent page cannot measure a
cross-origin document. So the parent has to be told how tall to be.

The original embed hardcoded `min-height:1300px`. The booking page is several
times taller than that on mobile (four space cards, the scheduler, the full
add-on catalog), so the iframe got its own inner scrollbar — a guest scrolling
the marketing page would have their scroll gesture captured by a small window
inside it. On touch devices that reads as a broken page.

## How it works now

**Height (child → parent):**

1. The app measures its own height (`client/src/hooks/use-embed-height.ts`).
2. It posts that height to the parent: `{ type: "clyx-embed-height", height }`.
3. The parent sets `iframe.style.height` to match.
4. The parent may post `{ type: "clyx-request-height" }` to force a re-report.

**Viewport (parent → child):**

Sizing the frame to its content created a second problem. The iframe no longer
scrolls internally, so `position: fixed` resolves against a viewport thousands
of pixels tall — a dialog centered at `top: 50%` lands in the middle of the
whole document, usually off-screen, while its overlay greys out the entire
frame. Guests saw the page go grey with no visible dialog.

So the parent posts `{ type: "clyx-viewport", top, height }` on scroll and
resize, describing the slice of the iframe currently on screen. The app exposes
those as `--clyx-vp-top` / `--clyx-vp-height` and sets `html.clyx-embedded`;
rules at the bottom of `client/src/index.css` re-anchor dialogs, alert dialogs
and toasts to that slice.

The class is only applied once real viewport messages arrive, so a parent page
still running the older height-only snippet keeps the previous centering rather
than breaking.

Both sides check `event.origin`. The app only posts to the origins listed in
`ALLOWED_PARENT_ORIGINS` (`client/src/lib/embed-height.ts`) — **edit that list if
the marketing domain ever changes**, or heights will stop arriving.

The app-side code is inert when not framed, so the standalone Render URL and the
`/#/admin` console are unaffected.

## Squarespace side — paste into a Code Block

Replace the existing iframe embed with this.

```html
<iframe
  id="clyx-booking"
  src="https://studio-clyx-booking.onrender.com"
  title="Book a Studio Clyx space"
  style="width:100%;height:1600px;border:0;display:block;"
  loading="lazy"
></iframe>

<script>
(function () {
  var APP_ORIGIN = "https://studio-clyx-booking.onrender.com";
  var frame = document.getElementById("clyx-booking");
  if (!frame) return;

  function post(msg) {
    try { frame.contentWindow.postMessage(msg, APP_ORIGIN); } catch (err) {}
  }

  // --- Height: size the iframe to its content ---
  window.addEventListener("message", function (event) {
    if (event.origin !== APP_ORIGIN) return;
    var data = event.data;
    if (!data || data.type !== "clyx-embed-height") return;
    var height = parseInt(data.height, 10);
    // Sanity-bound it so a bad value can't collapse or explode the page.
    if (!height || height < 200 || height > 20000) return;
    frame.style.height = height + "px";
    scheduleViewport(); // the frame's geometry just changed
  });

  // --- Viewport: tell the app which slice of itself is on screen ---
  // Without this, a dialog inside the (very tall) frame centers itself in the
  // middle of the whole document rather than in front of the visitor.
  var lastTop = -1, lastHeight = -1, ticking = false;

  function sendViewport() {
    ticking = false;
    var rect = frame.getBoundingClientRect();
    var top = Math.max(0, -rect.top);
    var bottom = Math.min(rect.height, window.innerHeight - rect.top);
    var height = Math.max(0, bottom - top);
    if (height <= 0) return; // frame entirely off screen
    if (Math.abs(top - lastTop) < 1 && Math.abs(height - lastHeight) < 1) return;
    lastTop = top;
    lastHeight = height;
    post({ type: "clyx-viewport", top: top, height: height });
  }

  function scheduleViewport() {
    if (!ticking) { ticking = true; requestAnimationFrame(sendViewport); }
  }

  // Ask for a height in case the first message was missed (lazy-loaded frame,
  // slow paint) or the parent window resized without our content changing.
  function requestHeight() { post({ type: "clyx-request-height" }); }

  window.addEventListener("scroll", scheduleViewport, { passive: true });
  window.addEventListener("resize", function () { scheduleViewport(); requestHeight(); });
  frame.addEventListener("load", function () { requestHeight(); scheduleViewport(); });
  setTimeout(function () { requestHeight(); scheduleViewport(); }, 1200);
})();
</script>
```

### Notes

- **`height:1600px` is the fallback**, used only until the first message lands
  and if the script never runs. It is deliberately generous — too small shows a
  scrollbar for a moment, too large shows a gap for a moment. Overshooting is
  the less jarring failure.
- **Do not add `scrolling="no"`.** It would hide the inner scrollbar during the
  brief pre-sync window, but if the height sync ever fails the guest could not
  reach the Book Now button at all. The scrollbar is the safety net.
- Code Blocks require a Squarespace **Business** plan or higher.
- If the site later moves to `www.` or a new domain, update
  `ALLOWED_PARENT_ORIGINS` in the app **and** redeploy — the parent-side
  `APP_ORIGIN` only needs changing if the Render URL changes.

## Verifying it works

1. Load the marketing page and scroll through the booking section — the page
   should scroll as one document, with no scrollbar inside the frame.
2. On a phone (or a narrow browser window), confirm the same.
3. Expand an add-on category and confirm the frame grows, then collapse it and
   confirm the frame shrinks back with no blank gap left behind.
4. In devtools, inspect the iframe element — its inline `height` should be a
   specific pixel value in the thousands, not `1600px`.
5. Scroll to the **bottom** of the add-on list and open an item's details popup.
   It must appear centered in front of you, not somewhere far up the page. Then
   do the same from the top of the list. Repeat on a phone.
6. With a dialog open, scroll the page — the dialog should track the screen.

If the height stays at the fallback, check the browser console on the parent
page for a postMessage origin warning; a domain mismatch in
`ALLOWED_PARENT_ORIGINS` is the usual cause.

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

1. The app measures its own height (`client/src/hooks/use-embed-height.ts`).
2. It posts that height to the parent: `{ type: "clyx-embed-height", height }`.
3. The parent sets `iframe.style.height` to match.
4. The parent may post `{ type: "clyx-request-height" }` to force a re-report.

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

  window.addEventListener("message", function (event) {
    if (event.origin !== APP_ORIGIN) return;
    var data = event.data;
    if (!data || data.type !== "clyx-embed-height") return;
    var height = parseInt(data.height, 10);
    // Sanity-bound it so a bad value can't collapse or explode the page.
    if (!height || height < 200 || height > 20000) return;
    frame.style.height = height + "px";
  });

  // Ask for a height in case the first message was missed (lazy-loaded frame,
  // slow paint) or the parent window resized without our content changing.
  function requestHeight() {
    try {
      frame.contentWindow.postMessage({ type: "clyx-request-height" }, APP_ORIGIN);
    } catch (err) {}
  }
  frame.addEventListener("load", requestHeight);
  window.addEventListener("resize", requestHeight);
  setTimeout(requestHeight, 1200);
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

If the height stays at the fallback, check the browser console on the parent
page for a postMessage origin warning; a domain mismatch in
`ALLOWED_PARENT_ORIGINS` is the usual cause.

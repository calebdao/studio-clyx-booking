import { useEffect } from "react";
import {
  ALLOWED_PARENT_ORIGINS,
  EMBED_HEIGHT_MESSAGE,
  EMBED_HEIGHT_REQUEST,
  isEmbedded,
} from "@/lib/embed-height";

/**
 * While embedded in an iframe, continuously report our document height to the
 * parent so it can size the iframe to fit. Completely inert when the app is
 * loaded directly (not framed), so the standalone URL is unaffected.
 *
 * Measurement note: this reads the <html> box rather than scrollHeight because
 * Shell drops its `min-h-dvh` floor when embedded. Inside an iframe `dvh` is the
 * iframe's OWN height, so keeping that floor would make the measurement never
 * fall below whatever we last reported — the iframe would ratchet up to the
 * tallest state the page ever reached and keep the blank space forever.
 */
export function useEmbedHeightReporter() {
  useEffect(() => {
    if (!isEmbedded()) return;

    let lastSent = -1;
    let frame = 0;

    const send = () => {
      frame = 0;
      const height = Math.ceil(
        document.documentElement.getBoundingClientRect().height
      );
      if (!Number.isFinite(height) || height <= 0) return;
      // Ignore sub-pixel jitter; anything smaller isn't worth a message.
      if (Math.abs(height - lastSent) < 2) return;
      lastSent = height;
      for (const origin of ALLOWED_PARENT_ORIGINS) {
        window.parent.postMessage(
          { type: EMBED_HEIGHT_MESSAGE, height },
          origin
        );
      }
    };

    // Coalesce bursts (fonts landing, images decoding, a section expanding)
    // into one message per frame.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(send);
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);

    // The parent can ask us to re-report — covers a dropped message, or the
    // parent window being resized while our own height didn't change.
    const onMessage = (event: MessageEvent) => {
      if (!ALLOWED_PARENT_ORIGINS.includes(event.origin)) return;
      if ((event.data as { type?: string } | null)?.type !== EMBED_HEIGHT_REQUEST)
        return;
      lastSent = -1; // force a resend even if the height is unchanged
      schedule();
    };
    window.addEventListener("message", onMessage);

    // Web fonts shift layout after first paint; re-measure once they settle.
    document.fonts?.ready.then(schedule).catch(() => {});
    window.addEventListener("load", schedule);
    schedule();

    return () => {
      observer.disconnect();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("load", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}

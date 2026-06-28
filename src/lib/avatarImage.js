// ─── AVATAR IMAGE ───────────────────────────────────────────────────────────
// Turn a user-picked image File into a small, square-ish data URL we can keep in
// IndexedDB (see lib/lapStore avatars store) and drop straight into an <img src>.
// We downscale to AVATAR_MAX px on the longest edge and re-encode to WebP (with a
// JPEG fallback) so any uploaded format — a 12 MP phone photo, a PNG logo —
// normalises down to a few KB. Pure browser APIs, no deps.

const AVATAR_MAX = 256;        // longest-edge target, in px
const MAX_SOURCE_BYTES = 25 * 1024 * 1024; // reject absurdly large source files

// Resolve to a compressed data URL, or reject with an Error the caller can show.
export function fileToAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith("image/")) {
      reject(new Error("Please choose an image file."));
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      reject(new Error("That image is too large (max 25 MB)."));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't a valid image."));
      img.onload = () => {
        try {
          const scale = Math.min(1, AVATAR_MAX / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          // WebP where supported (smaller); browsers that don't will hand back a
          // PNG data URL, so fall back to an explicit JPEG for predictable size.
          let out = canvas.toDataURL("image/webp", 0.85);
          if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/jpeg", 0.85);
          resolve(out);
        } catch {
          reject(new Error("Couldn't process that image."));
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

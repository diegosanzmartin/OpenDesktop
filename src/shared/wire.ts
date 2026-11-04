/**
 * JSON for the web build's socket, with bytes kept as bytes.
 *
 * Electron's IPC carries a Uint8Array as itself; JSON would turn it into an
 * object of numbered keys, and an attachment pasted into the composer would
 * arrive as garbage. Bytes travel as base64 under a marker key instead.
 */

const MARK = "__bytes";

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return { [MARK]: base64(item) };
    // A Node Buffer has already been through its own toJSON by the time a replacer sees it.
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "Buffer" && Array.isArray((item as { data?: unknown }).data)) {
      return { [MARK]: base64(Uint8Array.from((item as { data: number[] }).data)) };
    }
    return item;
  });
}

export function decode<T>(text: string): T {
  return JSON.parse(text, (_key, item: unknown) => {
    if (item && typeof item === "object" && typeof (item as Record<string, unknown>)[MARK] === "string") {
      return Uint8Array.from(atob((item as Record<string, string>)[MARK]), (char) => char.charCodeAt(0));
    }
    return item;
  }) as T;
}

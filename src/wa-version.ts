import {
  fetchLatestWaWebVersion,
  type WAVersion,
} from "@whiskeysockets/baileys";

/** Resolve the advertised Web version or fail; the bundled fallback may reject new links. */
export async function resolveWebVersion(
  signal: AbortSignal,
): Promise<WAVersion> {
  try {
    const result = await fetchLatestWaWebVersion({
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: "error",
    });
    const version = result.version;
    if (
      !result.isLatest ||
      result.error ||
      !Array.isArray(version) ||
      version.length !== 3 ||
      version[0] !== 2 ||
      version[1] !== 3000 ||
      !version.every((value) => Number.isSafeInteger(value) && value > 0)
    )
      throw new Error("Unverified Web version");
    return version;
  } catch {
    throw new Error(
      "Could not verify the current WhatsApp Web version. No WhatsApp socket was opened; retry when web.whatsapp.com is reachable.",
    );
  }
}

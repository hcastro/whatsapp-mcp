import { Worker } from "node:worker_threads";
import { LiveError } from "./live.js";

export interface AttachmentView {
  kind: string;
  fileName: string | null;
  text?: string;
  page?: number;
  pages?: number;
  truncated?: boolean;
  sheets?: { name: string; rows: number; columns: number }[];
  sheet?: string;
  startRow?: number;
  nextRow?: number | null;
  image?: { data: string; mimeType: string };
}
/** Parses supported attachments in a worker with a deadline; document macros and PDF scripts are not executed. */
export function readAttachment(
  bytes: Buffer,
  fileName: string | null,
  options: { page: number; sheet?: string; startRow: number },
  signal?: AbortSignal,
): Promise<AttachmentView> {
  if (signal?.aborted) throw new LiveError("Attachment read cancelled.");
  if (bytes.length > 25 * 1024 * 1024)
    throw new LiveError("Attachment exceeds the 25 MiB reading limit.");
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./attachment-worker.js", import.meta.url),
      {
        workerData: { bytes, fileName, ...options },
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
        },
        stdout: true,
        stderr: true,
      },
    );
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const finish = (error?: string, value?: AttachmentView) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate().then(
        () => {
          if (error) reject(new LiveError(error));
          else resolve(value!);
        },
        () => reject(new LiveError("Attachment parser cleanup failed.")),
      );
    };
    const timer = setTimeout(
      () =>
        finish(
          "Attachment parsing exceeded 20 seconds; request a smaller file.",
        ),
      20_000,
    );
    const cancel = () => finish("Attachment read cancelled.");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.on(
      "message",
      (message: { error?: string; value?: AttachmentView }) =>
        finish(message.error, message.value),
    );
    worker.on("error", () =>
      finish("Attachment parser failed or exceeded its memory limit."),
    );
    worker.on("exit", () => {
      if (!settled) finish("Attachment parser stopped without a result.");
    });
  });
}

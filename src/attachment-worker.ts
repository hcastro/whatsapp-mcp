import { parentPort, workerData } from "node:worker_threads";
import { Readable } from "node:stream";
import { inflateRawSync, crc32 } from "node:zlib";
import { imageSize } from "image-size";
import type { AttachmentView } from "./attachments.js";
const { fileName, page, sheet, startRow } = workerData as {
  fileName: string | null;
  page: number;
  sheet?: string;
  startRow: number;
};
const bytes = Buffer.from(workerData.bytes as Uint8Array);
const textLimit = 30_000;

function inspectZip(): Map<string, Buffer> {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557)) {
    if (
      bytes.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + bytes.readUInt16LE(end + 20) === bytes.length
    )
      break;
    end--;
  }
  if (end < Math.max(0, bytes.length - 65557))
    throw new Error("Invalid ZIP end record.");
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const directory = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    count === 65535 ||
    size === 0xffffffff ||
    directory === 0xffffffff ||
    (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50)
  )
    throw new Error("Multi-disk and ZIP64 documents are unsupported.");
  if (count > 10000 || directory + size !== end)
    throw new Error("Invalid ZIP directory bounds.");
  let offset = directory;
  let expanded = 0;
  const entries = new Map<string, Buffer>();
  const regions: { start: number; end: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry.");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const declaredSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      flags & 0x41 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(offset + 34) ||
      [compressedSize, declaredSize, local].includes(0xffffffff)
    )
      throw new Error("Unsupported ZIP entry encoding.");
    for (
      let extra = offset + 46 + nameLength;
      extra < offset + 46 + nameLength + extraLength;

    ) {
      if (
        extra + 4 > offset + 46 + nameLength + extraLength ||
        bytes.readUInt16LE(extra) === 1
      )
        throw new Error("Unsupported ZIP extra field.");
      extra += 4 + bytes.readUInt16LE(extra + 2);
      if (extra > offset + 46 + nameLength + extraLength)
        throw new Error("Invalid ZIP extra field.");
    }
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.split("/").some((part) => part === "." || part === "..") ||
      entries.has(name)
    )
      throw new Error("Duplicate or non-canonical ZIP path.");
    if (
      local + 30 > directory ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      throw new Error("ZIP local header disagrees with directory.");
    const localNameLength = bytes.readUInt16LE(local + 26);
    const start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (
      !bytes
        .subarray(local + 30, local + 30 + localNameLength)
        .equals(rawName) ||
      start + compressedSize > directory
    )
      throw new Error("Invalid ZIP entry boundaries.");
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(local + 14) !== checksum ||
        bytes.readUInt32LE(local + 18) !== compressedSize ||
        bytes.readUInt32LE(local + 22) !== declaredSize)
    )
      throw new Error("ZIP sizes disagree with directory.");
    expanded += declaredSize;
    if (expanded > 64 * 1024 * 1024)
      throw new Error("Expanded document exceeds 64 MiB.");
    const compressed = bytes.subarray(start, start + compressedSize);
    const unpacked =
      method === 8
        ? inflateRawSync(compressed, {
            maxOutputLength: Math.max(1, declaredSize),
          })
        : compressed;
    if (unpacked.length !== declaredSize || crc32(unpacked) !== checksum)
      throw new Error("ZIP content failed size or checksum validation.");
    entries.set(name, unpacked);
    regions.push({ start: local, end: start + compressedSize });
    offset = next;
  }
  if (offset !== end)
    throw new Error("ZIP entry count disagrees with directory size.");
  regions.sort((a, b) => a.start - b.start);
  for (let i = 1; i < regions.length; i++)
    if (regions[i]!.start < regions[i - 1]!.end)
      throw new Error("Overlapping ZIP entries are unsupported.");
  return entries;
}
async function parse(): Promise<AttachmentView> {
  if (bytes.subarray(0, 5).toString() === "%PDF-") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createCanvas } = await import("@napi-rs/canvas");
    const loading = getDocument({
      data: new Uint8Array(bytes),
      maxImageSize: 16_000_000,
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
    });
    let document;
    try {
      document = await loading.promise;
    } catch {
      throw new Error(
        "PDF could not be opened; it may be password-protected or damaged.",
      );
    }
    try {
      if (page > document.numPages)
        throw new Error("PDF page is outside the document.");
      const pdfPage = await document.getPage(page);
      const content = await pdfPage.getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("");
      const natural = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({
        scale: Math.min(2, 1600 / Math.max(natural.width, natural.height)),
      });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await pdfPage.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext("2d") as never,
        viewport,
      }).promise;
      return {
        kind: "pdf",
        fileName,
        page,
        pages: document.numPages,
        text: text.slice(0, textLimit),
        truncated: text.length > textLimit,
        image: {
          mimeType: "image/png",
          data: canvas.toBuffer("image/png").toString("base64"),
        },
      };
    } finally {
      await loading.destroy();
    }
  }
  const isImage =
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    bytes.subarray(0, 3).toString() === "GIF" ||
    (bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP");
  if (isImage) {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const dimensions = imageSize(bytes);
    if (dimensions.width * dimensions.height > 40_000_000)
      throw new Error("Image exceeds the 40-megapixel reading limit.");
    const image = await loadImage(bytes);
    if (image.width * image.height > 40_000_000)
      throw new Error("Image exceeds the 40-megapixel reading limit.");
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = createCanvas(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      kind: "image",
      fileName,
      image: {
        data: canvas.toBuffer("image/png").toString("base64"),
        mimeType: "image/png",
      },
    };
  }
  const names =
    bytes.subarray(0, 2).toString() === "PK" ? inspectZip() : undefined;
  if (names?.has("word/document.xml")) {
    const { SaxesParser } = await import("saxes");
    const xml = names.get("word/document.xml")!.toString("utf8");
    const parser = new SaxesParser();
    let inText = false;
    let value = "";
    parser.on("opentag", (tag) => {
      if (tag.name === "w:t") inText = true;
      if (tag.name === "w:tab") value += "\t";
    });
    parser.on("text", (text) => {
      if (inText) value += text;
    });
    parser.on("closetag", (tag) => {
      if (tag.name === "w:t") inText = false;
      if (tag.name === "w:p") value += "\n";
    });
    parser.write(xml).close();
    const pages = Math.max(1, Math.ceil(value.length / textLimit));
    if (page > pages) throw new Error("Text section is outside the document.");
    return {
      kind: "docx",
      fileName,
      text: value.slice((page - 1) * textLimit, page * textLimit),
      page,
      pages,
      truncated: page < pages,
    };
  }
  const csv = /\.csv$/i.test(fileName ?? "");
  if (names?.has("xl/workbook.xml") || csv) {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    if (csv) await workbook.csv.read(Readable.from(bytes));
    else await workbook.xlsx.load(bytes as never);
    const sheets = workbook.worksheets.map((ws) => ({
      name: ws.name,
      rows: ws.rowCount,
      columns: ws.columnCount,
    }));
    const ws = sheet ? workbook.getWorksheet(sheet) : workbook.worksheets[0];
    if (!ws) throw new Error("Worksheet does not exist.");
    const lines: string[] = [];
    let cellClipped = false;
    let row = startRow;
    let length = 0;
    for (; row <= ws.rowCount && row < startRow + 100; row++) {
      const values: string[] = [];
      for (let col = 1; col <= Math.min(ws.columnCount, 50); col++) {
        const cell = ws.getCell(row, col).text;
        cellClipped ||= cell.length > 2000;
        values.push(cell.slice(0, 2000));
      }
      let line = JSON.stringify({ row, cells: values });
      if (!lines.length && line.length > textLimit) {
        while (line.length > textLimit && values.length) {
          values.pop();
          line = JSON.stringify({ row, cells: values });
        }
        cellClipped = true;
      }
      if (length + line.length > textLimit && lines.length) break;
      lines.push(line);
      length += line.length;
    }
    return {
      kind: "spreadsheet",
      fileName,
      sheets,
      sheet: ws.name,
      startRow,
      nextRow: row <= ws.rowCount ? row : null,
      text: lines.join("\n"),
      truncated:
        cellClipped ||
        row <= ws.rowCount ||
        ws.columnCount > 50 ||
        length > textLimit,
    };
  }
  if (/\.(txt|md|json|tsv|log)$/i.test(fileName ?? "")) {
    const text = bytes.toString("utf8");
    const pages = Math.max(1, Math.ceil(text.length / textLimit));
    if (page > pages) throw new Error("Text section is outside the file.");
    return {
      kind: "text",
      fileName,
      page,
      pages,
      text: text.slice((page - 1) * textLimit, page * textLimit),
      truncated: page < pages,
    };
  }
  throw new Error(
    "Unsupported attachment format. Supported: PDF, PNG/JPEG/GIF/WebP, XLSX/CSV, DOCX, and plain text. Legacy XLS/DOC and audio/video transcription are not supported.",
  );
}
void parse()
  .then((value) => parentPort!.postMessage({ value }))
  .catch((error: unknown) =>
    parentPort!.postMessage({
      error:
        error instanceof Error && !/\n/.test(error.message)
          ? error.message.slice(0, 250)
          : "Attachment could not be read.",
    }),
  );

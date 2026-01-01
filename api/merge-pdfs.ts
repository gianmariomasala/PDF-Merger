import type { VercelRequest, VercelResponse } from "@vercel/node";
import Busboy from "busboy";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";

export const config = {
  api: {
    bodyParser: false
  }
};

type UploadedFile = {
  filename: string;
  buffer: Buffer;
};

function safeName(s: string) {
  return s
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const files: UploadedFile[] = [];

    const busboy = Busboy({ headers: req.headers });

    busboy.on("file", (_, file, info) => {
      const chunks: Buffer[] = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        files.push({
          filename: info.filename,
          buffer: Buffer.concat(chunks)
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      busboy.on("finish", () => resolve());
      busboy.on("error", reject);
      req.pipe(busboy);
    });

    if (files.length < 2) {
      res.status(400).send("Servono almeno due PDF");
      return;
    }

    // raggruppa per ID (25-02049 ecc)
    const groups: Record<string, UploadedFile[]> = {};
    for (const f of files) {
      const m = f.filename.match(/(\d{2}-\d{4,})/);
      if (!m) continue;
      groups[m[1]] ??= [];
      groups[m[1]].push(f);
    }

    const zip = new JSZip();
    let merged = 0;

    for (const [groupId, groupFiles] of Object.entries(groups)) {
      if (groupFiles.length < 2) continue;

      // fattura prima, allegati dopo
      groupFiles.sort((a, b) => {
        const A = a.filename.toLowerCase();
        const B = b.filename.toLowerCase();
        if (A.includes("allegato") && !B.includes("allegato")) return 1;
        if (!A.includes("allegato") && B.includes("allegato")) return -1;
        return A.localeCompare(B);
      });

      // estrai testo dalla fattura
      const parsed = await pdfParse(groupFiles[0].buffer);
      const text = parsed.text || "";

      const fattura =
        text.match(/Fattura\s*N[°º]?:\s*([0-9]{2}\/[0-9]{5})/i)?.[1] ??
        groupId.replace("-", "/");

      const intestatario =
        text.match(/Intestatario:\s*([^\n\r]+)/i)?.[1] ??
        text.match(/\bDr\s+[A-Za-zÀ-ÿ.'’\-]+\s+[A-Za-zÀ-ÿ.'’\-]+/)?.[0] ??
        "Documento";

      const mergedPdf = await PDFDocument.create();

      for (const f of groupFiles) {
        const pdf = await PDFDocument.load(f.buffer);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((p) => mergedPdf.addPage(p));
      }

      const bytes = await mergedPdf.save();

      const filename = `${groupId} - ${safeName(
        fattura.replace("/", "-")
      )} - ${safeName(intestatario)}.pdf`;

      zip.file(filename, bytes);
      merged++;
    }

    if (!merged) {
      res.status(400).send("Nessuna coppia valida trovata");
      return;
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="pdf_uniti.zip"');
    res.status(200).send(zipBuffer);
  } catch (err: any) {
    console.error(err);
    res.status(500).send("Errore durante il merge PDF");
  }
}
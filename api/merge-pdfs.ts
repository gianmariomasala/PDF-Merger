import type { VercelRequest, VercelResponse } from "@vercel/node";
import Busboy from "busboy";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";

type UploadedFile = {
  filename: string;
  buffer: Buffer;
};

function safeName(s: string) {
  return (s || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractGroupId(filename: string) {
  const m = filename.match(/(\d{2}-\d{4,})/);
  return m ? m[1] : undefined;
}

/**
 * Estrae un intestatario robusto:
 * 1) "Intestatario: ..."
 * 2) "Spett.le" + riga successiva (tipico per aziende)
 * 3) fallback: match "Dr Nome Cognome"
 * 4) fallback: "Documento"
 */
function extractIntestatario(text: string) {
  const t = text || "";

  // 1) Intestatario: ...
  const intest = t.match(/Intestatario:\s*([^\n\r]+)/i)?.[1];
  if (intest) return intest;

  // 2) Spett.le \n <ragione sociale>
  const spett1 = t.match(/Spett\.?le\s*[\r\n]+\s*([^\r\n]+)/i)?.[1];
  if (spett1) return spett1;

  // 2b) Spett.le <ragione sociale>
  const spett2 = t.match(/Spett\.?le\s+([^\r\n]+)/i)?.[1];
  if (spett2) return spett2;

  // 3) Dr Nome Cognome
  const dr = t.match(/\bDr\s+[A-Za-zÀ-ÿ.'’\-]+\s+[A-Za-zÀ-ÿ.'’\-]+/i)?.[0];
  if (dr) return dr;

  return "Documento";
}

/**
 * Estrae numero fattura/proforma in più formati (5 o 6 cifre dopo lo slash)
 * es: 25/02049, 26/020477
 */
function extractFatturaNumber(text: string, fallbackGroupId: string) {
  const t = text || "";

  // "Fattura N°: 25/02050" oppure "Fattura Proforma 26/020477"
  const m =
    t.match(/Fattura\s*(?:Proforma)?\s*(?:N[°º]?\s*:?)?\s*(\d{2}\/\d{5,6})/i)?.[1] ||
    t.match(/Fattura\s+Proforma\s+(\d{2}\/\d{5,6})/i)?.[1];

  if (m) return m;

  // fallback: da "25-02049" -> "25/02049"
  return fallbackGroupId.replace("-", "/");
}

/**
 * Legge l'intero body in Buffer (molto più stabile con vercel dev / proxy)
 */
async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Parse multipart via Busboy, ma alimentato da Buffer (bb.end(buffer)),
 * così evitiamo "Unexpected end of form" da pipe/stream in dev.
 */
async function parseMultipart(req: VercelRequest): Promise<UploadedFile[]> {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    throw new Error("Content-Type non valido: serve multipart/form-data");
  }

  const raw = await readRawBody(req);

  return await new Promise<UploadedFile[]>((resolve, reject) => {
    const files: UploadedFile[] = [];

    const bb = Busboy({
      headers: req.headers,
      limits: {
        files: 50,
        fileSize: 25 * 1024 * 1024 // 25MB per file (alza se vuoi)
      }
    });

    bb.on("file", (_fieldname, file, info) => {
      const chunks: Buffer[] = [];

      file.on("data", (d: Buffer) => chunks.push(d));

      file.on("limit", () => {
        // Se vuoi: reject qui. Io preferisco errore esplicito.
        reject(new Error(`File troppo grande: ${info.filename}`));
      });

      file.on("end", () => {
        files.push({
          filename: info.filename || "file.pdf",
          buffer: Buffer.concat(chunks)
        });
      });

      file.on("error", reject);
    });

    bb.on("error", reject);
    bb.on("finish", () => resolve(files));

    // 🔥 punto chiave: niente req.pipe(bb)
    bb.end(raw);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const files = await parseMultipart(req);

    if (files.length < 2) {
      res.status(400).send("Servono almeno due PDF");
      return;
    }

    // raggruppa per ID (25-02049 ecc)
    const groups: Record<string, UploadedFile[]> = {};
    for (const f of files) {
      const groupId = extractGroupId(f.filename);
      if (!groupId) continue;
      groups[groupId] ??= [];
      groups[groupId].push(f);
    }

    const zip = new JSZip();
    let merged = 0;

    for (const [groupId, groupFiles] of Object.entries(groups)) {
      if (groupFiles.length < 2) continue;

      // fattura prima, allegati dopo
      groupFiles.sort((a, b) => {
        const A = a.filename.toLowerCase();
        const B = b.filename.toLowerCase();

        const aIsAllegato = A.includes("allegato");
        const bIsAllegato = B.includes("allegato");

        if (aIsAllegato && !bIsAllegato) return 1;
        if (!aIsAllegato && bIsAllegato) return -1;
        return A.localeCompare(B);
      });

      // estrai testo dalla "fattura" (primo file dopo sort)
      const parsed = await pdfParse(groupFiles[0].buffer);
      const text = parsed.text || "";

      const fattura = extractFatturaNumber(text, groupId);
      const intestatario = extractIntestatario(text);

      // merge pagine
      const mergedPdf = await PDFDocument.create();

      for (const f of groupFiles) {
        const pdf = await PDFDocument.load(f.buffer);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((p) => mergedPdf.addPage(p));
      }

      const bytes = await mergedPdf.save();

      const outName = `${groupId} - ${safeName(fattura.replace("/", "-"))} - ${safeName(
        intestatario
      )}.pdf`;

      zip.file(outName, bytes);
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
    // in dev è utilissimo vedere il motivo vero
    res.status(500).send(err?.message || "Errore durante il merge PDF");
  }
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Busboy from "busboy";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";

export const config = {
  api: { bodyParser: false },
};

type UploadedFile = {
  filename: string;
  buffer: Buffer;
};

function safeName(s: string) {
  return s
    .replace(/[\\/:*?"<>|]/g, "") // windows forbidden
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120); // evita nomi folli
}

function normalizeIntestatario(raw: string) {
  let s = (raw || "").trim();

  // taglia roba inutile dopo una virgola lunga (a volte indirizzi o CF)
  // (non sempre presente, ma aiuta)
  s = s.replace(/\s{2,}/g, " ");

  // rimuove prefissi/titoli comuni
  s = s.replace(
    /^(spett\.?le|spettabile|dott\.?ssa|dott\.?|dr\.?|sig\.?ra|sig\.?|sigg\.?|gent\.?le|ill\.?mo|impresa)\s+/i,
    ""
  );

  // se resta vuoto, torna al raw
  if (!s.trim()) s = raw?.trim() || "Documento";

  return safeName(s);
}

function extractIntestatarioFromText(text: string) {
  const t = text || "";

  // Varianti realistiche (linea o riga dopo)
  const patterns: RegExp[] = [
    /Intestatario\s*:\s*([^\n\r]+)/i,
    /Intestatario\s*\n\s*([^\n\r]+)/i,
    /Ragione\s+Sociale\s*:\s*([^\n\r]+)/i,
    /Ragione\s+Sociale\s*\n\s*([^\n\r]+)/i,
    /Cliente\s*:\s*([^\n\r]+)/i,
    /Cliente\s*\n\s*([^\n\r]+)/i,
    /Destinatario\s*:\s*([^\n\r]+)/i,
    /Destinatario\s*\n\s*([^\n\r]+)/i,
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (m?.[1]) return m[1].trim();
  }

  // fallback: una riga con Dr Nome Cognome
  const dr = t.match(/\bDr\.?\s+[A-Za-zÀ-ÿ.'’\-]+\s+[A-Za-zÀ-ÿ.'’\-]+/);
  if (dr?.[0]) return dr[0].trim();

  return "Documento";
}

async function readMultipart(req: VercelRequest): Promise<UploadedFile[]> {
  return new Promise((resolve, reject) => {
    const files: UploadedFile[] = [];

    const contentType = req.headers["content-type"] || "";
    if (!String(contentType).includes("multipart/form-data")) {
      reject(new Error("Richiesta non multipart/form-data"));
      return;
    }

    const bb = Busboy({
      headers: req.headers,
      limits: {
        files: 200,
        fileSize: 25 * 1024 * 1024, // 25MB per file (alza se serve)
      },
    });

    let aborted = false;

    req.on("aborted", () => {
      aborted = true;
      reject(new Error("Upload interrotto (aborted)"));
    });

    req.on("error", (e) => reject(e));
    bb.on("error", (e) => reject(e));

    bb.on("file", (_fieldname, file, info) => {
      const chunks: Buffer[] = [];

      file.on("data", (d: Buffer) => chunks.push(d));
      file.on("limit", () => {
        reject(new Error(`File troppo grande: ${info.filename}`));
      });
      file.on("error", (e) => reject(e));

      file.on("end", () => {
        if (aborted) return;
        files.push({
          filename: info.filename || "file.pdf",
          buffer: Buffer.concat(chunks),
        });
      });
    });

    bb.on("finish", () => {
      if (aborted) return;
      resolve(files);
    });

    req.pipe(bb);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const files = await readMultipart(req);

    if (!files || files.length < 2) {
      res.status(400).send("Servono almeno due PDF");
      return;
    }

    // raggruppa per ID (25-02049 ecc)
    const groups: Record<string, UploadedFile[]> = {};
    for (const f of files) {
      const m = f.filename.match(/(\d{2}-\d{4,})/);
      if (!m) continue;
      const id = m[1];
      groups[id] ??= [];
      groups[id].push(f);
    }

    const zip = new JSZip();
    let merged = 0;

    // per evitare overwrite in zip quando stesso intestatario ricorre
    const nameCounts: Record<string, number> = {};

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

      // testo dalla fattura (primo file dopo sort)
      const parsed = await pdfParse(groupFiles[0].buffer);
      const text = parsed.text || "";

      const rawIntestatario = extractIntestatarioFromText(text);
      const intestatario = normalizeIntestatario(rawIntestatario);

      // merge pdf
      const mergedPdf = await PDFDocument.create();
      for (const f of groupFiles) {
        const pdf = await PDFDocument.load(f.buffer);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((p) => mergedPdf.addPage(p));
      }
      const bytes = await mergedPdf.save();

      // filename SOLO intestatario (con suffisso anti-duplicati)
      const base = intestatario || "Documento";
      nameCounts[base] = (nameCounts[base] || 0) + 1;
      const suffix = nameCounts[base] > 1 ? ` (${nameCounts[base]})` : "";

      const filename = `${base}${suffix}.pdf`;

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
    console.error("merge-pdfs error:", err);
    res.status(500).send(err?.message || "Errore durante il merge PDF");
  }
}

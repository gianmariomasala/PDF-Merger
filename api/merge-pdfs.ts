import type { VercelRequest, VercelResponse } from "@vercel/node";
import Busboy from "busboy";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";

export const config = {
  api: { bodyParser: false },
};

type UploadedFile = { filename: string; buffer: Buffer };

function safeName(s: string) {
  return (s || "")
    .replace(/[\\/:*?"<>|]/g, "") // no caratteri proibiti (Windows/mac)
    .replace(/\s+/g, " ")
    .trim();
}

function extractGroupIdFromFilename(name: string) {
  const m = name.match(/(\d{2}-\d{4,})/);
  return m ? m[1] : undefined;
}

function stripHonorificPrefix(name: string) {
  // rimuove SOLO prefissi comuni se stanno all’inizio e seguiti da spazio
  // (non tocca nomi tipo "DRADIA" o simili, perché richiede "Dr " con spazio)
  return name.replace(
    /^(dr|dott\.?|dottore|sig\.?|signor|sig\.ra|signora|spett\.?le)\s+/i,
    ""
  );
}

function extractIntestatario(textRaw: string): string {
  const text = textRaw || "";

  // 1) Intestatario: ...
  const mInt = text.match(/Intestatario:\s*([^\n\r]+)/i);
  if (mInt?.[1]) {
    const v = safeName(mInt[1]);
    const cleaned = safeName(stripHonorificPrefix(v));
    return cleaned || v || "Documento";
  }

  // 2) Spett.le + riga successiva (spesso è la ragione sociale / clinica)
  // Esempio tipico:
  // "Spett.le"
  // "Clinica Veterinaria Radia S.r.l."
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const idxSpett = lines.findIndex((l) => /^spett\.?le$/i.test(l) || /^spett\.?le\b/i.test(l));
  if (idxSpett >= 0) {
    // prova a prendere la riga dopo, poi dopo ancora se è troppo corta
    const candidate1 = lines[idxSpett + 1] || "";
    const candidate2 = lines[idxSpett + 2] || "";
    const cand = (candidate1.length >= 3 ? candidate1 : candidate2) || "";
    const v = safeName(cand);
    const cleaned = safeName(stripHonorificPrefix(v));
    if (cleaned) return cleaned;
  }

  // 3) Cerca una “ragione sociale” (SRL, SNC, SAS, SPA, ecc.) nel testo
  const mSoc = text.match(
    /\b([A-ZÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 '&.,\-]{2,80}\s+(s\.?r\.?l\.?|s\.?n\.?c\.?|s\.?a\.?s\.?|s\.?p\.?a\.?|soc\.\s*coop\.)\b)/i
  );
  if (mSoc?.[1]) {
    return safeName(mSoc[1]);
  }

  // 4) Ultimo fallback: se troviamo una riga “Dr Nome Cognome” la usiamo,
  // ma poi togliamo "Dr " dal filename.
  const mDr = text.match(/\bDr\s+([A-Za-zÀ-ÿ.'’\-]+\s+[A-Za-zÀ-ÿ.'’\-]+)/);
  if (mDr?.[1]) {
    return safeName(mDr[1]);
  }

  return "Documento";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const files: UploadedFile[] = [];

    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 200,
        fileSize: 25 * 1024 * 1024, // 25MB per file (alza se serve)
      },
    });

    busboy.on("file", (_fieldname, file, info) => {
      const chunks: Buffer[] = [];
      file.on("data", (d) => chunks.push(d));
      file.on("limit", () => {
        // se supera fileSize, Busboy tronca; gestiamo comunque nel finish
      });
      file.on("end", () => {
        files.push({
          filename: info.filename,
          buffer: Buffer.concat(chunks),
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
      const id = extractGroupIdFromFilename(f.filename);
      if (!id) continue;
      groups[id] ??= [];
      groups[id].push(f);
    }

    const zip = new JSZip();
    let merged = 0;
    const usedNames = new Set<string>();

    for (const [groupId, groupFiles] of Object.entries(groups)) {
      if (groupFiles.length < 2) continue;

      // fattura prima, allegati dopo
      groupFiles.sort((a, b) => {
        const A = a.filename.toLowerCase();
        const B = b.filename.toLowerCase();
        const aIsAll = A.includes("allegato");
        const bIsAll = B.includes("allegato");
        if (aIsAll && !bIsAll) return 1;
        if (!aIsAll && bIsAll) return -1;
        return A.localeCompare(B);
      });

      // estrai testo dalla fattura (primo file del gruppo)
      const parsed = await pdfParse(groupFiles[0].buffer);
      const text = parsed.text || "";

      const intestatario = extractIntestatario(text);

      // MERGE
      const mergedPdf = await PDFDocument.create();
      for (const f of groupFiles) {
        const pdf = await PDFDocument.load(f.buffer);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((p) => mergedPdf.addPage(p));
      }
      const bytes = await mergedPdf.save();

      // ✅ filename SOLO intestatario (no numeri)
      let base = safeName(intestatario) || "Documento";
      let filename = `${base}.pdf`;

      // se duplica dentro lo zip, aggiungi groupId per disambiguare
      if (usedNames.has(filename)) {
        filename = `${base} (${groupId}).pdf`;
      }
      usedNames.add(filename);

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

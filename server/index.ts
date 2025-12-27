import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { PDFDocument } from "pdf-lib";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(
  cors({
    origin: true, // ok in dev; se vuoi poi lo blindiamo su dominio Vercel
    credentials: false,
  })
);
app.use(express.json());

const upload = multer({ dest: "uploads/" });

/** --- Utils --- */

function safePdfFileName(name: string) {
  // niente caratteri illegali Windows/macOS + evita nomi vuoti
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length ? cleaned : "Documento";
}

function extractGroupIdFromFilename(fileName: string): string | null {
  // es: 25-02050 oppure 25-02049 (adatta se cambia formato)
  const m = fileName.match(/(\d{2}-\d{4,})/);
  return m ? m[1] : null;
}

function isAllegato(fileName: string): boolean {
  return /allegato/i.test(fileName);
}

function normalizeTextForSearch(t: string): string {
  // rende più prevedibili gli “a capo” e gli spazi di pdf-parse
  return t
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanupCandidateName(raw: string): string | null {
  let s = raw
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // taglia se dentro ci finisce roba “oltre” al nome
  const stopWords = [
    "fattura",
    "data",
    "del",
    "competenza",
    "codice",
    "p.iva",
    "partita",
    "email",
    "telefono",
    "indirizzo",
    "via",
    "pagina",
  ];
  for (const w of stopWords) {
    const idx = s.toLowerCase().indexOf(` ${w}`);
    if (idx > 0) s = s.slice(0, idx).trim();
  }

  // troppo corto? via.
  if (s.length < 4) return null;

  // evita roba tipo “25/02050” o solo numeri
  if (/^[\d\s/.-]+$/.test(s)) return null;

  return s;
}

/** --- Extraction (core) --- */
async function extractIntestatario(pdfBuffer: Buffer, fileName: string): Promise<string | null> {
  try {
    console.log(`\n--- Intestatario extraction for: ${fileName} ---`);

    const parseFunc =
      typeof pdfParse === "function" ? pdfParse : pdfParse?.default || pdfParse;

    if (typeof parseFunc !== "function") {
      console.error("pdf-parse non è una funzione (import rotto).");
      return null;
    }

    const pdfData = await parseFunc(pdfBuffer);
    const rawText = pdfData?.text || "";

    if (!rawText || rawText.trim().length === 0) {
      console.log(`Extraction: [${fileName}] Nessun testo estratto (PDF scannerizzato?).`);
      return null;
    }

    const text = normalizeTextForSearch(rawText);

    // 1) Pattern “Intestatario: <nome>” (il tuo caso tipico)
    // cattura fino a fine riga (o doppio a capo)
    const m1 = text.match(/Intestatario\s*:\s*([^\n]+)\n?/i);
    if (m1?.[1]) {
      const cand = cleanupCandidateName(m1[1]);
      if (cand) {
        console.log(`Extraction: [${fileName}] Match Intestatario: "${cand}"`);
        return cand;
      }
    }

    // 2) A volte “Intestatario” è su una riga, nome su quella dopo
    const m2 = text.match(/Intestatario\s*:\s*\n\s*([^\n]+)\n?/i);
    if (m2?.[1]) {
      const cand = cleanupCandidateName(m2[1]);
      if (cand) {
        console.log(`Extraction: [${fileName}] Match Intestatario (next line): "${cand}"`);
        return cand;
      }
    }

    // 3) Titoli “Dr / Dott / Sig …” in zona alta del documento
    // (prende la prima occorrenza “ragionevole” nelle prime ~2 pagine testuali)
    const topChunk = text.slice(0, 2500);
    const m3 = topChunk.match(
      /\b(Dr\.?|Dott\.?ssa|Dott\.?|Sig\.?ra|Sig\.?r|Spett\.le|Gent\.mo|Egr\.?)\s+([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,4})/i
    );
    if (m3) {
      const cand = cleanupCandidateName(`${m3[1]} ${m3[2]}`);
      if (cand) {
        console.log(`Extraction: [${fileName}] Match title/name: "${cand}"`);
        return cand;
      }
    }

    console.log(`Extraction: [${fileName}] Nessun intestatario trovato.`);
    return null;
  } catch (err) {
    console.error(`Extraction fatal error [${fileName}]:`, err);
    return null;
  }
}

/** --- API --- */
app.post("/api/merge-pdfs", upload.array("pdfs"), async (req, res) => {
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    return res.status(400).send("Nessun file caricato.");
  }

  console.log(`\n=== New Merge Request: ${files.length} files ===`);

  try {
    // Raggruppa per ID
    const groups: Record<
      string,
      { main?: Express.Multer.File; allegato?: Express.Multer.File }
    > = {};

    for (const f of files) {
      const id = extractGroupIdFromFilename(f.originalname);
      if (!id) continue;

      if (!groups[id]) groups[id] = {};
      if (isAllegato(f.originalname)) groups[id].allegato = f;
      else groups[id].main = f;
    }

    const zip = new AdmZip();
    let processedCount = 0;

    for (const id of Object.keys(groups)) {
      const { main, allegato } = groups[id];
      if (!main || !allegato) continue;

      console.log(`\n--- Working on ID: ${id} ---`);

      const mainBuffer = fs.readFileSync(main.path);
      const allegatoBuffer = fs.readFileSync(allegato.path);

      // 1) prova da allegato (come vuoi tu)
      let intestatario = await extractIntestatario(allegatoBuffer, allegato.originalname);

      // 2) fallback sul main
      if (!intestatario) {
        console.log("Allegato: niente. Provo MAIN...");
        intestatario = await extractIntestatario(mainBuffer, main.originalname);
      }

      // Nome finale file
      let finalBase = intestatario ? safePdfFileName(intestatario) : id;
      let finalFileName = `${finalBase}.pdf`;

      // evita collisioni nel .zip (se due intestatari uguali)
      let suffix = 2;
      while (zip.getEntry(finalFileName)) {
        finalFileName = `${finalBase}_${suffix}.pdf`;
        suffix++;
      }

      console.log(`Result for ${id}: ${finalFileName}`);

      // Merge: main poi allegato
      const mainDoc = await PDFDocument.load(mainBuffer);
      const allegatoDoc = await PDFDocument.load(allegatoBuffer);
      const mergedDoc = await PDFDocument.create();

      const mainPages = await mergedDoc.copyPages(mainDoc, mainDoc.getPageIndices());
      mainPages.forEach((p) => mergedDoc.addPage(p));

      const allegatoPages = await mergedDoc.copyPages(allegatoDoc, allegatoDoc.getPageIndices());
      allegatoPages.forEach((p) => mergedDoc.addPage(p));

      const mergedBytes = await mergedDoc.save();
      zip.addFile(finalFileName, Buffer.from(mergedBytes));
      processedCount++;
    }

    if (processedCount === 0) {
      return res.status(400).send("Nessuna coppia valida trovata (manca main o allegato).");
    }

    // Cleanup upload temporanei
    for (const f of files) {
      if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
    }

    const zipBuffer = zip.toBuffer();
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", "attachment; filename=pdf_merger_risultati.zip");
    res.send(zipBuffer);

    console.log(`\n=== Done: ${processedCount} coppie unite ===`);
  } catch (err) {
    console.error("Merge Process Error:", err);

    // Cleanup anche in errore
    for (const f of files || []) {
      if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
    }

    res.status(500).send("Errore interno durante l'unione dei file.");
  }
});

app.listen(port, () => {
  console.log(`PDF Merger Server listening at http://localhost:${port}`);
});
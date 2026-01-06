import type { IncomingMessage, ServerResponse } from "http";
import Busboy from "busboy";
import JSZip from "jszip";
import pdfParse from "pdf-parse";
import { PDFDocument } from "pdf-lib";

/* =========================
   Types & response helpers
========================= */

type VercelReq = IncomingMessage & { method?: string; url?: string };

type VercelRes = ServerResponse & {
  status: (code: number) => VercelRes;
  json: (obj: any) => void;
  send: (body: any) => void;
};

type UploadedFile = {
  fieldname: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
};

function withStatus(res: ServerResponse): VercelRes {
  const r = res as VercelRes;

  r.status = (code: number) => {
    r.statusCode = code;
    return r;
  };

  r.json = (obj: any) => {
    r.setHeader("content-type", "application/json; charset=utf-8");
    r.end(JSON.stringify(obj));
  };

  r.send = (body: any) => {
    if (Buffer.isBuffer(body) || typeof body === "string") {
      r.end(body);
    } else {
      r.setHeader("content-type", "application/json; charset=utf-8");
      r.end(JSON.stringify(body));
    }
  };

  return r;
}

/* =========================
   Filename utils
========================= */

function extractGroupIdFromFilename(name: string) {
  const m = name.match(/(\d{2}-\d{4,})/);
  return m ? m[1] : undefined;
}

function sanitizeFilenamePart(s: string) {
  return s
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpaces(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function isGenericClinicLabel(s: string) {
  const v = normalizeSpaces(s).toLowerCase();
  return v === "clinica veterinaria" || v === "ambulatorio veterinario";
}

/* =========================
   Intestatario extraction (ROBUST)
========================= */

/**
 * Regola definitiva:
 * 1) Fonte di verità: campo "Intestatario:" (robusto anche se spezzato su più righe).
 *    - Se intestatario = "Clinica Veterinaria" o "Ambulatorio Veterinario" DA SOLO => NON valido (serve nome distintivo)
 * 2) Fallback: blocco "Spett.le" => prima riga sensata successiva (saltando Data, Fattura, numeri, ecc.)
 */
function pickIntestatarioFromText(text: string): string | null {
  const clean = text.replace(/\r/g, "");

  // 1) "Intestatario:" — prende tutto finché non arriva un campo successivo tipico
  const idx = clean.toLowerCase().indexOf("intestatario:");
  if (idx >= 0) {
    let tail = clean.slice(idx + "intestatario:".length);
    tail = tail.replace(/\n+/g, "\n").trim();

    // stop su campi successivi comuni (include varianti che compaiono nei tuoi PDF)
    const stop = tail.search(
      /\n(?:allegato\b|allegato\s+fattura\b|del\b|del:|competenza\b|competenza:|data\b|data:|fattura\b|fattura\s*n[°º]?:|codice\b|codice\s+cliente\b|partita\s+iva\b|p\.?\s*iva\b|pagina\b|stampato\b)/i
    );

    const raw = normalizeSpaces((stop >= 0 ? tail.slice(0, stop) : tail).replace(/\n/g, " "));

    if (raw && !isGenericClinicLabel(raw)) {
      return raw; // ✅ Dr, Panda s.r.l., Clinica Veterinaria Panda, A.V. Cave Canem, ecc.
    }
    // se è generico -> fallback sotto
  }

  // 2) fallback: "Spett.le" -> prima riga sensata dopo
  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const spett = lines.findIndex((l) => /^spett\.?le\.?/i.test(l));
  if (spett >= 0) {
    for (let i = spett + 1; i < Math.min(spett + 10, lines.length); i++) {
      const c = lines[i];
      if (!c) continue;

      // scarta etichette/rumore tipico
      if (/^data\b/i.test(c)) continue;
      if (/^del\b/i.test(c)) continue;
      if (/^fattura\b/i.test(c)) continue;
      if (/^fattura\s*n[°º]?\b/i.test(c)) continue;

      // scarta numeri fattura / formati tipici
      if (/^\d{2}\/\d{5}\b/.test(c)) continue; // 25/01963
      if (/^\d{2}-\d{4,}\b/.test(c)) continue; // 25-01963
      if (/^\d{2}\/\d{2}\/\d{4}\b/.test(c)) continue; // 02/12/2025

      if (c.length < 3) continue;

      return c;
    }
  }

  return null;
}

/* =========================
   Multipart reader (Vercel-safe)
========================= */

async function readMultipart(req: VercelReq): Promise<UploadedFile[]> {
  return new Promise((resolve, reject) => {
    const files: UploadedFile[] = [];
    let finished = false;

    const done = (err?: Error) => {
      if (finished) return;
      finished = true;
      err ? reject(err) : resolve(files);
    };

    const bb = Busboy({
      headers: req.headers,
      limits: {
        files: 50,
        fileSize: 25 * 1024 * 1024, // 25 MB per file
      },
    });

    bb.on("file", (fieldname, file, info) => {
      const chunks: Buffer[] = [];

      file.on("data", (d) => chunks.push(Buffer.from(d)));
      file.on("limit", () => done(new Error(`File troppo grande: ${info.filename}`)));
      file.on("error", (e) => done(e as Error));
      file.on("end", () => {
        files.push({
          fieldname,
          filename: info.filename || "file.pdf",
          mimeType: info.mimeType || "application/pdf",
          buffer: Buffer.concat(chunks),
        });
      });
    });

    bb.on("error", (e) => done(e as Error));
    bb.on("finish", () => done());

    req.on("aborted", () => done(new Error("Upload interrotto dal client")));

    req.pipe(bb);
  });
}

/* =========================
   PDF merge
========================= */

async function mergePdfsInOrder(buffers: Buffer[]) {
  const out = await PDFDocument.create();

  for (const buf of buffers) {
    const doc = await PDFDocument.load(buf);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }

  return Buffer.from(await out.save());
}

/* =========================
   Handler
========================= */

export default async function handler(req: VercelReq, resRaw: ServerResponse) {
  const res = withStatus(resRaw);

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, endpoint: "/api/merge-pdfs" });
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const uploaded = await readMultipart(req);

    const pdfs = uploaded.filter(
      (f) => /pdf/i.test(f.mimeType || "") || /\.pdf$/i.test(f.filename || "")
    );

    if (pdfs.length < 2) {
      return res.status(400).send("Carica almeno 2 PDF.");
    }

    // gruppi per ID (25-02049, 26-02079, ecc.)
    const groups = new Map<string, UploadedFile[]>();
    for (const f of pdfs) {
      const gid = extractGroupIdFromFilename(f.filename) || "altro";
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid)!.push(f);
    }

    const zip = new JSZip();

    for (const [groupId, groupFiles] of groups) {
      if (groupId === "altro") continue;
      if (groupFiles.length < 2) continue;

      // ✅ Regola: allegato viene sempre dopo → ordiniamo per filename per stabilità
      const ordered = [...groupFiles].sort((a, b) =>
        (a.filename || "").localeCompare(b.filename || "", "it")
      );

      const main = ordered[0];
      const allegati = ordered.slice(1);

      // estrazione intestatario: MAIN -> se manca, ALLEGATI
      let intestatario = "Documento";

      try {
        const parsedMain = await pdfParse(main.buffer);
        let picked = pickIntestatarioFromText(parsedMain.text || "");

        if (!picked) {
          for (const a of allegati) {
            // guardrail (opzionale, ma sicuro)
            if (!/pdf/i.test(a.mimeType || "") && !/\.pdf$/i.test(a.filename || "")) continue;

            const parsedAllegato = await pdfParse(a.buffer);
            picked = pickIntestatarioFromText(parsedAllegato.text || "");
            if (picked) break;
          }
        }

        if (picked) intestatario = picked;
      } catch {
        // continuiamo comunque
      }

      const merged = await mergePdfsInOrder([main.buffer, ...allegati.map((a) => a.buffer)]);

      const safeName = sanitizeFilenamePart(intestatario);
      zip.file(`${safeName}_${groupId}.pdf`, merged);
    }

    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="pdf_uniti.zip"`);

    res.status(200);
    resRaw.end(zipBuf);
  } catch (err: any) {
    return res.status(500).send(err?.message || "Errore durante il merge PDF");
  }
}

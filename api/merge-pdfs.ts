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

function looksLikeAddressLine(s: string) {
  const v = s.toLowerCase();
  if (/^\d{5}\b/.test(s)) return true; // CAP
  if (/\b(via|viale|piazza|p\.za|strada|cascina|corso|largo)\b/i.test(v)) return true;
  if (/\b(\d{1,4})([\/-]\w+)?\b/.test(s) && /\b(via|viale|strada|corso|piazza|cascina)\b/i.test(v))
    return true;
  if (/\b(al|mi|no|bo|to|ge|rm|na|fi|bs|bg|pv|va|lc|cr|mn|pc|pr|mo|re|ra|fc|rn|ts|ud|tn|bz)\b/i.test(v))
    return true;
  return false;
}

/* =========================
   Intestatario extraction (ROBUST, CDV-proof)
========================= */

/**
 * Regola definitiva (copre TUTTI i casi CDV):
 * 1) Se esiste "Intestatario:" => usa quello (anche multi-line)
 * 2) Altrimenti, per i layout CDV nuovi: prendi la riga "nome cliente" SUBITO PRIMA di "Spett.le"
 * 3) Fallback legacy: "Spett.le" => prima riga sensata DOPO (saltando Data, Fattura, numeri, ecc.)
 */
function pickIntestatarioFromText(text: string): string | null {
  const clean = text.replace(/\r/g, "");

  // 1) Intestatario: ... (soprattutto negli allegati "dettaglio pazienti")
  const idx = clean.toLowerCase().indexOf("intestatario:");
  if (idx >= 0) {
    let tail = clean.slice(idx + "intestatario:".length);
    tail = tail.replace(/\n+/g, "\n").trim();

    const stop = tail.search(
      /\n(?:allegato\b|allegato\s+fattura\b|del\b|del:|competenza\b|competenza:|data\b|data:|fattura\b|fattura\s*n[°º]?:|codice\b|codice\s+cliente\b|partita\s+iva\b|p\.?\s*iva\b|pagina\b|stampato\b)/i
    );

    const raw = normalizeSpaces((stop >= 0 ? tail.slice(0, stop) : tail).replace(/\n/g, " "));
    if (raw && !isGenericClinicLabel(raw)) return raw;
  }

  // Prepara lines
  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const spett = lines.findIndex((l) => /^spett\.?le\.?/i.test(l));

  // 2) Layout CDV nuovo: NOME è PRIMA di "Spett.le"
  if (spett > 0) {
    // risali fino a trovare una riga "nome" che non sembri indirizzo
    for (let i = spett - 1; i >= Math.max(0, spett - 6); i--) {
      const c = lines[i];
      if (!c) continue;

      // scarta rumore
      if (/^(descrizione|quantità|prezzo|importo|iva)\b/i.test(c)) continue;
      if (/^cdv\b/i.test(c)) continue;
      if (looksLikeAddressLine(c)) continue;

      // scarta intestatari generici
      if (isGenericClinicLabel(c)) continue;

      // se è “buono”, è lui
      if (c.length >= 3) return c;
    }
  }

  // 3) Fallback legacy: nome DOPO "Spett.le" (ma non Data)
  if (spett >= 0) {
    for (let i = spett + 1; i < Math.min(spett + 12, lines.length); i++) {
      const c = lines[i];
      if (!c) continue;

      // scarta etichette/rumore tipico
      if (/^data\b/i.test(c)) continue;
      if (/^del\b/i.test(c)) continue;
      if (/^fattura\b/i.test(c)) continue;
      if (/^fattura\s*n[°º]?\b/i.test(c)) continue;
      if (/^codice\b/i.test(c)) continue;
      if (/^partita\s+iva\b/i.test(c)) continue;

      // scarta numeri fattura / formati tipici
      if (/^\d{2}\/\d{5}\b/.test(c)) continue; // 25/01963
      if (/^\d{2}-\d{4,}\b/.test(c)) continue; // 25-01963
      if (/^\d{2}\/\d{2}\/\d{4}\b/.test(c)) continue; // 02/12/2025

      if (looksLikeAddressLine(c)) continue;
      if (isGenericClinicLabel(c)) continue;

      if (c.length >= 3) return c;
    }
  }

  return null;
}

/* =========================
   Detect invoice vs attachment (CONTENT-BASED)
========================= */

function looksLikeAttachmentDetail(text: string) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("allegato fattura") ||
    t.includes("dettaglio pazienti") ||
    t.includes("dettaglio prestazioni") ||
    (t.includes("dettaglio") && t.includes("pazienti"))
  );
}

function looksLikeInvoice(text: string) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("fattura proforma") ||
    t.includes("totale fattura") ||
    t.includes("iva vendite") ||
    t.includes("imponibile complessivo") ||
    t.includes("totale imponibile") ||
    t.includes("totale iva")
  );
}

type ParsedEntry = {
  file: UploadedFile;
  text: string;
  isInvoice: boolean;
  isAttachment: boolean;
};

async function splitMainAndAttachments(groupFiles: UploadedFile[]) {
  const parsedList: ParsedEntry[] = await Promise.all(
    groupFiles.map(async (f) => {
      try {
        const p = await pdfParse(f.buffer);
        const text = p.text || "";
        const isAtt = looksLikeAttachmentDetail(text);
        const isInv = looksLikeInvoice(text) && !isAtt;
        return { file: f, text, isInvoice: isInv, isAttachment: isAtt };
      } catch {
        return { file: f, text: "", isInvoice: false, isAttachment: false };
      }
    })
  );

  let mainEntry = parsedList.find((x) => x.isInvoice);
  if (!mainEntry) mainEntry = parsedList.find((x) => !x.isAttachment);

  if (!mainEntry) {
    const fallback = [...parsedList].sort((a, b) =>
      (a.file.filename || "").localeCompare(b.file.filename || "", "it")
    );
    mainEntry = fallback[0];
  }

  const main = mainEntry.file;

  const attachments = parsedList
    .filter((x) => x.file !== main)
    .map((x) => x.file)
    .sort((a, b) => (a.filename || "").localeCompare(b.filename || "", "it"));

  return { main, attachments, parsedList };
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

      // main = fattura, attachments = allegati (ordine merge: fattura prima)
      const { main, attachments, parsedList } = await splitMainAndAttachments(groupFiles);

      // intestatario: prova nel main (CDV nuovo: prima di Spett.le), poi negli allegati (Intestatario:)
      let intestatario = "Documento";
      try {
        const mainText = parsedList.find((x) => x.file === main)?.text ?? "";
        let picked = pickIntestatarioFromText(mainText);

        if (!picked) {
          for (const a of attachments) {
            const txt = parsedList.find((x) => x.file === a)?.text ?? "";
            picked = pickIntestatarioFromText(txt);
            if (picked) break;
          }
        }

        if (picked) intestatario = picked;
      } catch {
        // continuiamo comunque
      }

      // merge: fattura prima, allegato/i dopo
      const merged = await mergePdfsInOrder([main.buffer, ...attachments.map((a) => a.buffer)]);

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

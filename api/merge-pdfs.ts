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

/**
 * ADDRESS DETECTION (robusta):
 * - CAP anche se "spezzato": 26 900 / 269 00 / 2 6 9 0 0
 * - righe con via/viale ecc
 * - righe con provincia (due lettere) tipicamente a fine riga
 * - righe con numeri (civici/codici) -> NON intestatario
 */
function looksLikeAddressLine(s: string) {
  const raw = normalizeSpaces(s);
  const v = raw.toLowerCase();

  // CAP anche spezzato: prima "colleziona" le cifre iniziali
  // es: "26 900 Lodi LO" => digitsStart = "26900"
  const mStart = raw.match(/^\D*(\d(?:\s*\d){3,9})/); // almeno 4 cifre con spazi opzionali
  if (mStart) {
    const digits = mStart[1].replace(/\s+/g, "");
    if (digits.length >= 5) return true; // inizia con almeno 5 cifre: CAP/codice
  }

  // CAP classico
  if (/^\d{5}\b/.test(raw)) return true;

  // parole tipiche indirizzo
  if (/\b(via|viale|piazza|p\.za|strada|cascina|corso|largo|vicolo)\b/i.test(v)) return true;

  // civico + keyword indirizzo
  if (/\b\d{1,4}([\/-]\w+)?\b/.test(raw) && /\b(via|viale|strada|corso|piazza|cascina|largo|vicolo)\b/i.test(v))
    return true;

  // "Città + sigla provincia" (es. "Lodi LO", "Rovellasca CO") -> riga indirizzo
  if (/\b[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+\s+[A-Z]{2}\b/.test(raw)) return true;

  // riga con parecchi numeri (date/codici/iban/cf ecc) => non nome
  const digitCount = (raw.match(/\d/g) || []).length;
  if (digitCount >= 3) return true;

  return false;
}

function hasLetters(s: string) {
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(s);
}

/* =========================
   Intestatario extraction (CDV-proof v2)
========================= */

const COMPANY_SUFFIX_RE =
  /\b(s\.?\s*r\.?\s*l\.?|s\.?\s*p\.?\s*a\.?|s\.?\s*a\.?\s*s\.?|s\.?\s*n\.?\s*c\.?|s\.?\s*s\.?|s\.?\s*c\.?\s*a\.?\s*r\.?\s*l\.?)\b/i;

const BAD_LABEL_RE =
  /^(data|del|fattura|fattura\s*n|codice|codice\s+cliente|partita\s+iva|p\.?\s*iva|codice\s+fiscale|pagina|condizioni|banca|abi|cab|iban|descrizione|quantità|prezzo|importo|iva)\b/i;

function isPlausibleNameLine(s: string) {
  const c = normalizeSpaces(s);
  if (!c || c.length < 3) return false;
  if (!hasLetters(c)) return false;
  if (isGenericClinicLabel(c)) return false;
  if (BAD_LABEL_RE.test(c.toLowerCase())) return false;
  if (looksLikeAddressLine(c)) return false;

  // Se contiene troppi numeri, NO
  const digitCount = (c.match(/\d/g) || []).length;
  if (digitCount > 0) return false;

  return true;
}

type PickTrace = {
  value: string | null;
  method:
  | "intestatario-inline"
  | "intestatario-multiline"
  | "spett-inline"
  | "spett-next"
  | "spett-prev"
  | "fallback-none";
  confidence: number;
  evidence?: string;
};

function scoreCandidate(line: string) {
  const c = normalizeSpaces(line);
  let score = 0;

  // base
  if (isPlausibleNameLine(c)) score += 70;

  // azienda
  if (COMPANY_SUFFIX_RE.test(c)) score += 20;

  // persona (dr/dott)
  if (/\b(dr|dott\.?|dottore)\b/i.test(c)) score += 10;

  // penalità
  if (looksLikeAddressLine(c)) score -= 80;
  if (BAD_LABEL_RE.test(c.toLowerCase())) score -= 50;
  if (/[0-9]/.test(c)) score -= 60;

  return score;
}

/**
 * Regola definitiva v2:
 * 1) Se esiste "Intestatario:" => usa quello (anche multi-line fino a stop marker)
 * 2) Attorno a "Spett.le": valuta candidati inline / dopo / prima e scegli il migliore a punteggio
 * 3) Altrimenti null
 */
function pickIntestatarioFromText(text: string): PickTrace {
  const clean = (text || "").replace(/\r/g, "");

  // 1) Intestatario: ... (spesso negli allegati)
  const idx = clean.toLowerCase().indexOf("intestatario:");
  if (idx >= 0) {
    let tail = clean.slice(idx + "intestatario:".length);
    tail = tail.replace(/\n+/g, "\n").trim();

    // stop markers
    const stop = tail.search(
      /\n(?:allegato\b|allegato\s+fattura\b|del\b|del:|competenza\b|competenza:|data\b|data:|fattura\b|fattura\s*n[°º]?:|codice\b|codice\s+cliente\b|partita\s+iva\b|p\.?\s*iva\b|pagina\b|stampato\b|condizioni\b|banca\b|iban\b)/i
    );

    const chunk = stop >= 0 ? tail.slice(0, stop) : tail;
    const raw = normalizeSpaces(chunk.replace(/\n/g, " "));
    const value = raw && isPlausibleNameLine(raw) ? raw : null;

    if (value) {
      return {
        value,
        method: "intestatario-multiline",
        confidence: 0.98,
        evidence: raw,
      };
    }
  }

  // lines
  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const spett = lines.findIndex((l) => /^spett\.?le\.?/i.test(l));

  if (spett >= 0) {
    const candidates: { line: string; method: PickTrace["method"]; base: number }[] = [];

    // 2a) inline: "Spett.le <nome>" nello stesso rigo (capita con certe estrazioni)
    const inline = normalizeSpaces(lines[spett].replace(/^spett\.?le\.?/i, ""));
    if (inline && inline.length >= 3) {
      candidates.push({ line: inline, method: "spett-inline", base: 0 });
    }

    // 2b) dopo Spett.le (max 6 righe)
    for (let i = spett + 1; i < Math.min(spett + 7, lines.length); i++) {
      const c = lines[i];
      if (!c) continue;
      candidates.push({ line: c, method: "spett-next", base: 0 });
    }

    // 2c) prima di Spett.le (max 6 righe) — perché pdf-parse a volte inverte l’ordine
    for (let i = spett - 1; i >= Math.max(0, spett - 6); i--) {
      const c = lines[i];
      if (!c) continue;
      // scarta header CDV
      if (/^cdv\b/i.test(c)) continue;
      candidates.push({ line: c, method: "spett-prev", base: -5 }); // leggero malus: preferisco dopo
    }

    // scegli best
    let best: { line: string; method: PickTrace["method"]; score: number } | null = null;

    for (const cand of candidates) {
      const s = scoreCandidate(cand.line) + cand.base;
      if (!best || s > best.score) best = { line: cand.line, method: cand.method, score: s };
    }

    if (best && best.score >= 60) {
      return {
        value: normalizeSpaces(best.line),
        method: best.method,
        confidence: Math.min(0.95, 0.70 + (best.score - 60) / 100),
        evidence: best.line,
      };
    }

    // se c’è Spett.le ma nessun candidato valido, ritorno null
  }

  return { value: null, method: "fallback-none", confidence: 0.0 };
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
        fileSize: 25 * 1024 * 1024,
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

      const { main, attachments, parsedList } = await splitMainAndAttachments(groupFiles);

      // Estrazione intestatario: prova su tutti i testi del gruppo e scegli il migliore a confidenza
      let intestatario = "Documento";
      let best: PickTrace | null = null;
      let bestFrom = "";

      for (const entry of parsedList) {
        const picked = pickIntestatarioFromText(entry.text || "");
        if (picked.value && (!best || picked.confidence > best.confidence)) {
          best = picked;
          bestFrom = entry.file.filename;
        }
      }

      if (best?.value) {
        intestatario = best.value;
      } else {
        intestatario = "Documento";
      }

      // Se per qualsiasi motivo intestatario sembra indirizzo/contiene numeri: fallback sicuro
      if (!isPlausibleNameLine(intestatario)) {
        intestatario = "Documento";
      }

      // Log solo nei casi “deboli” (così se ricapita lo becchi subito nei Vercel logs)
      if (!best || best.confidence < 0.85) {
        console.log("[NAMING_WEAK]", {
          groupId,
          chosen: intestatario,
          from: bestFrom || "n/a",
          method: best?.method || "n/a",
          conf: best?.confidence ?? 0,
          main: main.filename,
          attachments: attachments.map((a) => a.filename),
        });
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
import type { IncomingMessage, ServerResponse } from "http";
import Busboy from "busboy";
import JSZip from "jszip";
import pdfParse from "pdf-parse";
import { PDFDocument } from "pdf-lib";

/* =========================
   Types & helpers
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
   Filename & text utils
========================= */

function extractGroupIdFromFilename(name: string) {
  const m = name.match(/(\d{2}-\d{4,})/);
  return m ? m[1] : undefined;
}

function isAllegato(name: string) {
  return /_allegato/i.test(name);
}

function sanitizeFilenamePart(s: string) {
  return s
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function pickIntestatarioFromText(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const idx = lines.findIndex((l) =>
    /^spett\.?le\.?/i.test(l)
  );

  if (idx >= 0 && lines[idx + 1]) {
    return lines[idx + 1];
  }

  return (
    lines.find(
      (l) => !/^via\b|^v\.\b|^piazza\b|^p\.za\b/i.test(l)
    ) || null
  );
}

function stripCompanySuffixForFilename(name: string) {
  let s = name
    .replace(/^spett\.?le\.?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const patterns = [
    /\s+s\.?\s*a\.?\s*s\.?\s*\.?$/i,
    /\s+s\.?\s*r\.?\s*l\.?\s*\.?$/i,
    /\s+s\.?\s*p\.?\s*a\.?\s*\.?$/i,
    /\s+s\.?\s*n\.?\s*c\.?\s*\.?$/i,
    /\s+srls\.?\s*$/i,
    /\s+soc\.?\s*coop\.?\s*\.?$/i,
  ];

  for (const p of patterns) s = s.replace(p, "");

  return s.trim() || name.trim();
}

/* =========================
   Multipart reader (SAFE)
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
      file.on("limit", () =>
        done(new Error(`File troppo grande: ${info.filename}`))
      );
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

    req.on("aborted", () =>
      done(new Error("Upload interrotto dal client"))
    );

    req.pipe(bb);
  });
}

/* =========================
   PDF helpers
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

export default async function handler(
  req: VercelReq,
  resRaw: ServerResponse
) {
  const res = withStatus(resRaw);

  if (req.method === "GET") {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const uploaded = await readMultipart(req);

    const pdfs = uploaded.filter(
      (f) =>
        /pdf/i.test(f.mimeType || "") ||
        /\.pdf$/i.test(f.filename || "")
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

    for (const [groupId, files] of groups) {
      if (groupId === "altro" || files.length < 2) continue;

      const main =
        files.find((f) => !isAllegato(f.filename)) || files[0];

      const allegati = files
        .filter((f) => f !== main)
        .sort((a, b) =>
          a.filename.localeCompare(b.filename, "it")
        );

      let intestatario = "Documento";

      try {
        const parsed = await pdfParse(main.buffer);
        const raw = pickIntestatarioFromText(parsed.text || "");
        if (raw) intestatario = stripCompanySuffixForFilename(raw);
      } catch { }

      const merged = await mergePdfsInOrder([
        main.buffer,
        ...allegati.map((a) => a.buffer),
      ]);

      const safe = sanitizeFilenamePart(intestatario);
      zip.file(`${safe}_${groupId}.pdf`, merged);
    }

    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    res.setHeader("content-type", "application/zip");
    res.setHeader(
      "content-disposition",
      `attachment; filename="pdf_uniti.zip"`
    );

    res.status(200);
    resRaw.end(zipBuf);
  } catch (err: any) {
    return res.status(500).send(err?.message || "Errore merge PDF");
  }
}

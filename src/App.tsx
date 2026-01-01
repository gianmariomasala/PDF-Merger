import React, { useMemo, useRef, useState } from "react";
import {
      Upload,
      FileText,
      Trash2,
      Loader2,
      CheckCircle2,
      AlertCircle,
      File as FileIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface FileWithStatus {
      file: File;
      id: string;
      paired: boolean;
      groupId?: string;
}

const App: React.FC = () => {
      const [files, setFiles] = useState<FileWithStatus[]>([]);
      const [isProcessing, setIsProcessing] = useState(false);
      const [error, setError] = useState<string | null>(null);
      const [isSuccess, setIsSuccess] = useState(false);
      const [isDragging, setIsDragging] = useState(false);

      const fileInputRef = useRef<HTMLInputElement>(null);

      /* ===========================
         HELPERS
      =========================== */

      const extractGroupIdFromFilename = (name: string) => {
            const m = name.match(/(\d{2}-\d{4,})/);
            return m ? m[1] : undefined;
      };

      const updatePairing = (currentFiles: FileWithStatus[]) => {
            const groupCounts: Record<string, number> = {};
            currentFiles.forEach((f) => {
                  if (f.groupId) groupCounts[f.groupId] = (groupCounts[f.groupId] || 0) + 1;
            });

            const updated = currentFiles.map((f) => ({
                  ...f,
                  paired: !!(f.groupId && groupCounts[f.groupId] >= 2),
            }));

            setFiles(updated);
            setIsSuccess(false);
            setError(null);
      };

      /* ===========================
         FILE HANDLING
      =========================== */

      const handleFiles = (filesList: FileList | null) => {
            if (!filesList) return;

            const incoming: FileWithStatus[] = Array.from(filesList).map((f) => ({
                  file: f,
                  id: Math.random().toString(36).slice(2),
                  paired: false,
                  groupId: extractGroupIdFromFilename(f.name),
            }));

            updatePairing([...files, ...incoming]);
      };

      const removeFile = (id: string) => {
            updatePairing(files.filter((f) => f.id !== id));
      };

      const removeAll = () => {
            setFiles([]);
            setIsSuccess(false);
            setError(null);
      };

      /* ===========================
         UI GROUPING
      =========================== */

      const groupedFiles = useMemo(() => {
            return files.reduce<Record<string, FileWithStatus[]>>((acc, f) => {
                  const key = f.groupId || "altro";
                  if (!acc[key]) acc[key] = [];
                  acc[key].push(f);
                  return acc;
            }, {});
      }, [files]);

      const hasAnyPairedGroup = files.some((f) => f.paired);

      /* ===========================
         API CALL (Vercel Serverless)
      =========================== */

      const processFiles = async () => {
            if (files.length === 0) {
                  setError("Carica almeno 2 PDF per iniziare.");
                  return;
            }

            if (!hasAnyPairedGroup) {
                  setError(
                        "Nessuna coppia valida trovata. Carica almeno 2 PDF con lo stesso ID (es. 25-0249.pdf e 25-0249_Allegato1.pdf)."
                  );
                  return;
            }

            setIsProcessing(true);
            setError(null);
            setIsSuccess(false);

            try {
                  const formData = new FormData();
                  files.forEach((f) => formData.append("pdfs", f.file));

                  // IMPORTANT: endpoint relativo, compatibile Vercel
                  const res = await fetch("/api/merge-pdfs", {
                        method: "POST",
                        body: formData,
                  });

                  if (!res.ok) {
                        const txt = await res.text();
                        throw new Error(txt || "Errore durante il merge");
                  }

                  const blob = await res.blob();
                  const url = window.URL.createObjectURL(blob);

                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "pdf_uniti.zip";
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  window.URL.revokeObjectURL(url);

                  setIsSuccess(true);
            } catch (err: any) {
                  setError(err?.message || "Errore nel collegamento col server");
            } finally {
                  setIsProcessing(false);
            }
      };

      return (
            <div className="min-h-screen py-12 px-4 flex flex-col items-center bg-[#f8fafc] text-slate-800">
                  {/* Header */}
                  <div className="text-center mb-8">
                        <h1 className="text-4xl font-bold mb-2">Unisci PDF con Allegati</h1>
                        <p className="text-slate-500">
                              Carica file PDF con lo stesso numero nel titolo per unirli automaticamente
                        </p>
                  </div>

                  {/* Card */}
                  <div className="w-full max-w-2xl bg-white rounded-xl shadow-sm border border-slate-200 p-8">
                        <div className="flex items-center gap-2 mb-6 text-slate-800 font-bold text-lg">
                              <FileIcon size={20} />
                              <span>Unisci PDF con Allegati</span>
                        </div>

                        {/* Drop Zone */}
                        <div
                              onClick={() => fileInputRef.current?.click()}
                              onDragOver={(e) => {
                                    e.preventDefault();
                                    setIsDragging(true);
                              }}
                              onDragLeave={() => setIsDragging(false)}
                              onDrop={(e) => {
                                    e.preventDefault();
                                    setIsDragging(false);
                                    handleFiles(e.dataTransfer.files);
                              }}
                              className={`border-2 border-dashed rounded-lg p-12 flex flex-col items-center justify-center cursor-pointer transition-all ${isDragging
                                          ? "border-blue-500 bg-blue-50/50"
                                          : "border-slate-200 hover:border-blue-300 hover:bg-slate-50 bg-[#fafafa]"
                                    }`}
                        >
                              <input
                                    type="file"
                                    ref={fileInputRef}
                                    multiple
                                    accept="application/pdf"
                                    onChange={(e) => handleFiles(e.target.files)}
                                    className="hidden"
                              />
                              <Upload
                                    size={48}
                                    className={`mb-4 transition-colors ${isDragging ? "text-blue-500" : "text-slate-400"}`}
                                    strokeWidth={1.5}
                              />
                              <p className="text-slate-800 font-semibold text-lg mb-1">Trascina i file PDF qui</p>
                              <p className="text-slate-400 text-sm mb-6">Oppure clicca per selezionare i file</p>
                              <button
                                    type="button"
                                    className="bg-[#f0f4f8] text-slate-600 px-6 py-2 rounded-md font-medium hover:bg-slate-200 transition-colors"
                              >
                                    Seleziona File
                              </button>
                        </div>

                        {/* File List */}
                        {files.length > 0 && (
                              <div className="mt-8 space-y-4">
                                    <div className="flex items-center justify-between font-semibold text-slate-700 pb-2 border-b border-slate-100">
                                          <span>File Caricati ({files.length})</span>
                                          <button onClick={removeAll} className="text-red-500 text-sm">
                                                Rimuovi tutti
                                          </button>
                                    </div>

                                    <div className="max-h-60 overflow-y-auto pr-2 space-y-2">
                                          {Object.entries(groupedFiles).map(([groupId, groupFiles]) => (
                                                <div
                                                      key={groupId}
                                                      className={`p-3 rounded-lg border ${groupId !== "altro" && groupFiles.length >= 2
                                                                  ? "bg-green-50 border-green-100"
                                                                  : "bg-slate-50 border-slate-100"
                                                            }`}
                                                >
                                                      <div className="text-xs font-bold text-slate-400 uppercase mb-2">ID: {groupId}</div>

                                                      <div className="space-y-1">
                                                            {groupFiles.map((f) => (
                                                                  <div key={f.id} className="flex items-center justify-between text-sm">
                                                                        <div className="flex items-center gap-2 text-slate-600 truncate">
                                                                              <FileText size={14} />
                                                                              <span className="truncate">{f.file.name}</span>
                                                                        </div>

                                                                        <button
                                                                              onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    removeFile(f.id);
                                                                              }}
                                                                              className="text-slate-400 hover:text-red-500"
                                                                              title="Rimuovi"
                                                                        >
                                                                              <Trash2 size={14} />
                                                                        </button>
                                                                  </div>
                                                            ))}
                                                      </div>
                                                </div>
                                          ))}
                                    </div>

                                    {/* Bottone: sempre cliccabile (demo-safe), ma gestisce errori */}
                                    <button
                                          onClick={processFiles}
                                          disabled={isProcessing}
                                          className={`w-full py-3 rounded-lg font-bold text-white transition-all flex items-center justify-center gap-2 ${isProcessing ? "bg-slate-300 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700"
                                                }`}
                                    >
                                          {isProcessing ? (
                                                <>
                                                      <Loader2 className="animate-spin" size={20} /> Elaborazione...
                                                </>
                                          ) : (
                                                <>
                                                      <CheckCircle2 size={20} /> Unisci e Scarica
                                                </>
                                          )}
                                    </button>

                                    {!hasAnyPairedGroup && (
                                          <p className="text-xs text-slate-400 text-center">
                                                Carica almeno 2 PDF con lo stesso ID (es. 25-0249.pdf e 25-0249_Allegato1.pdf)
                                          </p>
                                    )}
                              </div>
                        )}
                  </div>

                  {/* Footer */}
                  <div className="mt-12 text-center text-slate-400 text-sm max-w-lg space-y-2">
                        <p>Carica file PDF con lo stesso numero nel titolo (es. 25-0249.pdf e 25-0249_Allegato1.pdf)</p>
                        <p>I file uniti saranno rinominati con intestatario e numero proforma</p>
                        <p className="pt-4 font-medium">Made with Dyad</p>
                  </div>

                  {/* Toasts */}
                  <AnimatePresence>
                        {error && (
                              <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 20 }}
                                    className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-red-50 border border-red-200 text-red-600 px-6 py-3 rounded-full shadow-lg flex items-center gap-2"
                              >
                                    <AlertCircle size={18} /> {error}
                              </motion.div>
                        )}
                        {isSuccess && (
                              <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 20 }}
                                    className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-green-50 border border-green-200 text-green-600 px-6 py-3 rounded-full shadow-lg flex items-center gap-2"
                              >
                                    <CheckCircle2 size={18} /> Merge completato!
                              </motion.div>
                        )}
                  </AnimatePresence>
            </div>
      );
};

export default App;
import React, { useState, useRef } from 'react';
import { Upload, FileText, Trash2, Loader2, CheckCircle2, AlertCircle, File as FileIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

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
      const fileInputRef = useRef<HTMLInputElement>(null);

      const [isDragging, setIsDragging] = useState(false);

      const handleFiles = (filesList: FileList | null) => {
            if (filesList) {
                  const newFiles = Array.from(filesList).map((f: File) => {
                        const idMatch = f.name.match(/(\d{2}-\d{4,})/);
                        return {
                              file: f,
                              id: Math.random().toString(36).substr(2, 9),
                              paired: false,
                              groupId: idMatch ? idMatch[1] : undefined
                        };
                  });

                  const allFiles = [...files, ...newFiles];
                  updatePairing(allFiles);
            }
      };

      const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
            handleFiles(e.target.files);
      };

      const handleDragOver = (e: React.DragEvent) => {
            e.preventDefault();
            setIsDragging(true);
      };

      const handleDragLeave = () => {
            setIsDragging(false);
      };

      const handleDrop = (e: React.DragEvent) => {
            e.preventDefault();
            setIsDragging(false);
            handleFiles(e.dataTransfer.files);
      };

      const updatePairing = (currentFiles: FileWithStatus[]) => {
            const groupCounts: Record<string, number> = {};
            currentFiles.forEach(f => {
                  if (f.groupId) {
                        groupCounts[f.groupId] = (groupCounts[f.groupId] || 0) + 1;
                  }
            });

            const updated = currentFiles.map(f => ({
                  ...f,
                  paired: f.groupId ? groupCounts[f.groupId] >= 2 : false
            }));
            setFiles(updated);
            setIsSuccess(false);
            setError(null);
      };

      const removeFile = (id: string) => {
            const remaining = files.filter(f => f.id !== id);
            updatePairing(remaining);
      };

      const processFiles = async () => {
            if (files.length === 0) return;

            setIsProcessing(true);
            setError(null);
            setIsSuccess(false);

            const formData = new FormData();
            files.forEach(f => formData.append('pdfs', f.file));

            try {
                  const response = await fetch('http://localhost:3001/api/merge-pdfs', {
                        method: 'POST',
                        body: formData,
                  });

                  if (!response.ok) {
                        const text = await response.text();
                        throw new Error(text || 'Errore durante il merge');
                  }

                  const blob = await response.blob();
                  const url = window.URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'pdf_uniti.zip';
                  document.body.appendChild(a);
                  a.click();
                  window.URL.revokeObjectURL(url);
                  document.body.removeChild(a);

                  setIsSuccess(true);
            } catch (err: any) {
                  setError(err.message || 'Errore nel collegamento col server');
            } finally {
                  setIsProcessing(false);
            }
      };

      const groupedFiles = files.reduce<Record<string, FileWithStatus[]>>((acc, f) => {
            const key = f.groupId || 'altro';
            if (!acc[key]) acc[key] = [];
            acc[key].push(f);
            return acc;
      }, {});

      return (
            <div className="min-h-screen py-12 px-4 flex flex-col items-center">
                  {/* Main Header */}
                  <div className="text-center mb-8">
                        <h1 className="text-4xl font-bold text-slate-800 mb-2">Unisci PDF con Allegati</h1>
                        <p className="text-slate-500">Carica file PDF con lo stesso numero nel titolo per unirli automaticamente</p>
                  </div>

                  {/* Main Card */}
                  <div className="w-full max-w-2xl bg-white rounded-xl shadow-sm border border-slate-200 p-8">
                        <div className="flex items-center gap-2 mb-6 text-slate-800 font-bold text-lg">
                              <FileIcon size={20} />
                              <span>Unisci PDF con Allegati</span>
                        </div>

                        {/* Drop Zone */}
                        <div
                              onClick={() => fileInputRef.current?.click()}
                              onDragOver={handleDragOver}
                              onDragLeave={handleDragLeave}
                              onDrop={handleDrop}
                              className={`border-2 border-dashed rounded-lg p-12 flex flex-col items-center justify-center cursor-pointer transition-all ${isDragging ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 hover:border-blue-300 hover:bg-slate-50 bg-[#fafafa]'
                                    }`}
                        >
                              <input
                                    type="file"
                                    ref={fileInputRef}
                                    multiple
                                    accept="application/pdf"
                                    onChange={handleFileChange}
                                    className="hidden"
                              />
                              <Upload size={48} className={`mb-4 transition-colors ${isDragging ? 'text-blue-500' : 'text-slate-400'}`} strokeWidth={1.5} />
                              <p className="text-slate-800 font-semibold text-lg mb-1">Trascina i file PDF qui</p>
                              <p className="text-slate-400 text-sm mb-6">Oppure clicca per selezionare i file</p>
                              <button className="bg-[#f0f4f8] text-slate-600 px-6 py-2 rounded-md font-medium hover:bg-slate-200 transition-colors">
                                    Seleziona File
                              </button>
                        </div>

                        {/* File List */}
                        {files.length > 0 && (
                              <div className="mt-8 space-y-4">
                                    <div className="flex items-center justify-between font-semibold text-slate-700 pb-2 border-b border-slate-100">
                                          <span>File Caricati ({files.length})</span>
                                          <button onClick={() => setFiles([])} className="text-red-500 text-sm">Rimuovi tutti</button>
                                    </div>
                                    <div className="max-h-60 overflow-y-auto pr-2 space-y-2">
                                          {Object.entries(groupedFiles).map(([groupId, groupFiles]) => (
                                                <div key={groupId} className={`p-3 rounded-lg border ${groupId !== 'altro' && groupFiles.length >= 2 ? 'bg-green-50 border-green-100' : 'bg-slate-50 border-slate-100'}`}>
                                                      <div className="text-xs font-bold text-slate-400 uppercase mb-2">ID: {groupId}</div>
                                                      <div className="space-y-1">
                                                            {groupFiles.map(f => (
                                                                  <div key={f.id} className="flex items-center justify-between text-sm">
                                                                        <div className="flex items-center gap-2 text-slate-600 truncate">
                                                                              <FileText size={14} />
                                                                              <span className="truncate">{f.file.name}</span>
                                                                        </div>
                                                                        <button onClick={(e) => { e.stopPropagation(); removeFile(f.id); }} className="text-slate-400 hover:text-red-500">
                                                                              <Trash2 size={14} />
                                                                        </button>
                                                                  </div>
                                                            ))}
                                                      </div>
                                                </div>
                                          ))}
                                    </div>
                                    <button
                                          onClick={processFiles}
                                          disabled={isProcessing || !files.some(f => f.paired)}
                                          className={`w-full py-3 rounded-lg font-bold text-white transition-all flex items-center justify-center gap-2 ${isProcessing || !files.some(f => f.paired)
                                                ? 'bg-slate-300 cursor-not-allowed'
                                                : 'bg-blue-600 hover:bg-blue-700'
                                                }`}
                                    >
                                          {isProcessing ? (
                                                <><Loader2 className="animate-spin" size={20} /> Elaborazione...</>
                                          ) : (
                                                <><CheckCircle2 size={20} /> Unisci e Scarica</>
                                          )}
                                    </button>
                              </div>
                        )}
                  </div>

                  {/* Footer Text */}
                  <div className="mt-12 text-center text-slate-400 text-sm max-w-lg space-y-2">
                        <p>Carica file PDF con lo stesso numero nel titolo (es. 25-0249.pdf e 25-0249_Allegato1.pdf)</p>
                        <p>I file uniti saranno rinominati con l'intestatario estratto dai documenti</p>
                        <p className="pt-4 font-medium">Made with Dyad</p>
                  </div>

                  {/* Messaging */}
                  <AnimatePresence>
                        {error && (
                              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-red-50 border border-red-200 text-red-600 px-6 py-3 rounded-full shadow-lg flex items-center gap-2">
                                    <AlertCircle size={18} /> {error}
                              </motion.div>
                        )}
                        {isSuccess && (
                              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-green-50 border border-green-200 text-green-600 px-6 py-3 rounded-full shadow-lg flex items-center gap-2">
                                    <CheckCircle2 size={18} /> Merge completato!
                              </motion.div>
                        )}
                  </AnimatePresence>
            </div>
      );
};

export default App;

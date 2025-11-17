import React, { useState, useCallback, ChangeEvent, useMemo, useRef } from 'react';
import { SelectedImage, Subtitle, Block, SrtAnalysis } from './types';
import { generateImageFromText } from './services/geminiService';


declare const JSZip: any;

// --- Helper Functions ---

const parseSrt = (srtText: string): Subtitle[] => {
    const subtitles: Subtitle[] = [];
    const lines = srtText.trim().replace(/\r/g, '').split('\n');
    let i = 0;

    const parseTimestamp = (ts: string): number => {
        const [h, m, s] = ts.split(':');
        const [sec, ms] = s.split(',');
        return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(sec) + parseInt(ms) / 1000;
    };

    while (i < lines.length) {
        const id = parseInt(lines[i]);
        if (isNaN(id)) { i++; continue; }

        const timeLine = lines[i + 1];
        if (!timeLine || !timeLine.includes('-->')) { i+=2; continue; }
        const [startStr, endStr] = timeLine.split(' --> ');
        
        let textLines = [];
        let j = i + 2;
        while(j < lines.length && lines[j].trim() !== '') {
            textLines.push(lines[j]);
            j++;
        }

        subtitles.push({
            id,
            start: parseTimestamp(startStr.trim()),
            end: parseTimestamp(endStr.trim()),
            text: textLines.join('\n'),
        });

        i = j + 1;
    }
    return subtitles;
};

const createBlocks = (subtitles: Subtitle[], minBlockSize: number = 4, maxBlockSize: number = 8): Block[] => {
    const blocks: Block[] = [];
    let i = 0;
    while (i < subtitles.length) {
        const remainingSubtitles = subtitles.length - i;
        const currentMin = Math.min(minBlockSize, remainingSubtitles);
        const currentMax = Math.min(maxBlockSize, remainingSubtitles);

        let blockSize;
        if (remainingSubtitles <= minBlockSize) {
            blockSize = remainingSubtitles;
        } else {
            // Ensure there are at least minBlockSize in the last block
            if (remainingSubtitles - currentMax < minBlockSize && remainingSubtitles > minBlockSize) {
                blockSize = Math.floor(Math.random() * (currentMax - currentMin + 1)) + currentMin;
                 if (i + blockSize < subtitles.length && (subtitles.length - (i + blockSize) < minBlockSize)) {
                    blockSize = remainingSubtitles; // If the next block is smaller than the min, group everything
                }
            } else {
                 blockSize = Math.floor(Math.random() * (currentMax - currentMin + 1)) + currentMin;
            }
        }
        
        const chunk = subtitles.slice(i, i + blockSize);
        const firstSub = chunk[0];
        const lastSub = chunk[chunk.length - 1];
        if (!firstSub || !lastSub) {
            i += blockSize;
            continue;
        }

        blocks.push({
            id: `block-${blocks.length + 1}`,
            subtitles: chunk,
            text: chunk.map(s => s.text).join('\n'),
            duration: lastSub.end - firstSub.start,
            image: undefined
        });
        i += blockSize;
    }
    return blocks;
};

const analyzeSrt = (subtitles: Subtitle[], blocks: Block[]): SrtAnalysis => {
    if (subtitles.length === 0) {
        return { totalSubtitles: 0, totalDurationSeconds: 0, totalWords: 0, averageWPM: 0, blockCount: 0 };
    }
    const totalDurationSeconds = subtitles[subtitles.length - 1].end;
    const totalWords = subtitles.reduce((acc, s) => acc + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
    const averageWPM = totalDurationSeconds > 0 ? Math.round((totalWords / totalDurationSeconds) * 60) : 0;

    return {
        totalSubtitles: subtitles.length,
        totalDurationSeconds,
        totalWords,
        averageWPM,
        blockCount: blocks.length,
    };
};

const createSingleVideo = (
    block: Block,
    width: number,
    height: number,
    mimeType: string
): Promise<Blob> => {
    return new Promise(async (resolve, reject) => {
        if (!block.image) {
            return reject(new Error(`Block ${block.id} has no image.`));
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return reject(new Error("Failed to create canvas context."));
        }
        ctx.fillStyle = 'black';

        try {
            const stream = canvas.captureStream(30);
            const recorder = new MediaRecorder(stream, { mimeType });

            const chunks: Blob[] = [];
            recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType });
                stream.getTracks().forEach(track => track.stop());
                resolve(blob);
            };
            recorder.onerror = (e) => {
                 stream.getTracks().forEach(track => track.stop());
                 reject(new Error("MediaRecorder error: " + e));
            };
            
            const bitmap = await createImageBitmap(block.image.file);
            const scale = Math.min(width / bitmap.width, height / bitmap.height);
            const scaledWidth = bitmap.width * scale;
            const scaledHeight = bitmap.height * scale;
            const x = (width - scaledWidth) / 2;
            const y = (height - scaledHeight) / 2;

            let frameId: number;
            const drawFrame = () => {
                if (!ctx) return;
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(bitmap, x, y, scaledWidth, scaledHeight);
                frameId = requestAnimationFrame(drawFrame);
            };

            recorder.start();
            drawFrame();

            setTimeout(() => {
                cancelAnimationFrame(frameId);
                bitmap.close();
                if (recorder.state === 'recording') {
                    recorder.stop();
                }
            }, block.duration * 1000);

        } catch (error) {
            reject(error);
        }
    });
};

const generateAndZipVideos = async (
    blocks: Block[],
    onProgress: (progress: number, stage: string) => void
): Promise<{ url: string, fileName: string }> => {
    if (blocks.length === 0 || blocks.some(b => !b.image)) {
        throw new Error("All blocks must have an image.");
    }
    if (typeof JSZip === 'undefined') {
        throw new Error("JSZip library not found. Cannot create ZIP file.");
    }

    const WIDTH = 1280;
    const HEIGHT = 720;
    const mimeTypes = ['video/mp4; codecs="avc1.42E01E"', 'video/webm; codecs=vp9'];
    const supportedMimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type)) || 'video/webm';
    const fileExtension = supportedMimeType.includes('mp4') ? 'mp4' : 'webm';
    
    const videoBlobs: { blob: Blob, fileName: string }[] = [];
    const totalBlocks = blocks.length;

    for (let i = 0; i < totalBlocks; i++) {
        const block = blocks[i];
        if (!block.image) continue;
        
        onProgress(((i + 1) / totalBlocks) * 50, `Generating video ${i + 1} of ${totalBlocks}...`);
        
        const fileName = `block_${String(i + 1).padStart(3, '0')}_(${block.duration.toFixed(2)}s).${fileExtension}`;
        const blob = await createSingleVideo(block, WIDTH, HEIGHT, supportedMimeType);
        videoBlobs.push({ blob, fileName });
    }

    const zip = new JSZip();
    onProgress(50, 'Zipping files...');
    for (let i = 0; i < videoBlobs.length; i++) {
        const { blob, fileName } = videoBlobs[i];
        zip.file(fileName, blob);
        onProgress(50 + ((i + 1) / videoBlobs.length) * 50, `Zipping file ${i + 1} of ${videoBlobs.length}...`);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    return { url, fileName: 'storyboard-videos.zip' };
};


// --- Icon Components ---
const UploadIcon: React.FC<{ className?: string }> = ({ className }) => (<svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>);
const FilmIcon: React.FC<{ className?: string }> = ({ className }) => (<svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9A2.25 2.25 0 0 0 4.5 18.75Z" /></svg>);
const SparklesIcon: React.FC<{ className?: string }> = ({ className }) => (<svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" /></svg>);
const DownloadIcon: React.FC<{ className?: string }> = ({ className }) => (<svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>);
const ArrowPathIcon: React.FC<{ className?: string }> = ({ className }) => (<svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 11.667 0l3.181-3.183m-4.991-2.691v4.992h-4.992m0 0-3.181-3.183a8.25 8.25 0 0 1 11.667 0l3.181 3.183" /></svg>);
const ClipboardIcon: React.FC<{ className?: string }> = ({ className }) => (<svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a2.25 2.25 0 0 1-2.25 2.25H9a2.25 2.25 0 0 1-2.25-2.25v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" /></svg>);
const PhotosIcon: React.FC<{ className?: string }> = ({ className }) => (<svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" /></svg>);


// --- UI Components ---

const SrtUploadZone: React.FC<{ 
    onSrtUpload: (srtText: string, fileName: string, minBlockSize: number, maxBlockSize: number) => void;
    minBlockSize: number;
    maxBlockSize: number;
    onMinBlockSizeChange: (size: number) => void;
    onMaxBlockSizeChange: (size: number) => void;
}> = ({ onSrtUpload, minBlockSize, maxBlockSize, onMinBlockSizeChange, onMaxBlockSizeChange }) => {
    const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                onSrtUpload(ev.target?.result as string, file.name, minBlockSize, maxBlockSize);
            };
            reader.readAsText(file);
        }
    };
    return (
        <div className="w-full max-w-2xl mx-auto text-center animate-fade-in">
            <h1 className="text-4xl md:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-brand-primary via-brand-secondary to-brand-light mb-4">
                SRT Video Storyboarder
            </h1>
            <p className="text-slate-400 mb-8 text-lg">Transforme qualquer arquivo de legenda em um storyboard de vídeo em segundos.</p>
            
            <div className="mb-6 bg-slate-800 p-4 rounded-lg shadow-md">
                <h3 className="text-xl font-bold text-slate-100 mb-3">Configurações de Geração de Blocos</h3>
                <div className="flex flex-col sm:flex-row justify-center gap-4">
                    <div className="flex-1">
                        <label htmlFor="min-block-size" className="block text-sm font-medium text-slate-400 text-left mb-1">Mín. Legendas por Bloco</label>
                        <input
                            type="number"
                            id="min-block-size"
                            min="1"
                            value={minBlockSize}
                            onChange={(e) => onMinBlockSizeChange(parseInt(e.target.value))}
                            className="w-full p-2 bg-slate-700 border border-slate-600 rounded-md text-slate-200 focus:ring-brand-primary focus:border-brand-primary"
                        />
                    </div>
                    <div className="flex-1">
                        <label htmlFor="max-block-size" className="block text-sm font-medium text-slate-400 text-left mb-1">Máx. Legendas por Bloco</label>
                        <input
                            type="number"
                            id="max-block-size"
                            min={minBlockSize}
                            value={maxBlockSize}
                            onChange={(e) => onMaxBlockSizeChange(parseInt(e.target.value))}
                            className="w-full p-2 bg-slate-700 border border-slate-600 rounded-md text-slate-200 focus:ring-brand-primary focus:border-brand-primary"
                        />
                    </div>
                </div>
                <p className="text-xs text-slate-500 mt-2 text-left">
                    Defina o número mínimo e máximo de legendas para agrupar em cada bloco. Blocos serão gerados aleatoriamente dentro desses limites.
                </p>
            </div>


            <label htmlFor="srt-upload" className="relative block w-full p-8 border-2 border-dashed border-slate-600 rounded-lg text-center cursor-pointer hover:border-brand-primary hover:bg-slate-800/50 transition-colors duration-300">
                <UploadIcon className="w-12 h-12 mx-auto text-slate-500 mb-4" />
                <span className="block font-semibold text-slate-300">Clique para enviar ou arraste e solte</span>
                <span className="block text-sm text-slate-500 mt-1">um arquivo de legenda SRT</span>
                <input id="srt-upload" type="file" accept=".srt" onChange={handleFileChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            </label>
        </div>
    );
};

const SrtAnalysisCard: React.FC<{ analysis: SrtAnalysis, blocks: Block[], onCopy: () => void, isCopied: boolean }> = ({ analysis, blocks, onCopy, isCopied }) => {
    const formatDuration = (totalSeconds: number) => {
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);
        return [
            hours.toString().padStart(2, '0'),
            minutes.toString().padStart(2, '0'),
            seconds.toString().padStart(2, '0')
        ].join(':');
    };

    return (
        <div className="w-full bg-slate-800 rounded-lg shadow-lg p-6 mb-8 animate-fade-in relative">
            <h3 className="text-xl font-bold text-slate-100 mb-4">Análise do Arquivo SRT</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 text-center">
                <div className="bg-slate-900/50 p-3 rounded-md">
                    <dt className="text-sm text-slate-400">Duração Total</dt>
                    <dd className="text-lg font-semibold text-brand-light">{formatDuration(analysis.totalDurationSeconds)}</dd>
                </div>
                 <div className="bg-slate-900/50 p-3 rounded-md">
                    <dt className="text-sm text-slate-400">Total de Legendas</dt>
                    <dd className="text-lg font-semibold text-brand-light">{analysis.totalSubtitles}</dd>
                </div>
                <div className="bg-slate-900/50 p-3 rounded-md">
                    <dt className="text-sm text-slate-400">Total de Palavras</dt>
                    <dd className="text-lg font-semibold text-brand-light">{analysis.totalWords}</dd>
                </div>
                <div className="bg-slate-900/50 p-3 rounded-md">
                    <dt className="text-sm text-slate-400">WPM Médio</dt>
                    <dd className="text-lg font-semibold text-brand-light">{analysis.averageWPM}</dd>
                </div>
                <div className="bg-slate-900/50 p-3 rounded-md">
                    <dt className="text-sm text-slate-400">Total de Blocos</dt>
                    <dd className="text-lg font-semibold text-brand-light">{analysis.blockCount}</dd>
                </div>
            </div>
            <div className="mt-6">
                <h4 className="text-lg font-semibold text-slate-200 mb-2">Duração dos Blocos</h4>
                <div className="bg-slate-900/50 p-4 rounded-md max-h-48 overflow-y-auto">
                    {blocks.map((block, index) => (
                        <p key={block.id} className="text-sm text-slate-300 font-mono tracking-tight py-0.5">
                            Block {index + 1} ({block.subtitles.length} subtitles): <span className="font-semibold text-brand-light">{block.duration.toFixed(2)} seconds</span>
                        </p>
                    ))}
                </div>
            </div>
             <button onClick={onCopy} className="absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-brand-primary text-slate-200 text-xs font-semibold rounded-md transition-all duration-200">
                <ClipboardIcon className="w-4 h-4" />
                {isCopied ? 'Copiado!' : 'Copiar Análise'}
            </button>
        </div>
    );
};

const BulkImageUpload: React.FC<{ onFilesSelect: (files: FileList | null) => void; blockCount: number }> = ({ onFilesSelect, blockCount }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
        onFilesSelect(e.target.files);
        // Reset the input value to allow uploading the same files again
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    return (
        <div className="w-full mb-8 text-center animate-fade-in">
            <button
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-3 px-6 py-3 bg-slate-700 hover:bg-brand-secondary text-white font-bold rounded-md transition-all duration-200 transform hover:scale-105 shadow-lg"
            >
                <PhotosIcon className="w-6 h-6" />
                Upload Multiple Images ({blockCount})
            </button>
            <p className="text-sm text-slate-400 mt-2">
                Envie imagens para todos os blocos de uma vez. Elas serão atribuídas em ordem.
            </p>
            <input
                type="file"
                accept="image/*"
                multiple
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
            />
        </div>
    );
};


const BlockCard: React.FC<{ 
    block: Block; 
    onImageSelect: (blockId: string, file: File) => void; 
    onGenerateAI: (blockId: string) => void;
    isGenerating: boolean;
    error: string | null;
}> = ({ block, onImageSelect, onGenerateAI, isGenerating, error }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            onImageSelect(block.id, file);
        }
    };

    const isLoading = isGenerating;

    return (
        <div className="bg-slate-800 rounded-lg overflow-hidden shadow-lg animate-fade-in transition-all duration-300 hover:shadow-brand-primary/20">
            <div className="p-4 border-b border-slate-700">
                <div className="flex justify-between items-center text-sm text-slate-400">
                    <span>{block.id.replace('-', ' ')}</span>
                    <span>Duração: <span className="font-semibold text-brand-light">{block.duration.toFixed(2)}s</span></span>
                </div>
            </div>
            <div className="p-4">
                <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans bg-slate-900/50 p-3 rounded-md max-h-40 overflow-y-auto">{block.text}</pre>
            </div>
            <div className="p-4 bg-slate-800/50">
                {isLoading ? (
                     <div className="flex flex-col items-center justify-center p-4 text-center">
                        <SparklesIcon className="w-8 h-8 text-brand-light animate-pulse-fast" />
                        <span className="mt-2 text-sm text-slate-300 font-semibold">Gerando com IA...</span>
                    </div>
                ) : error ? (
                    <div className="p-2 text-center bg-red-900/50 border border-red-700 rounded-md">
                        <p className="text-sm text-red-300">{error}</p>
                    </div>
                ) : block.image ? (
                     <img src={block.image.previewUrl} alt={`Preview for ${block.id}`} className="w-full h-auto object-cover rounded-md" />
                ) : (
                    <div className="space-y-3">
                         <button onClick={() => fileInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-700 hover:bg-brand-primary text-slate-200 font-semibold rounded-md transition-all duration-200 transform hover:scale-105">
                            <UploadIcon className="w-5 h-5" />
                            Upload Image
                        </button>
                        <button onClick={() => onGenerateAI(block.id)} className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-brand-primary to-brand-secondary text-white font-semibold rounded-md transition-all duration-200 transform hover:scale-105 hover:shadow-lg hover:shadow-brand-secondary/30">
                            <SparklesIcon className="w-5 h-5" />
                            Gerar com IA ✨
                        </button>
                        <input type="file" accept="image/*" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
                    </div>
                )}
            </div>
        </div>
    );
};

const GenerationControls: React.FC<{ 
    blocks: Block[]; 
    onGenerate: () => void;
    progress: number;
    stage: string;
    zipUrl: string | null;
    fileName: string;
    onStartOver: () => void;
}> = ({ blocks, onGenerate, progress, stage, zipUrl, fileName, onStartOver }) => {
    const allImagesUploaded = useMemo(() => blocks.every(b => b.image), [blocks]);

    if (zipUrl) {
        return (
            <div className="w-full p-6 bg-slate-800 rounded-lg text-center animate-fade-in shadow-lg sticky bottom-4">
                <h3 className="text-2xl font-bold text-green-400 mb-2">Geração Concluída!</h3>
                <p className="text-slate-300 mb-6">Seus clipes de vídeo estão prontos para download.</p>
                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                     <a href={zipUrl} download={fileName} className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-green-600 hover:bg-green-500 text-white font-bold rounded-md transition-all duration-200 transform hover:scale-105 shadow-lg">
                        <DownloadIcon className="w-6 h-6" />
                        Download ZIP
                    </a>
                     <button onClick={onStartOver} className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-slate-600 hover:bg-slate-500 text-white font-bold rounded-md transition-all duration-200 transform hover:scale-105">
                        <ArrowPathIcon className="w-6 h-6" />
                        Recomeçar
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className="w-full p-6 bg-slate-800 rounded-lg text-center animate-fade-in shadow-lg sticky bottom-4">
             <button onClick={onGenerate} disabled={!allImagesUploaded || progress > 0} className="w-full max-w-sm mx-auto flex items-center justify-center gap-3 px-6 py-4 bg-brand-primary hover:bg-brand-secondary disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-bold text-lg rounded-md transition-all duration-200 transform disabled:scale-100 hover:scale-105 shadow-lg disabled:shadow-none">
                <FilmIcon className="w-6 h-6" />
                Gerar {blocks.length} Vídeos
            </button>
            {!allImagesUploaded && <p className="text-sm text-slate-400 mt-3">Por favor, envie ou gere uma imagem para todos os blocos.</p>}
            {progress > 0 && (
                 <div className="mt-4 max-w-sm mx-auto">
                    <div className="w-full bg-slate-700 rounded-full h-2.5">
                        <div className="bg-brand-light h-2.5 rounded-full" style={{ width: `${progress}%` }}></div>
                    </div>
                    <p className="text-sm text-slate-300 mt-2">{stage}</p>
                </div>
            )}
        </div>
    );
};


// --- Main App Component ---

const App: React.FC = () => {
    const [blocks, setBlocks] = useState<Block[]>([]);
    const [srtFileName, setSrtFileName] = useState<string | null>(null);
    const [srtAnalysis, setSrtAnalysis] = useState<SrtAnalysis | null>(null);
    const [isAnalysisCopied, setIsAnalysisCopied] = useState(false);
    const [generationProgress, setGenerationProgress] = useState(0);
    const [generationStage, setGenerationStage] = useState('');
    const [zipUrl, setZipUrl] = useState<string | null>(null);
    const [zipFileName, setZipFileName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [generatingAIImageBlockId, setGeneratingAIImageBlockId] = useState<string | null>(null);
    const [blockErrors, setBlockErrors] = useState<Record<string, string>>({});

    const [minBlockSize, setMinBlockSize] = useState<number>(4);
    const [maxBlockSize, setMaxBlockSize] = useState<number>(8);


    const handleSrtUpload = useCallback((srtText: string, fileName: string, minSize: number, maxSize: number) => {
        try {
            const subtitles = parseSrt(srtText);
            const newBlocks = createBlocks(subtitles, minSize, maxSize); 
            setBlocks(newBlocks);
            setSrtAnalysis(analyzeSrt(subtitles, newBlocks));
            setSrtFileName(fileName);
            setError(null);
        } catch (e) {
            setError("Falha ao analisar o arquivo SRT. Verifique o formato do arquivo.");
            console.error(e);
        }
    }, []);

    const handleMinBlockSizeChange = useCallback((size: number) => {
        if (size < 1) size = 1;
        if (size > maxBlockSize) setMaxBlockSize(size);
        setMinBlockSize(size);
    }, [maxBlockSize]);

    const handleMaxBlockSizeChange = useCallback((size: number) => {
        if (size < minBlockSize) size = minBlockSize;
        setMaxBlockSize(size);
    }, [minBlockSize]);


    const handleImageSelect = useCallback((blockId: string, file: File) => {
        const newImage: SelectedImage = {
            id: blockId,
            file,
            previewUrl: URL.createObjectURL(file),
        };
        setBlocks(currentBlocks => 
            currentBlocks.map(b => {
                if (b.id === blockId) {
                    if (b.image?.previewUrl) {
                        URL.revokeObjectURL(b.image.previewUrl);
                    }
                    return { ...b, image: newImage };
                }
                return b;
            })
        );
    }, []);

    const handleBulkImageSelect = useCallback((files: FileList | null) => {
        if (!files || files.length === 0) return;
        
        const fileArray = Array.from(files);

        setBlocks(currentBlocks => {
            return currentBlocks.map((block, index) => {
                if (index < fileArray.length) {
                    const file = fileArray[index];
                    
                    if (block.image?.previewUrl) {
                        URL.revokeObjectURL(block.image.previewUrl);
                    }

                    const newImage: SelectedImage = {
                        id: block.id,
                        file,
                        previewUrl: URL.createObjectURL(file)
                    };

                    return { ...block, image: newImage };
                }
                return block;
            });
        });
    }, []);

    const handleGenerateImageWithAI = useCallback(async (blockId: string) => {
        const targetBlock = blocks.find(b => b.id === blockId);
        if (!targetBlock) return;

        setGeneratingAIImageBlockId(blockId);
        setBlockErrors(prev => {
            const newErrors = { ...prev };
            delete newErrors[blockId];
            return newErrors;
        });

        try {
            const { base64Data, mimeType } = await generateImageFromText(targetBlock.text);
            const imageBlob = await fetch(`data:${mimeType};base64,${base64Data}`).then(res => res.blob());
            const fileExtension = mimeType.split('/')[1] || 'png';
            const imageFile = new File([imageBlob], `${blockId}-ai-generated.${fileExtension}`, { type: mimeType });
            
            handleImageSelect(blockId, imageFile);
        } catch (error) {
            console.error(error);
            setBlockErrors(prev => ({
                ...prev,
                [blockId]: error instanceof Error ? error.message : "Generation failed."
            }));
        } finally {
            setGeneratingAIImageBlockId(null);
        }
    }, [blocks, handleImageSelect]);

    const handleGenerateAndZip = useCallback(async () => {
        setGenerationProgress(0.1);
        setGenerationStage('Iniciando geração...');
        try {
            const result = await generateAndZipVideos(blocks, (progress, stage) => {
                setGenerationProgress(progress);
                setGenerationStage(stage);
            });
            setZipUrl(result.url);
            setZipFileName(result.fileName);
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : "Ocorreu um erro desconhecido.";
            setError(`A geração do vídeo falhou: ${errorMessage}`);
            setGenerationProgress(0);
            setGenerationStage('');
            console.error(e);
        }
    }, [blocks]);

    const handleCopyAnalysis = useCallback(() => {
        if (!srtAnalysis) return;

        const formatDuration = (totalSeconds: number) => new Date(totalSeconds * 1000).toISOString().substr(11, 8);
    
        const blockDetailsText = blocks
            .map((block, index) => `Block ${index + 1} (${block.subtitles.length} subtitles): ${block.duration.toFixed(2)} seconds`)
            .join('\n');

        const analysisText = `
Análise do Arquivo SRT
-----------------
Duração Total: ${formatDuration(srtAnalysis.totalDurationSeconds)}
Total de Legendas: ${srtAnalysis.totalSubtitles}
Contagem Total de Palavras: ${srtAnalysis.totalWords}
Média de Palavras Por Minuto (WPM): ${srtAnalysis.averageWPM}
Total de Blocos Criados: ${srtAnalysis.blockCount}

Duração dos Blocos
--------------------
${blockDetailsText}
        `.trim().replace(/^\s+/gm, '');
    
        navigator.clipboard.writeText(analysisText).then(() => {
            setIsAnalysisCopied(true);
            setTimeout(() => setIsAnalysisCopied(false), 2000);
        }).catch(err => console.error('Falha ao copiar texto: ', err));
    }, [srtAnalysis, blocks]);
    
    const handleStartOver = useCallback(() => {
        if(zipUrl) URL.revokeObjectURL(zipUrl);
        
        blocks.forEach(block => {
            if (block.image?.previewUrl) {
                URL.revokeObjectURL(block.image.previewUrl);
            }
        });

        setBlocks([]);
        setSrtFileName(null);
        setSrtAnalysis(null);
        setIsAnalysisCopied(false);
        setGenerationProgress(0);
        setGenerationStage('');
        setZipUrl(null);
        setZipFileName('');
        setError(null);
        setGeneratingAIImageBlockId(null);
        setBlockErrors({});
        setMinBlockSize(4);
        setMaxBlockSize(8);
    }, [zipUrl, blocks]);

    return (
        <main className="min-h-screen w-full flex flex-col items-center justify-center p-4 sm:p-6 md:p-8">
            <div className="w-full max-w-7xl mx-auto">
                {blocks.length === 0 ? (
                    <SrtUploadZone 
                        onSrtUpload={handleSrtUpload} 
                        minBlockSize={minBlockSize}
                        maxBlockSize={maxBlockSize}
                        onMinBlockSizeChange={handleMinBlockSizeChange}
                        onMaxBlockSizeChange={handleMaxBlockSizeChange}
                    />
                ) : (
                    <>
                        <header className="mb-8 text-center animate-fade-in">
                            <h2 className="text-3xl font-bold text-slate-100">Storyboard para <span className="text-brand-light">{srtFileName}</span></h2>
                            <p className="text-slate-400 mt-1">Foram encontrados {blocks.length} blocos. Atribua uma imagem a cada um.</p>
                        </header>
                        
                        {srtAnalysis && <SrtAnalysisCard analysis={srtAnalysis} blocks={blocks} onCopy={handleCopyAnalysis} isCopied={isAnalysisCopied} />}

                        <BulkImageUpload onFilesSelect={handleBulkImageSelect} blockCount={blocks.length} />

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                            {blocks.map(block => (
                                <BlockCard 
                                    key={block.id} 
                                    block={block} 
                                    onImageSelect={handleImageSelect}
                                    onGenerateAI={handleGenerateImageWithAI}
                                    isGenerating={generatingAIImageBlockId === block.id}
                                    error={blockErrors[block.id] || null}
                                />
                            ))}
                        </div>
                       
                       <GenerationControls
                            blocks={blocks}
                            onGenerate={handleGenerateAndZip}
                            progress={generationProgress}
                            stage={generationStage}
                            zipUrl={zipUrl}
                            fileName={zipFileName}
                            onStartOver={handleStartOver}
                       />
                    </>
                )}
                {error && <div className="mt-6 p-4 bg-red-900/50 border border-red-700 text-red-300 rounded-md text-center">{error}</div>}
            </div>
        </main>
    );
};

export default App;

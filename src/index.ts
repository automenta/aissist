// main.ts
import {app, BrowserWindow, Menu, Notification, Tray} from 'electron';
import path from 'path';
import axios from 'axios';
import screenshotDesktop from 'screenshot-desktop';
import sharp from 'sharp';
import si from 'systeminformation';
import activeWin, {Result} from '@evgenys91/active-win';
import Tesseract from 'tesseract.js';
import crypto from 'crypto';
import {EventEmitter} from 'events';
import dotenv from 'dotenv';
import * as fs from "node:fs";

dotenv.config();

namespace Utils {
    export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    export const getEnvNumber = (key: string, defaultValue: number): number => {
        const value = parseInt(process.env[key] || '');
        return isNaN(value) ? defaultValue : value;
    };
    export const getEnvString = (key: string, defaultValue: string): string => {
        return process.env[key] || defaultValue;
    };
}

namespace Interfaces {
    export interface SubRegion {
        x: number;
        y: number;
        width: number;
        height: number;
    }
    export interface ProcessInfo {
        pid: number;
        name: string;
        cpu: number;
        memory: number;
    }
    export interface ActiveWindowInfo {
        title: string;
        owner: string;
        processId: number;
    }
    export interface OCRResult {
        text: string;
        confidence: number;
    }
    export interface LLMAnalysis {
        content: string;
    }
    export interface Snapshot {
        timestamp: Date;
        processes: ProcessInfo[];
        activeWindow: ActiveWindowInfo;
        screenshot: Buffer;
        ocrResult: OCRResult;
        llmAnalysis: LLMAnalysis;
        isDuplicate: boolean;
    }
    export interface NotificationPayload {
        type: NotificationType;
        message: string;
    }
    export enum NotificationType {
        Intentions = 'intentions',
        Error = 'error',
        Paused = 'paused',
        Resumed = 'resumed'
    }
}

class ProcessCollector {
    constructor(private readonly topN: number = 5) {}
    async collect(): Promise<Interfaces.ProcessInfo[]> {
        const procs = await si.processes();
        const byCPU = procs.list.sort((a, b) => b.cpu - a.cpu).slice(0, this.topN);
        const byMem = procs.list.sort((a, b) => b.memRss - a.memRss).slice(0, this.topN);
        const combined = [...byCPU, ...byMem];
        return Array.from(
            new Map(
                combined.map(p => [
                    p.pid,
                    {
                        pid: p.pid,
                        name: p.name,
                        cpu: parseFloat(p.cpu.toFixed(2)),
                        memory: parseFloat((p.memRss / (1024 * 1024)).toFixed(2))
                    }
                ])
            ).values()
        );
    }
}

class WindowCollector {
    async collect(): Promise<Interfaces.ActiveWindowInfo> {
        try {
            const win: Result | undefined = await activeWin();
            if (!win)
                return { title: 'Unknown', owner: 'Unknown', processId: -1 };
            else
                return {
                    title: win.title || 'No Title',
                    owner: win.owner?.name || 'Unknown',
                    processId: win.id || -1
                };
        } catch (error) {
            console.error('Error collecting active window:', error);
            return { title: 'Error', owner: 'Error', processId: -1 };
        }
    }
}

class OCRCollector {
    async collect(imageBuffer: Buffer): Promise<Interfaces.OCRResult> {
        try {
            const { data } = await Tesseract.recognize(imageBuffer, 'eng', { logger: () => {} });
            return { text: data.text.trim(), confidence: data.confidence };
        } catch (error) {
            console.error('OCR error:', error);
            return { text: '', confidence: 0 };
        }
    }
}

class DuplicateDetector {
    private previousHash: string | null = null;
    computeHash(buffer: Buffer): string {
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }
    isDuplicate(buffer: Buffer): boolean {
        const currentHash = this.computeHash(buffer);
        if (this.previousHash === currentHash) return true;
        this.previousHash = currentHash;
        return false;
    }
}

class SnapshotManager {
    private processCollector = new ProcessCollector(this.topNProcesses);
    private windowCollector = new WindowCollector();
    private ocrCollector = new OCRCollector();
    private duplicateDetector = new DuplicateDetector();

    constructor(private topNProcesses: number = 5, private subRegion?: Interfaces.SubRegion) {}

    private async captureScreenshot(): Promise<Buffer> {
        const screenshotBuffer = await screenshotDesktop({ format: 'png' });
        if (this.subRegion) {
            const { x, y, width, height } = this.subRegion;
            return await sharp(screenshotBuffer)
                .extract({ left: x, top: y, width, height })
                .png()
                .toBuffer();
        }
        return screenshotBuffer;
    }

    async createSnapshot(): Promise<Interfaces.Snapshot> {
        try {
            const screenshotBuffer = await this.captureScreenshot();
            const isDuplicate = this.duplicateDetector.isDuplicate(screenshotBuffer);
            if (isDuplicate) {
                return {
                    timestamp: new Date(),
                    processes: [],
                    activeWindow: { title: '', owner: '', processId: -1 },
                    screenshot: screenshotBuffer,
                    ocrResult: { text: '', confidence: 0 },
                    llmAnalysis: { content: '' },
                    isDuplicate: true
                };
            }
            const [processes, activeWindow, ocrResult] = await Promise.all([
                this.processCollector.collect(),
                this.windowCollector.collect(),
                this.ocrCollector.collect(screenshotBuffer)
            ]);
            return {
                timestamp: new Date(),
                processes,
                activeWindow,
                screenshot: screenshotBuffer,
                ocrResult,
                llmAnalysis: { content: '' },
                isDuplicate: false
            };
        } catch (error) {
            console.error('Error creating snapshot:', error);
            throw error;
        }
    }
}

class ScreenshotAnalyzer extends EventEmitter {
    private history: Interfaces.Snapshot[] = [];
    private isPaused: boolean = false;

    constructor(
        private visionOllamaUrl: string,
        private visionModel: string,
        private nonVisionOllamaUrl: string,
        private nonVisionModel: string,
        private historyLimit: number,
        private analysisInterval: number,
        private intentInferenceInterval: number,
        private snapshotManager: SnapshotManager
    ) {
        super();
    }

    async analyzeSnapshot(snapshot: Interfaces.Snapshot): Promise<void> {
        if (snapshot.isDuplicate) return;
        const base64Image = snapshot.screenshot.toString('base64');
        try {
            const response = await axios.post(this.visionOllamaUrl, {
                model: this.visionModel,
                messages: [
                    {
                        role: 'user',
                        content: 'Analyze the screenshot and provided context.',
                        //content: 'Analyze the user context based on the provided data.',
                        images: [base64Image]
                    }
                ],
                stream: false
            });
            if (response.data?.message?.content) {
                snapshot.llmAnalysis.content = response.data.message.content;
            } else {
                snapshot.llmAnalysis.content = 'Invalid response structure.';
                console.error('Invalid response structure from vision LLM:', response.data);
            }
        } catch (error) {
            console.error('Error analyzing snapshot with vision LLM:', error);
            snapshot.llmAnalysis.content = 'Analysis failed.';
        }
    }

    async reasonUserActivity(prompt: string): Promise<string> {
        try {
            const response = await axios.post(this.nonVisionOllamaUrl, {
                model: this.nonVisionModel,
                messages: [{ role: 'user', content: prompt }],
                stream: false
            });
            if (response.data?.message?.content) {
                return response.data.message.content;
            } else {
                console.error('Invalid response structure from non-vision LLM:', response.data);
                return 'Invalid response from reasoning LLM.';
            }
        } catch (error) {
            console.error('Error reasoning user activity:', error);
            return 'Reasoning failed.';
        }
    }

    async inferUserIntentions(): Promise<string> {
        const prompts = this.history
            .filter(s => !s.isDuplicate)
            .map((s, i) => `Snapshot ${i + 1}:\n${s.llmAnalysis.content}`)
            .join('\n\n');
        const combinedPrompt = `Infer user intentions given the following analyses:\n\n${prompts}\n\nUser Intentions:`;
        return await this.reasonUserActivity(combinedPrompt);
    }

    async run(): Promise<void> {
        while (true) {
            if (!this.isPaused) {
                try {
                    const snapshot = await this.snapshotManager.createSnapshot();
                    if (!snapshot.isDuplicate) {
                        await this.analyzeSnapshot(snapshot);
                    }
                    this.history.push(snapshot);
                    if (this.history.length > this.historyLimit) this.history.shift();
                    this.emit('data-update', snapshot);

                    if (this.history.length > 0 && this.history.length % this.intentInferenceInterval === 0) {
                        const intentions = await this.inferUserIntentions();
                        this.emit('notification', { type: Interfaces.NotificationType.Intentions, message: intentions });
                    }
                } catch (error: any) {
                    console.error('Error during analysis loop:', error);
                    this.emit('notification', { type: Interfaces.NotificationType.Error, message: `Error during analysis loop: ${error.message || error}` });
                }
            }
            await Utils.delay(this.analysisInterval);
        }
    }

    pause(): void {
        if (!this.isPaused) {
            this.isPaused = true;
            this.emit('notification', { type: Interfaces.NotificationType.Paused, message: 'Data collection paused.' });
        }
    }

    resume(): void {
        if (this.isPaused) {
            this.isPaused = false;
            this.emit('notification', { type: Interfaces.NotificationType.Resumed, message: 'Data collection resumed.' });
        }
    }
}

class ElectronApp {
    private mainWindow: BrowserWindow | null = null;
    private tray: Tray | null = null;
    private analyzer: ScreenshotAnalyzer;

    constructor(private config: Config) {
        this.analyzer = new ScreenshotAnalyzer(
            config.visionOllamaUrl,
            config.visionModel,
            config.nonVisionOllamaUrl,
            config.nonVisionModel,
            config.historyLimit,
            config.analysisInterval,
            config.intentInferenceInterval,
            config.snapshotManager
        );
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        this.analyzer.on('notification', (payload: Interfaces.NotificationPayload) => {
            this.showNotification(payload);
            this.updateStatusInWindow(payload);
        });
        this.analyzer.on('data-update', (snapshot: Interfaces.Snapshot) => {
            console.log(snapshot);
            this.sendDataToWindow(snapshot);
        });
    }

    private createWindow(): void {


        this.mainWindow = new BrowserWindow({
            width: 400,
            height: 300,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            },
            show: false
        });

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Control Panel</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                #status { font-weight: bold; }
                #data { margin-top: 20px; }
                pre { overflow: auto; max-width: 100%; max-height: 100%; background-color: #f0f0f0; padding: 10px; }
            </style>
        </head>
        <body>           
            <p>Status: <span id="status">Running</span></p>
            <div id="data"></div>
            <script>
                function printableReplacer(key, value) {
                    if (key === 'screenshot') return '[Buffer]'; //avoid printing buffer's characters
                    return value;
                }
        
                window.electronAPI.onStatusUpdate((status) => {
                    document.getElementById('status').innerText = status;
                });
                
                window.electronAPI.onDataUpdate((data) => {
                    const dataDiv = document.getElementById('data');
                    const pre = document.createElement('pre');
                    pre.textContent = JSON.stringify(data, printableReplacer, 2);
                    dataDiv.innerHTML = '';
                    dataDiv.appendChild(pre);
                });
            </script>
        </body>
        </html>
        `;

        this.mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));

        this.mainWindow.on('close', (e) => {
            e.preventDefault();
            this.mainWindow?.hide();
        });
    }

    private createTray(): void {
        const iconPath = path.join('/home/me/d/doom.png');
        if (!fs.existsSync(iconPath))
            console.error(`Tray icon not found at path: ${iconPath}`);

        this.tray = new Tray(iconPath);
        this.updateTrayMenu(false);
        //this.tray.setToolTip('');
        this.tray.on('click', () => {
            if (this.mainWindow)
                this.mainWindow.isVisible() ? this.mainWindow.hide() : this.mainWindow.show();
        });
    }

    private updateTrayMenu(isPaused: boolean): void {
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open', click: () => { this.mainWindow?.show(); } },
            { type: 'separator' },
            {
                label: isPaused ? 'Resume Analysis' : 'Pause Analysis',
                click: () => {
                    if (isPaused) {
                        this.analyzer.resume();
                    } else {
                        this.analyzer.pause();
                    }
                    this.updateTrayMenu(!isPaused);
                }
            },
            { type: 'separator' },
            { label: 'Exit', click: () => { app.exit(0); } }
        ]);
        this.tray?.setContextMenu(contextMenu);
    }

    private showNotification(payload: Interfaces.NotificationPayload): void {
        new Notification({ title: 'Screenshot Analyzer', body: payload.message }).show();
    }

    private updateStatusInWindow(payload: Interfaces.NotificationPayload): void {
        if (this.mainWindow) {
            let status = '';
            switch (payload.type) {
                case Interfaces.NotificationType.Paused:
                    status = 'Paused';
                    break;
                case Interfaces.NotificationType.Resumed:
                    status = 'Running';
                    break;
                case Interfaces.NotificationType.Intentions:
                    status = `Intentions: ${payload.message}`;
                    break;
                case Interfaces.NotificationType.Error:
                    status = `Error: ${payload.message}`;
                    break;
                default:
                    status = payload.message;
            }
            this.mainWindow.webContents.send('status-update', status);
        }
    }

    private sendDataToWindow(snapshot: Interfaces.Snapshot): void {
        if (this.mainWindow)
            this.mainWindow.webContents.send('data-update', snapshot);
    }

    init(): void {
        app.whenReady().then(() => {
            this.createWindow();
            this.createTray();
            this.analyzer.run();
            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) this.createWindow();
            });
        });

        app.on('window-all-closed', () => {
            app.exit(0);
        });
    }
}

const model =
    'llava:7b'
    //'hf.co/cjpais/llava-1.6-mistral-7b-gguf:Q4_K_M';

class Config {
    visionOllamaUrl = Utils.getEnvString('VISION_OLLAMA_URL', 'http://localhost:11434/api/chat');
    visionModel = Utils.getEnvString('VISION_MODEL',
        model
    );
    nonVisionOllamaUrl = Utils.getEnvString('NON_VISION_OLLAMA_URL', 'http://localhost:11434/api/chat');
    nonVisionModel = Utils.getEnvString('NON_VISION_MODEL', model);
    historyLimit = Utils.getEnvNumber('HISTORY_LIMIT', 20);
    analysisInterval = Utils.getEnvNumber('ANALYSIS_INTERVAL', 10000);
    intentInferenceInterval = Utils.getEnvNumber('INTENT_INFERENCE_INTERVAL', 5);
    subRegion: Interfaces.SubRegion = {
        x: Utils.getEnvNumber('SUB_REGION_X', 0),
        y: Utils.getEnvNumber('SUB_REGION_Y', 0),
        width: Utils.getEnvNumber('SUB_REGION_WIDTH', 640/*1920*/),
        height: Utils.getEnvNumber('SUB_REGION_HEIGHT', 480/*1080*/)
    };
    snapshotManager = new SnapshotManager(5, this.subRegion);
}

new ElectronApp(new Config()).init();

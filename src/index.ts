// main.ts
import { app, BrowserWindow, Tray, Menu, ipcMain, Notification } from 'electron';
import path from 'path';
import axios from 'axios';
import screenshotDesktop from 'screenshot-desktop';
import sharp from 'sharp';
import si from 'systeminformation';
import activeWin, {Result} from '@evgenys91/active-win';
import Tesseract from 'tesseract.js';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import dotenv from 'dotenv';
import ActiveWindowInfo = Interfaces.ActiveWindowInfo;

// Load environment variables from .env file
dotenv.config();

/**
 * Utility namespace containing helper functions and types.
 */
namespace Utils {
    /**
     * Pauses execution for a specified number of milliseconds.
     * @param ms - Milliseconds to delay.
     */
    export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    /**
     * Safely retrieves a numeric environment variable or returns a default value.
     * @param key - The environment variable key.
     * @param defaultValue - The default value if the environment variable is not set or invalid.
     */
    export const getEnvNumber = (key: string, defaultValue: number): number => {
        const value = parseInt(process.env[key] || '');
        return isNaN(value) ? defaultValue : value;
    };

    /**
     * Safely retrieves a string environment variable or returns a default value.
     * @param key - The environment variable key.
     * @param defaultValue - The default value if the environment variable is not set.
     */
    export const getEnvString = (key: string, defaultValue: string): string => {
        return process.env[key] || defaultValue;
    };
}

/**
 * Interface definitions for various data structures used in the application.
 */
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

/**
 * Collects information about system processes.
 */
class ProcessCollector {
    private readonly topN: number;

    constructor(topN: number = 5) {
        this.topN = topN;
    }

    /**
     * Collects the top N processes by CPU and memory usage.
     * @returns An array of ProcessInfo objects.
     */
    async collect(): Promise<Interfaces.ProcessInfo[]> {
        const procs = await si.processes();
        const byCPU = [...procs.list].sort((a, b) => b.cpu - a.cpu).slice(0, this.topN);
        const byMem = [...procs.list].sort((a, b) => b.memRss - a.memRss).slice(0, this.topN);

        const combined = [...byCPU, ...byMem];
        return Array.from(new Map(combined.map(p => [p.pid, {
            pid: p.pid,
            name: p.name,
            cpu: parseFloat(p.cpu.toFixed(2)),
            memory: parseFloat((p.memRss / (1024 * 1024)).toFixed(2))
        }])).values());
    }
}

/**
 * Collects information about the currently active window.
 */
class WindowCollector {
    /**
     * Collects active window information.
     * @returns An ActiveWindowInfo object.
     */
    async collect(): Promise<Interfaces.ActiveWindowInfo> {
        try {
            const y:Result|undefined  = await activeWin();
            if (!y) {
                return { title: 'Unknown', owner: 'Unknown', processId: -1 };
            } else {
                return {
                    title: y.title || 'No Title',
                    owner: y.owner?.name || 'Unknown',
                    processId: y.id || -1
                };
            }
        } catch (error) {
            console.error('Error collecting active window:', error, '\nIs "xwininfo" installed?');
            return { title: 'Error', owner: 'Error', processId: -1 };
        }
    }
}

/**
 * Performs OCR on images.
 */
class OCRCollector {
    /**
     * Performs OCR on the provided image buffer.
     * @param imageBuffer - The image buffer to process.
     * @returns An OCRResult object.
     */
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

/**
 * Detects duplicate screenshots based on their hash.
 */
class DuplicateDetector {
    private previousHash: string | null = null;

    /**
     * Computes the SHA-256 hash of a buffer.
     * @param buffer - The buffer to hash.
     * @returns The hexadecimal hash string.
     */
    computeHash(buffer: Buffer): string {
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }

    /**
     * Determines if the provided buffer is a duplicate of the previous one.
     * @param buffer - The buffer to check.
     * @returns True if duplicate, else false.
     */
    isDuplicate(buffer: Buffer): boolean {
        const currentHash = this.computeHash(buffer);
        if (this.previousHash === currentHash) {
            return true;
        }
        this.previousHash = currentHash;
        return false;
    }
}

/**
 * Manages the creation of snapshots containing various system and user data.
 */
class SnapshotManager {
    private processCollector: ProcessCollector;
    private windowCollector: WindowCollector;
    private ocrCollector: OCRCollector;
    private duplicateDetector: DuplicateDetector;
    private subRegion?: Interfaces.SubRegion;

    constructor(topNProcesses: number = 5, subRegion?: Interfaces.SubRegion) {
        this.processCollector = new ProcessCollector(topNProcesses);
        this.windowCollector = new WindowCollector();
        this.ocrCollector = new OCRCollector();
        this.duplicateDetector = new DuplicateDetector();
        this.subRegion = subRegion;
    }

    /**
     * Captures a screenshot, optionally cropping to a subregion.
     * @returns A Buffer containing the screenshot image.
     */
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

    /**
     * Creates a snapshot containing system and user data.
     * @returns A Snapshot object.
     */
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

/**
 * Analyzes snapshots using LLMs and infers user intentions.
 */
class ScreenshotAnalyzer extends EventEmitter {
    private visionOllamaUrl: string;
    private visionModel: string;
    private nonVisionOllamaUrl: string;
    private nonVisionModel: string;
    private history: Interfaces.Snapshot[] = [];
    private historyLimit: number;
    private analysisInterval: number;
    private intentInferenceInterval: number;
    private snapshotManager: SnapshotManager;
    private isPaused: boolean = false;

    constructor(
        visionOllamaUrl: string,
        visionModel: string,
        nonVisionOllamaUrl: string,
        nonVisionModel: string,
        historyLimit: number = 20,
        analysisInterval: number = 10000,
        intentInferenceInterval: number = 5,
        snapshotManager: SnapshotManager
    ) {
        super();
        this.visionOllamaUrl = visionOllamaUrl;
        this.visionModel = visionModel;
        this.nonVisionOllamaUrl = nonVisionOllamaUrl;
        this.nonVisionModel = nonVisionModel;
        this.historyLimit = historyLimit;
        this.analysisInterval = analysisInterval;
        this.intentInferenceInterval = intentInferenceInterval;
        this.snapshotManager = snapshotManager;
    }

    /**
     * Analyzes a snapshot using the vision LLM.
     * @param snapshot - The snapshot to analyze.
     */
    async analyzeSnapshot(snapshot: Interfaces.Snapshot): Promise<void> {
        if (snapshot.isDuplicate) return;

        const base64Image = snapshot.screenshot.toString('base64');
        try {
            const response = await axios.post(this.visionOllamaUrl, {
                model: this.visionModel,
                messages: [
                    {
                        role: 'user',
                        content: 'Analyze the user context based on the provided data.',
                        images: [base64Image]
                    }
                ],
                stream: false
            });

            // Validate response structure
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

    /**
     * Sends a prompt to the non-vision LLM to reason about user activity.
     * @param prompt - The prompt to send.
     * @returns The LLM's response as a string.
     */
    async reasonUserActivity(prompt: string): Promise<string> {
        try {
            const response = await axios.post(this.nonVisionOllamaUrl, {
                model: this.nonVisionModel,
                messages: [{ role: 'user', content: prompt }],
                stream: false
            });

            // Validate response structure
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

    /**
     * Infers user intentions based on the history of LLM analyses.
     * @returns A string describing the inferred user intentions.
     */
    async inferUserIntentions(): Promise<string> {
        const prompts = this.history
            .filter(s => !s.isDuplicate)
            .map((s, i) => `Snapshot ${i + 1}:\n${s.llmAnalysis.content}`)
            .join('\n\n');
        const combinedPrompt = `Based on the following user context analyses, infer the user's current intentions or goals:\n\n${prompts}\n\nUser Intentions:`;
        return await this.reasonUserActivity(combinedPrompt);
    }

    /**
     * Starts the analysis loop.
     */
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

                    if (this.history.length > 0 && this.history.length % this.intentInferenceInterval === 0) {
                        const intentions = await this.inferUserIntentions();
                        this.emit('notification', { type: Interfaces.NotificationType.Intentions, message: intentions });
                    }
                } catch (error:any) {
                    console.error('Error during analysis loop:', error);
                    this.emit('notification', { type: Interfaces.NotificationType.Error, message: `Error during analysis loop: ${error.message || error}` });
                }
            }
            await Utils.delay(this.analysisInterval);
        }
    }

    /**
     * Pauses the analysis loop.
     */
    pause(): void {
        if (!this.isPaused) {
            this.isPaused = true;
            this.emit('notification', { type: Interfaces.NotificationType.Paused, message: 'Data collection paused.' });
        }
    }

    /**
     * Resumes the analysis loop.
     */
    resume(): void {
        if (this.isPaused) {
            this.isPaused = false;
            this.emit('notification', { type: Interfaces.NotificationType.Resumed, message: 'Data collection resumed.' });
        }
    }
}

/**
 * Manages the Electron application, including windows and tray.
 */
class ElectronApp {
    private mainWindow: BrowserWindow | null = null;
    private tray: Tray | null = null;
    private analyzer: ScreenshotAnalyzer;
    private config: Config;

    constructor(config: Config) {
        this.config = config;
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

    /**
     * Sets up event listeners for the analyzer.
     */
    private setupEventListeners(): void {
        this.analyzer.on('notification', (payload: Interfaces.NotificationPayload) => {
            this.showNotification(payload);
            this.updateStatusInWindow(payload);
        });
    }

    /**
     * Creates the main application window.
     */
    private createWindow(): void {
        this.mainWindow = new BrowserWindow({
            width: 400,
            height: 300,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'), // Ensure preload.js is correctly set up
                contextIsolation: true,
                nodeIntegration: false
            },
            show: false
        });

        this.mainWindow.loadFile(path.join(__dirname, 'control-panel.html'));

        this.mainWindow.on('close', (e) => {
            e.preventDefault();
            this.mainWindow?.hide();
        });
    }

    /**
     * Creates the system tray icon and context menu.
     */
    private createTray(): void {
        const iconPath = path.join('/home/me/d/doom.png');
        if (!fs.existsSync(iconPath)) {
            console.error(`Tray icon not found at path: ${iconPath}`);
        }

        this.tray = new Tray(iconPath);
        this.updateTrayMenu(false);

        this.tray.setToolTip('Screenshot Analyzer');

        this.tray.on('click', () => {
            if (this.mainWindow) {
                this.mainWindow.isVisible() ? this.mainWindow.hide() : this.mainWindow.show();
            }
        });
    }

    /**
     * Updates the tray context menu based on the current state.
     * @param isPaused - Indicates whether the analysis is paused.
     */
    private updateTrayMenu(isPaused: boolean): void {
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open Control Panel', click: () => { this.mainWindow?.show(); } },
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
            { label: 'Quit', click: () => { app.quit(); } }
        ]);
        this.tray?.setContextMenu(contextMenu);
    }

    /**
     * Displays a system notification.
     * @param payload - The notification payload containing type and message.
     */
    private showNotification(payload: Interfaces.NotificationPayload): void {
        new Notification({ title: 'Screenshot Analyzer', body: payload.message }).show();
    }

    /**
     * Updates the status displayed in the main window.
     * @param payload - The notification payload containing type and message.
     */
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

    /**
     * Initializes and starts the Electron application.
     */
    init(): void {
        app.whenReady().then(() => {
            this.createWindow();
            this.createTray();

            // Start the analyzer loop
            this.analyzer.run();

            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) this.createWindow();
            });
        });

        app.on('window-all-closed', () => {
            // Keep the app running even if all windows are closed (common for tray apps)
            if (process.platform !== 'darwin') {
                // Uncomment the next line if you want to quit the app when all windows are closed
                // app.quit();
            }
        });
    }

    // /**
    //  * Sends configuration data to the renderer process if needed.
    //  * @param callback - The callback to handle IPC messages.
    //  */
    // setupIPC(): void {
    //     ipcMain.on('request-config', (event) => {
    //         event.sender.send('config-data', this.config);
    //     });
    // }
}

/**
 * Configuration class holding all configurable parameters.
 */
class Config {
    visionOllamaUrl: string;
    visionModel: string;
    nonVisionOllamaUrl: string;
    nonVisionModel: string;
    historyLimit: number;
    analysisInterval: number;
    intentInferenceInterval: number;
    subRegion: Interfaces.SubRegion;
    snapshotManager: SnapshotManager;

    constructor() {
        this.visionOllamaUrl = Utils.getEnvString('VISION_OLLAMA_URL', 'http://localhost:11434/api/chat');
        this.visionModel = Utils.getEnvString('VISION_MODEL', 'llava:7b');
        this.nonVisionOllamaUrl = Utils.getEnvString('NON_VISION_OLLAMA_URL', 'http://localhost:11434/api/chat');
        this.nonVisionModel = Utils.getEnvString('NON_VISION_MODEL', 'llava:7b');
        this.historyLimit = Utils.getEnvNumber('HISTORY_LIMIT', 20);
        this.analysisInterval = Utils.getEnvNumber('ANALYSIS_INTERVAL', 10000);
        this.intentInferenceInterval = Utils.getEnvNumber('INTENT_INFERENCE_INTERVAL', 5);

        this.subRegion = {
            x: Utils.getEnvNumber('SUB_REGION_X', 0),
            y: Utils.getEnvNumber('SUB_REGION_Y', 0),
            width: Utils.getEnvNumber('SUB_REGION_WIDTH', 1920),
            height: Utils.getEnvNumber('SUB_REGION_HEIGHT', 1080)
        };

        this.snapshotManager = new SnapshotManager(5, this.subRegion);
    }
}

// Generate control-panel.html if it doesn't exist
const controlPanelPath = path.join(__dirname, 'control-panel.html');
if (!fs.existsSync(controlPanelPath)) {
    const htmlContent = `
    <!DOCTYPE html>
    <html>
        <head>
            <title>Control Panel</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                #status { font-weight: bold; }
            </style>
        </head>
        <body>
            <h1>Screenshot Analyzer</h1>
            <p>Status: <span id="status">Running</span></p>
            <script>
                window.electronAPI.onStatusUpdate((status) => {
                    document.getElementById('status').innerText = status;
                });
            </script>
        </body>
    </html>
    `;
    fs.writeFileSync(controlPanelPath, htmlContent, { encoding: 'utf-8' });
}

// Initialize and run the Electron application
const config = new Config();
const electronApp = new ElectronApp(config);
// electronApp.setupIPC();
electronApp.init();

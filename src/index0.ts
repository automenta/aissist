// import * as path from 'path';
// import * as fs from 'fs';
// import { EventEmitter } from 'events';
// import { app, BrowserWindow, ipcMain, Notification } from 'electron';
// import screenshot from 'screenshot-desktop';
// import axios from 'axios';
//
// const platform = process.platform; // 'win32', 'darwin', 'linux'
//
// interface ConfigSchema {
//     api: {
//         endpoint: string;
//         modelName: string;
//         apiKey?: string;
//     };
//     assistant: {
//         captureInterval: number; // in seconds
//         screenshotBufferSize: number;
//         inputEventBufferSize: number;
//     };
//     logging: {
//         level: string;
//         file: string;
//     };
// }
//
// class ConfigurationManager {
//     private configPath: string;
//     private config: ConfigSchema;
//
//     constructor() {
//         this.configPath = path.join(app.getPath('userData'), 'config.json');
//         this.config = this.loadConfig();
//     }
//
//     private loadConfig(): ConfigSchema {
//         if (fs.existsSync(this.configPath)) {
//             const data = fs.readFileSync(this.configPath, 'utf-8');
//             return JSON.parse(data) as ConfigSchema;
//         } else {
//             const defaultConfig: ConfigSchema = {
//                 api: {
//                     endpoint: 'http://localhost:11434/api/generate',
//                     modelName: 'llama3.2-vision:11b',
//                     //modelName: 'llama3.2:1b',
//                     apiKey: '' // If authentication is required
//                 },
//                 assistant: {
//                     captureInterval: 15, // seconds
//                     screenshotBufferSize: 10,
//                     inputEventBufferSize: 100
//                 },
//                 logging: {
//                     level: 'debug',
//                     //level: 'info',
//                     file: 'assistant.log'
//                 }
//             };
//             fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2));
//             return defaultConfig;
//         }
//     }
//
//     public getConfig(): ConfigSchema {
//         return this.config;
//     }
// }
//
// // -------------------------- Logger -------------------------- //
//
// enum LogLevel {
//     DEBUG = 'debug',
//     INFO = 'info',
//     WARNING = 'warning',
//     ERROR = 'error'
// }
//
// class Logger {
//     private logStream: fs.WriteStream;
//     private level: LogLevel;
//
//     constructor(logFilePath: string, level: string) {
//         this.logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
//         this.level = level.toLowerCase() as LogLevel;
//     }
//
//     private shouldLog(level: LogLevel): boolean {
//         const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARNING, LogLevel.ERROR];
//         return levels.indexOf(level) >= levels.indexOf(this.level);
//     }
//
//     public log(level: LogLevel, message: string): void {
//         if (this.shouldLog(level)) {
//             const timestamp = new Date().toISOString();
//             const logMessage = `${timestamp} - ${level.toUpperCase()}: ${message}\n`;
//             this.logStream.write(logMessage);
//             console.log(logMessage.trim());
//         }
//     }
//
//     public debug(message: string): void {
//         this.log(LogLevel.DEBUG, message);
//     }
//
//     public info(message: string): void {
//         this.log(LogLevel.INFO, message);
//     }
//
//     public warning(message: string): void {
//         this.log(LogLevel.WARNING, message);
//     }
//
//     public error(message: string): void {
//         this.log(LogLevel.ERROR, message);
//     }
// }
//
// // -------------------------- Input Event Manager -------------------------- //
//
// interface InputEvent {
//     type: string;
//     details: string;
//     timestamp: number;
// }
//
// class InputEventManager extends EventEmitter {
//     private inputEvents: InputEvent[] = [];
//     private bufferSize: number;
//     private logger: Logger;
//
//     // Platform-specific listeners
//     private keyboardListener: any;
//     private mouseListener: any;
//
//     constructor(bufferSize: number, logger: Logger) {
//         super();
//         this.bufferSize = bufferSize;
//         this.logger = logger;
//         this.initializeListeners();
//     }
//
//     private initializeListeners(): void {
//         try {
//             if (platform === 'linux') {
//                 // Linux: Use the provided mouse listener code
//                 this.mouseListener = new LinuxMouseListener(this.logger);
//                 this.mouseListener.on('button', (event: any) => {
//                     this.addEvent({
//                         type: 'mouse_click',
//                         details: `Button ${event.button} at (${event.x}, ${event.y})`,
//                         timestamp: event.timestamp
//                     });
//                     this.logger.debug(`Mouse clicked: Button ${event.button} at (${event.x}, ${event.y})`);
//                 });
//
//                 this.mouseListener.on('moved', (event: any) => {
//                     this.addEvent({
//                         type: 'mouse_moved',
//                         details: `Moved by (${event.xDelta}, ${event.yDelta})`,
//                         timestamp: event.timestamp
//                     });
//                     this.logger.debug(`Mouse moved: Delta (${event.xDelta}, ${event.yDelta})`);
//                 });
//
//                 this.mouseListener.start();
//
//                 // Keyboard Listener: Use an alternative library or implement a simple key logger
//                 // For demonstration, we'll use 'readline' to capture key presses from the terminal
//                 // In a real-world scenario, you'd use a proper key logger library compatible with Linux
//                 // WARNING: Implementing a key logger can have security and privacy implications
//
//                 const readline = require('readline');
//                 readline.emitKeypressEvents(process.stdin);
//                 if (process.stdin.isTTY) {
//                     process.stdin.setRawMode(true);
//                     process.stdin.on('keypress', (str: string, key: any) => {
//                         if (key.sequence === '\u0003') { // Ctrl+C to exit
//                             process.exit();
//                         }
//                         this.addEvent({
//                             type: 'key_press',
//                             details: `Key ${key.name}`,
//                             timestamp: Date.now()
//                         });
//                         this.logger.debug(`Key pressed: ${key.name}`);
//                     });
//                     this.logger.info('Keyboard listener initialized.');
//                 }
//
//                 this.logger.info('Linux input listeners initialized.');
//             } else {
//                 this.logger.error(`Unsupported platform: ${platform}`);
//                 throw new Error(`Unsupported platform: ${platform}`);
//             }
//         } catch (error: any) {
//             this.logger.error(`Error initializing input listeners: ${error.message || error}`);
//             throw error;
//         }
//     }
//
//     private addEvent(event: InputEvent): void {
//         this.inputEvents.push(event);
//         if (this.inputEvents.length > this.bufferSize)
//             this.inputEvents.shift();
//
//         this.emit('eventAdded', event);
//     }
//
//     public getEvents(): InputEvent[] {
//         return [...this.inputEvents];
//     }
//
//     public clearEvents(): void {
//         this.inputEvents = [];
//     }
// }
//
// // -------------------------- Linux Mouse Listener -------------------------- //
//
// /**
//  * Read Linux mouse(s) in node.js
//  * Author: Marc Loehe (marcloehe@gmail.com)
//  *
//  * Adapted from Tim Caswell's nice solution to read a linux joystick
//  * http://nodebits.org/linux-joystick
//  * https://github.com/nodebits/linux-joystick
//  */
//
// class LinuxMouseListener extends EventEmitter {
//     private fs = require('fs');
//     private dev: string;
//     private fd: number | undefined;
//     private buf: Buffer;
//
//     constructor(private logger: Logger, mouseid?: number) {
//         super();
//         this.dev = typeof(mouseid) === 'number' ? `mouse${mouseid}` : 'mice';
//         this.buf = Buffer.alloc(3);
//     }
//
//     public start(): void {
//         this.fs.open(`/dev/input/${this.dev}`, 'r', (err: any, fd: number) => {
//             if (err) {
//                 this.logger.error(`Failed to open ${this.dev}: ${err.message}`);
//                 this.emit('error', err);
//                 return;
//             }
//             this.fd = fd;
//             this.logger.info(`Opened ${this.dev} for reading.`);
//             this.startRead();
//         });
//     }
//
//     private startRead(): void {
//         if (this.fd === undefined) return;
//         this.fs.read(this.fd, this.buf, 0, 3, null, (err: any, bytesRead: number, buffer: Buffer) => {
//             if (err) {
//                 this.logger.error(`Error reading from ${this.dev}: ${err.message}`);
//                 this.emit('error', err);
//                 return;
//             }
//             if (bytesRead === 3) {
//                 const event = this.parse(buffer);
//                 this.emit(event.type, event);
//             }
//             this.startRead(); // Continue reading
//         });
//     }
//
//     private parse(buffer: Buffer): any {
//         const event:any = {
//             leftBtn: (buffer[0] & 1) > 0,    // Bit 0
//             rightBtn: (buffer[0] & 2) > 0,   // Bit 1
//             middleBtn: (buffer[0] & 4) > 0,  // Bit 2
//             xSign: (buffer[0] & 16) > 0,     // Bit 4
//             ySign: (buffer[0] & 32) > 0,     // Bit 5
//             xOverflow: (buffer[0] & 64) > 0, // Bit 6
//             yOverflow: (buffer[0] & 128) > 0,// Bit 7
//             xDelta: buffer.readInt8(1),       // Byte 2 as signed int
//             yDelta: buffer.readInt8(2)        // Byte 3 as signed int
//         };
//         event.type = event.leftBtn || event.rightBtn || event.middleBtn ? 'button' : 'moved';
//         return event;
//     }
//
//     public close(): void {
//         if (this.fd !== undefined) {
//             this.fs.close(this.fd, (err: any) => {
//                 if (err)
//                     this.logger.error(`Error closing ${this.dev}: ${err.message}`);
//                 else
//                     this.logger.info(`Closed ${this.dev}.`);
//             });
//             this.fd = undefined;
//         }
//     }
// }
//
// // -------------------------- Screenshot Manager -------------------------- //
//
// class ScreenshotManager {
//     private screenshotBuffer: Buffer[] = [];
//     private bufferSize: number;
//     private logger: Logger;
//
//     constructor(bufferSize: number, logger: Logger) {
//         this.bufferSize = bufferSize;
//         this.logger = logger;
//     }
//
//     public async captureScreenshot(): Promise<void> {
//         try {
//             const img = await screenshot({ format: 'png' });
//             this.screenshotBuffer.push(img);
//             if (this.screenshotBuffer.length > this.bufferSize)
//                 this.screenshotBuffer.shift();
//
//             this.logger.debug('Screenshot captured and added to buffer.');
//         } catch (error: any) {
//             this.logger.error(`Error capturing screenshot: ${error.message || error}`);
//         }
//     }
//
//     public getLatestScreenshot(): Buffer | null {
//         return this.screenshotBuffer.length === 0 ? null :
//             this.screenshotBuffer[this.screenshotBuffer.length - 1];
//     }
// }
//
// // -------------------------- Intent Inference Service -------------------------- //
//
// class IntentInferenceService {
//     private apiEndpoint: string;
//     private modelName: string;
//     private apiKey?: string;
//     private logger: Logger;
//
//     constructor(apiEndpoint: string, modelName: string, apiKey: string | undefined, logger: Logger) {
//         this.apiEndpoint = apiEndpoint;
//         this.modelName = modelName;
//         this.apiKey = apiKey;
//         this.logger = logger;
//     }
//
//     private formatEvents(events: InputEvent[]): string {
//         return events.map(event => `${event.type}: ${event.details}`).join('; ');
//     }
//
//     private cleanIntent(intentRaw: string): string {
//         return intentRaw.split('\n')[0];
//     }
//
//     public async inferIntent(screenshot: Buffer | null, events: InputEvent[]): Promise<string> {
//         if (!screenshot) {
//             this.logger.warning('No screenshot available for intent inference.');
//             return 'No screenshot available.';
//         }
//
//         const imgBase64 = screenshot.toString('base64');
//         const formattedEvents = this.formatEvents(events);
//
//         const prompt = `User has performed the following actions: ${formattedEvents}\nCurrent screen context: [IMAGE]\nInfer the user's intent based on the above information.`;
//
//         const data = {
//             model: this.modelName,
//             prompt: prompt,
//             images: [imgBase64],
//             stream: false
//         };
//
//         const headers: any = {
//             'Content-Type': 'application/json',
//         };
//
//         if (this.apiKey && this.apiKey.trim() !== '')
//             headers['Authorization'] = `Bearer ${this.apiKey}`;
//
//         try {
//             console.log(prompt);
//             const response = await axios.post(this.apiEndpoint, data, { headers, timeout: 30000 });
//             console.log(response);
//             const responseData = response.data;
//             const intentRaw = responseData.response || 'No response from model';
//             const intent = this.cleanIntent(intentRaw);
//             this.logger.info(`Inferred intent: ${intent}`);
//             return intent;
//         } catch (error: any) {
//             this.logger.error(`Error inferring intent: ${error.message || error}`);
//             return `Error inferring intent: ${error.message || error}`;
//         }
//     }
// }
//
// // -------------------------- Assistant Engine -------------------------- //
//
// class AssistantEngine {
//     private notificationHandler: (message: string) => void;
//     private logger: Logger;
//
//     constructor(notificationHandler: (message: string) => void, logger: Logger) {
//         this.notificationHandler = notificationHandler;
//         this.logger = logger;
//     }
//
//     public handleIntent(intent: string): void {
//         let message = '';
//         const lowerIntent = intent.toLowerCase();
//
//         if (lowerIntent.includes('writing an email')) {
//             message = "It looks like you're writing an email. Do you need a template or grammar suggestions?";
//         } else if (lowerIntent.includes('browsing the web')) {
//             message = "You're browsing the web. Would you like to organize your bookmarks or manage tabs?";
//         } else if (lowerIntent.includes('editing a document')) {
//             message = "Editing a document detected. Would you like assistance with formatting or citations?";
//         } else {
//             message = `Current intent: ${intent}`;
//         }
//
//         this.notificationHandler(message);
//         this.logger.info(`Assistant Engine processed intent: ${intent}`);
//     }
// }
//
// // -------------------------- GUI Manager -------------------------- //
//
// class GUIManager {
//     private mainWindow: BrowserWindow | null = null;
//     private eventEmitter: EventEmitter;
//
//     constructor() {
//         this.eventEmitter = new EventEmitter();
//         this.createWindow();
//         this.setupIPC();
//     }
//
//     private createWindow(): void {
//         this.mainWindow = new BrowserWindow({
//             width: 600,
//             height: 400,
//             webPreferences: {
//                 preload: path.join(__dirname, 'preload.ts'), // If needed
//                 nodeIntegration: true,
//                 contextIsolation: false,
//             },
//             resizable: false,
//         });
//
//         // Load HTML content
//         this.mainWindow.loadURL(`data:text/html,
//       <html>
//         <head>
//           <title>AI Assistant Status</title>
//           <style>
//             body { font-family: Arial, sans-serif; padding: 20px; }
//             h1 { text-align: center; }
//             .status { margin: 20px 0; }
//             .label { font-weight: bold; }
//             #exitButton { padding: 10px 20px; font-size: 16px; }
//           </style>
//         </head>
//         <body>
//           <h1>AI Assistant Status</h1>
//           <div class="status">
//             <div><span class="label">AI Assistant:</span> Active</div>
//             <div><span class="label">Current Intent:</span> <span id="intent">None</span></div>
//             <div><span class="label">Last Notification:</span> <span id="notification">None</span></div>
//           </div>
//           <button id="exitButton">Exit</button>
//           <script>
//             const { ipcRenderer } = require('electron');
//             document.getElementById('exitButton').addEventListener('click', () => {
//               ipcRenderer.send('exit-app');
//             });
//
//             ipcRenderer.on('update-intent', (event, intent) => {
//               document.getElementById('intent').innerText = intent;
//             });
//
//             ipcRenderer.on('update-notification', (event, notification) => {
//               document.getElementById('notification').innerText = notification;
//             });
//           </script>
//         </body>
//       </html>
//     `);
//
//         this.mainWindow.on('closed', () => {
//             this.mainWindow = null;
//         });
//     }
//
//     private setupIPC(): void {
//         ipcMain.on('exit-app', () => {
//             this.eventEmitter.emit('exit');
//         });
//     }
//
//     public updateIntent(intent: string): void {
//         if (this.mainWindow) {
//             this.mainWindow.webContents.send('update-intent', intent);
//         }
//     }
//
//     public updateNotification(notification: string): void {
//         if (this.mainWindow) {
//             this.mainWindow.webContents.send('update-notification', notification);
//         }
//     }
//
//     public onExit(callback: () => void): void {
//         this.eventEmitter.on('exit', callback);
//     }
// }
//
// // -------------------------- Notification Handler -------------------------- //
//
// class NotificationHandler {
//     constructor() {}
//
//     public sendNotification(message: string): void {
//         new Notification({ title: 'AI Assistant Notification', body: message }).show();
//     }
// }
//
// // -------------------------- Main Application -------------------------- //
//
// class AI_Assistant_App {
//     private configManager: ConfigurationManager;
//     private logger: Logger;
//     private inputEventManager: InputEventManager;
//     private screenshotManager: ScreenshotManager;
//     private intentService: IntentInferenceService;
//     private assistantEngine: AssistantEngine;
//     private guiManager: GUIManager;
//     private notificationHandler: NotificationHandler;
//     private running: boolean = true;
//
//     constructor() {
//         this.configManager = new ConfigurationManager();
//         const config = this.configManager.getConfig();
//
//         this.logger = new Logger(
//             path.join(app.getPath('userData'), config.logging.file),
//             config.logging.level
//         );
//
//         this.notificationHandler = new NotificationHandler();
//
//         this.inputEventManager = new InputEventManager(
//             config.assistant.inputEventBufferSize,
//             this.logger
//         );
//
//         this.screenshotManager = new ScreenshotManager(
//             config.assistant.screenshotBufferSize,
//             this.logger
//         );
//
//         this.intentService = new IntentInferenceService(
//             config.api.endpoint,
//             config.api.modelName,
//             config.api.apiKey,
//             this.logger
//         );
//
//         this.assistantEngine = new AssistantEngine(
//             this.notificationHandler.sendNotification.bind(this.notificationHandler),
//             this.logger
//         );
//
//         this.guiManager = new GUIManager();
//
//         this.setupExitHandler();
//     }
//
//     private setupExitHandler(): void {
//         this.guiManager.onExit(() => {
//             this.shutdown();
//         });
//
//         app.on('before-quit', () => {
//             this.shutdown();
//         });
//     }
//
//     private async assistantLoop(): Promise<void> {
//         const config = this.configManager.getConfig();
//         const captureIntervalMs = config.assistant.captureInterval * 1000;
//
//         while (this.running) {
//             // Capture screenshot
//             await this.screenshotManager.captureScreenshot();
//             const latestScreenshot = this.screenshotManager.getLatestScreenshot();
//
//             // Gather input events
//             const events = this.inputEventManager.getEvents();
//             this.inputEventManager.clearEvents();
//
//             // Infer intent
//             const intent = await this.intentService.inferIntent(latestScreenshot, events);
//
//             // Update GUI
//             this.guiManager.updateIntent(intent);
//             this.guiManager.updateNotification(intent);
//
//             // Handle intent
//             this.assistantEngine.handleIntent(intent);
//
//             // Wait for next interval
//             await this.sleep(captureIntervalMs);
//         }
//     }
//
//     private sleep(ms: number): Promise<void> {
//         return new Promise(resolve => setTimeout(resolve, ms));
//     }
//
//     private shutdown(): void {
//         this.running = false;
//         // Stop all listeners based on platform
//         if (this.inputEventManager) {
//             if (platform === 'linux') {
//                 this.inputEventManager['mouseListener'].close();
//                 // For keyboard, since we're using readline, there's no explicit stop
//                 // To gracefully exit, you might need to handle it differently
//             }
//             // Add conditions for other platforms if needed
//         }
//         this.logger.info('AI Assistant has been terminated.');
//         app.quit();
//     }
//
//     public async start(): Promise<void> {
//         await this.assistantLoop();
//     }
// }
//
// // -------------------------- App Lifecycle -------------------------- //
//
// let aiAssistantApp: AI_Assistant_App | null = null;
//
// function createAppInstance(): AI_Assistant_App {
//     if (!aiAssistantApp) {
//         aiAssistantApp = new AI_Assistant_App();
//     }
//     return aiAssistantApp;
// }
//
// app.whenReady().then(() => {
//     const appInstance = createAppInstance();
//     appInstance.start();
//
//     app.on('activate', () => {
//         if (BrowserWindow.getAllWindows().length === 0) {
//             // Re-create a window if none are open (macOS behavior)
//             // Not necessary here as we have GUIManager handling it
//         }
//     });
// });
//
// app.on('window-all-closed', () => {
//     // On non-macOS platforms, quit the app when all windows are closed
//     if (process.platform !== 'darwin') {
//         app.quit();
//     }
// });

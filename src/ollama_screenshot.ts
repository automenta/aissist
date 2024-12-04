import axios from 'axios';
import screenshotDesktop from 'screenshot-desktop';
import sharp from 'sharp';

// Utility function to pause execution for a given number of milliseconds
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface SubRegion {
    x: number;      // Top-left corner X-coordinate
    y: number;      // Top-left corner Y-coordinate
    width: number;  // Width of the region
    height: number; // Height of the region
}

class ScreenshotAnalyzer {
    private readonly visionOllamaUrl: string;
    private readonly visionModel: string;
    private readonly nonVisionOllamaUrl: string;
    private readonly nonVisionModel: string;
    private readonly analysisHistory: string[] = [];
    private readonly reasoningHistory: string[] = [];
    private readonly historyLimit: number;
    private readonly analysisInterval: number; // in milliseconds
    private readonly intentInferenceInterval: number; // number of analyses before inferring intentions
    private readonly subRegion?: SubRegion;

    constructor(
        visionOllamaUrl: string,
        visionModel: string,
        nonVisionOllamaUrl: string,
        nonVisionModel: string,
        historyLimit: number = 20,
        analysisInterval: number = 10000, // 10 seconds
        intentInferenceInterval: number = 5, // Infer intentions every 5 analyses
        subRegion?: SubRegion // Optional sub-region to capture
    ) {
        this.visionOllamaUrl = visionOllamaUrl;
        this.visionModel = visionModel;
        this.nonVisionOllamaUrl = nonVisionOllamaUrl;
        this.nonVisionModel = nonVisionModel;
        this.historyLimit = historyLimit;
        this.analysisInterval = analysisInterval;
        this.intentInferenceInterval = intentInferenceInterval;
        this.subRegion = subRegion;
    }

    /**
     * Captures a screenshot of the entire screen or a specified sub-region.
     * @returns Buffer containing the screenshot image data.
     */
    private async captureScreenshot(): Promise<Buffer> {
        try {
            const screenshotBuffer = await screenshotDesktop({ format: 'png' });

            if (this.subRegion) {
                const { x, y, width, height } = this.subRegion;
                // Use sharp to crop the image to the specified sub-region
                return await sharp(screenshotBuffer)
                    .extract({ left: x, top: y, width, height })
                    .png()
                    //.jpeg()
                    .toBuffer();
            }

            return screenshotBuffer;
        } catch (error) {
            console.error('Failed to capture screenshot:', error);
            throw error;
        }
    }

    /**
     * Sends a screenshot and prompt to the vision model for analysis.
     * @param screenshotBuffer Buffer containing the screenshot image data.
     * @param prompt Prompt to send to the vision model.
     * @returns Analysis result as a string.
     */
    async analyzeScreenshot(screenshotBuffer: Buffer, prompt: string = 'Describe image'): Promise<string> {
        const base64Image = screenshotBuffer.toString('base64');

        try {
            const response = await axios.post(this.visionOllamaUrl, {
                model: this.visionModel,
                messages: [
                    {
                        role: 'user',
                        content: prompt,
                        images: [base64Image]
                    }
                ],
                stream: false
            });

            return response.data.message.content;
        } catch (error) {
            console.error('Failed to analyze screenshot with vision model:', error);
            throw error;
        }
    }

    /**
     * Sends a prompt to the non-vision model to reason about user activity.
     * @param prompt Prompt to send to the non-vision model.
     * @returns Reasoning result as a string.
     */
    async reasonUserActivity(prompt: string): Promise<string> {
        try {
            const response = await axios.post(this.nonVisionOllamaUrl, {
                model: this.nonVisionModel,
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                stream: false
            });

            return response.data.message.content;
        } catch (error) {
            console.error('Failed to reason about user activity with non-vision model:', error);
            throw error;
        }
    }

    /**
     * Infers the user's intentions based on both vision and non-vision analyses.
     * @returns Inferred user intentions as a string.
     */
    async inferUserIntentions(): Promise<string> {
        const visionPrompt = `Based on the following analyses of desktop screenshots, describe the user's current activities or goals:\n\n${this.analysisHistory.map((analysis, index) => `Analysis ${index + 1}: ${analysis}`).join('\n')}\n\nUser Activities and Goals:`;
        const nonVisionPrompt = `Based on the following reasoning about user activity, describe the user's current intentions or objectives:\n\n${this.reasoningHistory.map((reasoning, index) => `Reasoning ${index + 1}: ${reasoning}`).join('\n')}\n\nUser Intentions:`;

        try {
            // Get reasoning from the non-vision model
            const nonVisionResponse = await this.reasonUserActivity(nonVisionPrompt);
            console.log('Non-Vision Reasoning:', nonVisionResponse);

            // Combine vision analysis and non-vision reasoning for final intention inference
            const combinedPrompt = `Based on the following vision analyses and non-vision reasoning, infer the user's current intentions or goals:\n\nVision Analyses:\n${this.analysisHistory.map((analysis, index) => `Analysis ${index + 1}: ${analysis}`).join('\n')}\n\nNon-Vision Reasoning:\n${this.reasoningHistory.map((reasoning, index) => `Reasoning ${index + 1}: ${reasoning}`).join('\n')}\n\nUser Intentions:`;

            const finalIntentions = await this.reasonUserActivity(combinedPrompt);
            return finalIntentions;
        } catch (error) {
            console.error('Failed to infer user intentions:', error);
            throw error;
        }
    }

    /**
     * The main loop that captures and analyzes screenshots periodically.
     */
    async run(): Promise<void> {
        console.log('Starting Screenshot Analyzer...');
        let analysisCount = 0;

        while (true) {
            try {
                const screenshotBuffer = await this.captureScreenshot();

                // Vision-based analysis
                const visionAnalysis = await this.analyzeScreenshot(screenshotBuffer, 'Describe the contents of this desktop screenshot.');
                console.log('Vision Analysis:', visionAnalysis);

                // Add vision analysis to history
                this.analysisHistory.push(visionAnalysis);
                if (this.analysisHistory.length > this.historyLimit) {
                    this.analysisHistory.shift(); // Remove oldest analysis to maintain history size
                }

                // Non-vision reasoning (e.g., based on application logs, user input, etc.)
                // For demonstration, we'll assume it's based solely on vision analysis.
                // In a real-world scenario, you might integrate other data sources.
                const nonVisionReasoningPrompt = `Based on the latest vision analysis, provide reasoning about the user's activity. Vision Analysis: "${visionAnalysis}"`;
                const nonVisionReasoning = await this.reasonUserActivity(nonVisionReasoningPrompt);
                console.log('Non-Vision Reasoning:', nonVisionReasoning);

                // Add non-vision reasoning to history
                this.reasoningHistory.push(nonVisionReasoning);
                if (this.reasoningHistory.length > this.historyLimit) {
                    this.reasoningHistory.shift(); // Remove oldest reasoning to maintain history size
                }

                analysisCount++;

                // Check if it's time to infer user intentions
                if (analysisCount % this.intentInferenceInterval === 0) {
                    console.log('Inferring user intentions based on analysis histories...');
                    const intentions = await this.inferUserIntentions();
                    console.log('Inferred User Intentions:', intentions);
                }
            } catch (error) {
                console.error('Error during screenshot analysis loop:', error);
            }

            // Wait for the specified interval before next iteration
            await delay(this.analysisInterval);
        }
    }
}

async function main() {
    // capture sub-region
    const subRegion: SubRegion = {
        x: 0,      // X-coordinate of the top-left corner
        y: 0,      // Y-coordinate of the top-left corner
        width: 1920,  // Width of the region
        height: 1080  // Height of the region
    };

    const analyzer = new ScreenshotAnalyzer(
        'http://localhost:11434/api/chat', // Vision Ollama URL
        'llava:7b',                         // Vision model
        'http://localhost:11434/api/chat', // Non-Vision Ollama URL (can be different)
        'llava:7b',                    // Non-Vision model
        20,                                 // historyLimit
        10000,                              // analysisInterval (10 seconds)
        5,                                   // intentInferenceInterval (every 5 analyses)
        subRegion                            // Sub-region to capture (optional)
    );

    // Handle graceful shutdown on Ctrl+C
    process.on('SIGINT', () => {
        console.log('\nGracefully shutting down...');
        process.exit();
    });

    await analyzer.run();
}

main();

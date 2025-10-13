const PptxGenJS = require('pptxgenjs');
const fs = require('fs').promises;
const path = require('path');
const OpenAI = require('openai');
const google = require('google-it');
const axios = require('axios');

class PPTService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    /**
     * Generate PowerPoint presentation based on topic
     * @param {string} topic - The topic for the presentation
     * @param {object} options - Additional options for customization
     * @returns {Promise<object>} - Generated PPT file info
     */
    async generatePresentation(topic, options = {}) {
        try {
            console.log(`🎯 Starting PPT generation for topic: ${topic}`);

            // Step 1: Generate presentation structure using AI
            const presentationData = await this.generatePresentationStructure(topic, options);

            // Step 2: Create PowerPoint file
            const pptPath = await this.createPowerPointFile(presentationData, topic);

            console.log(`✅ PPT generation completed: ${pptPath}`);

            return {
                success: true,
                filePath: pptPath,
                fileName: path.basename(pptPath),
                slideCount: presentationData.slides.length,
                topic: topic,
                presentationData: presentationData
            };
        } catch (error) {
            console.error('❌ PPT generation error:', error);
            throw error;
        }
    }

    /**
     * Generate presentation structure using AI
     * @param {string} topic - The topic for the presentation
     * @param {object} options - Additional options
     * @returns {Promise<object>} - Presentation structure
     */
    async generatePresentationStructure(topic, options = {}) {
        const prompt = `Create a comprehensive PowerPoint presentation about "${topic}". 

I need you to generate a detailed presentation structure with the following requirements:

1. Create 12-15 slides minimum
2. Each slide should have:
   - A clear, engaging title
   - 4-6 bullet points with substantial content
   - Relevant and detailed information
3. Cover the topic comprehensively from basics to advanced concepts
4. Make it educational and informative
5. Use professional language suitable for teaching/workshops

Please respond with a JSON object in this exact format:
{
  "title": "Main Presentation Title",
  "subtitle": "Brief description",
  "slides": [
    {
      "title": "Slide Title",
      "content": [
        "First bullet point with detailed information",
        "Second bullet point with detailed information", 
        "Third bullet point with detailed information",
        "Fourth bullet point with detailed information",
        "Fifth bullet point with detailed information"
      ]
    }
  ]
}

Make sure each bullet point is informative and provides real value. The presentation should be comprehensive and educational.`;

        try {
            const completion = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert presentation designer and educator. Generate comprehensive, informative PowerPoint presentations. Always respond with valid JSON only.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 4000
            });

            const responseText = completion.choices[0].message.content.trim();

            // Extract JSON from response (in case there's extra text)
            let jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('No valid JSON found in AI response');
            }

            const presentationData = JSON.parse(jsonMatch[0]);

            // Validate structure
            if (!presentationData.slides || !Array.isArray(presentationData.slides)) {
                throw new Error('Invalid presentation structure from AI');
            }

            console.log(`📝 Generated ${presentationData.slides.length} slides for presentation`);
            return presentationData;

        } catch (error) {
            console.error('AI structure generation error:', error);
            // Fallback to basic structure if AI fails
            return this.createFallbackStructure(topic);
        }
    }

    /**
     * Create fallback presentation structure if AI fails
     * @param {string} topic - The topic
     * @returns {object} - Basic presentation structure
     */
    createFallbackStructure(topic) {
        return {
            title: `${topic} - Complete Guide`,
            subtitle: "Comprehensive overview and key concepts",
            slides: [
                {
                    title: "Introduction",
                    content: [
                        `Welcome to ${topic} overview`,
                        "Learning objectives and goals",
                        "What we'll cover in this presentation",
                        "Prerequisites and requirements",
                        "Expected outcomes"
                    ]
                },
                {
                    title: "Overview",
                    content: [
                        `What is ${topic}?`,
                        "Key concepts and terminology",
                        "Historical background",
                        "Current state and trends",
                        "Why it matters today"
                    ]
                },
                {
                    title: "Key Features",
                    content: [
                        "Main characteristics",
                        "Core functionality",
                        "Unique advantages",
                        "Common use cases",
                        "Best practices"
                    ]
                },
                {
                    title: "Getting Started",
                    content: [
                        "Basic requirements",
                        "Initial setup process",
                        "First steps guide",
                        "Common beginner mistakes",
                        "Quick wins and tips"
                    ]
                },
                {
                    title: "Conclusion",
                    content: [
                        "Key takeaways",
                        "Next steps",
                        "Additional resources",
                        "Questions and discussion",
                        "Thank you"
                    ]
                }
            ]
        };
    }

    /**
     * Create PowerPoint file using pptxgenjs
     * @param {object} presentationData - The presentation structure
     * @param {string} topic - The topic
     * @returns {Promise<string>} - Path to created file
     */
    async createPowerPointFile(presentationData, topic) {
        const ppt = new PptxGenJS();

        // Set presentation properties
        ppt.author = 'AI Assistant';
        ppt.company = 'OpenWebUI';
        ppt.title = presentationData.title || `${topic} Presentation`;
        ppt.subject = topic;

        // Define theme colors and styles
        const colors = {
            primary: '073763', // Dark Blue
            secondary: '1B75BB', // Bright Blue
            accent: 'FFD700',   // Gold/Yellow Accent
            text: '333333',      // Dark Gray for text
            background: 'FFFFFF',
            light: 'F0F4F8'      // Light Gray-Blue
        };

        // Create title slide
        const titleSlide = ppt.addSlide();
        titleSlide.background = { color: colors.background };

        // Add main title
        titleSlide.addText(presentationData.title || `${topic} - Complete Guide`, {
            x: 1,
            y: 2.5,
            w: 8,
            h: 1.5,
            fontSize: 44,
            bold: true,
            color: colors.primary,
            align: 'center',
            fontFace: 'Calibri'
        });

        // Add subtitle
        titleSlide.addText(presentationData.subtitle || 'Comprehensive overview and practical insights', {
            x: 1,
            y: 4.2,
            w: 8,
            h: 0.8,
            fontSize: 24,
            color: colors.text,
            align: 'center',
            fontFace: 'Calibri'
        });

        // Add decorative elements
        titleSlide.addShape('rect', {
            x: 0,
            y: 6.8,
            w: 10,
            h: 0.2,
            fill: { color: colors.primary }
        });

        // Add footer
        titleSlide.addText('Generated by AI Assistant', {
            x: 1,
            y: 6.8,
            w: 8,
            h: 0.5,
            fontSize: 14,
            color: colors.secondary,
            align: 'center',
            fontFace: 'Calibri'
        });

        // Create content slides
        for (const [index, slideData] of presentationData.slides.entries()) {
            const slide = ppt.addSlide();
            slide.background = { color: colors.background };

            // Add slide number and title background
            slide.addShape('rect', {
                x: 0,
                y: 0,
                w: 10,
                h: 1.2,
                fill: { color: colors.primary }
            });

            // Add slide title
            slide.addText(slideData.title, {
                x: 0.5,
                y: 0.1,
                w: 8.5,
                h: 1,
                fontSize: 32,
                bold: true,
                color: colors.background,
                align: 'left',
                valign: 'middle',
                fontFace: 'Calibri'
            });

            // Add slide number
            slide.addText(`${index + 1}`, {
                x: 9,
                y: 0.1,
                w: 0.8,
                h: 1,
                fontSize: 20,
                bold: true,
                color: colors.background,
                align: 'center',
                valign: 'middle',
                fontFace: 'Calibri'
            });

            // Add bullet points
            const bulletPoints = slideData.content.slice(0, 4); // Limit to 4 points for better spacing
            slide.addText(bulletPoints.join('\n\n'), {
                x: 0.5,
                y: 1.5,
                w: 5.3,
                h: 5.5,
                fontSize: 14, // Reduced font size for better fit
                color: colors.text,
                align: 'left',
                valign: 'top',
                fontFace: 'Calibri',
                lineSpacing: 22, // Adjusted line spacing
                bullet: { type: 'dot', indent: 18 }
            });

            // Add image placeholder
            // slide.addShape('rect', {
            //     x: 6.2,
            //     y: 1.8,
            //     w: 3.5,
            //     h: 3.5,
            //     fill: { color: colors.light },
            //     line: { color: colors.secondary, width: 1 }
            // });
            // slide.addText('Image', {
            //     x: 6.2,
            //     y: 1.8,
            //     w: 3.5,
            //     h: 3.5,
            //     align: 'center',
            //     valign: 'middle',
            //     color: colors.secondary,
            //     fontSize: 16
            // });

            // Add image
            // try {
            //     const image = await this.getImageForSlide(`${slideData.title} ${topic}`);
            //     if (image) {
            //         slide.addImage({
            //             data: image,
            //             x: 6.2,
            //             y: 1.8,
            //             w: 3.5,
            //             h: 3.5,
            //             sizing: { type: 'cover', w: 3.5, h: 3.5 }
            //         });
            //     }
            // } catch (error) {
            //     console.error(`Error adding image to slide ${index + 1}:`, error);
            // }

            // Add decorative footer line
            slide.addShape('rect', {
                x: 0,
                y: 7.2,
                w: 10,
                h: 0.3,
                fill: { color: colors.primary }
            });
        }

        // Save file
        const uploadsDir = path.join(__dirname, '../../uploads/presentations');
        await fs.mkdir(uploadsDir, { recursive: true });

        const titleCompletion = await this.openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are a title generation expert. Based on the user\'s prompt, create a concise, relevant, and file-friendly title for a PowerPoint presentation. Respond with the title only, without any other text or explanation.'
                },
                { role: 'user', content: topic }
            ],
            temperature: 0.7,
        });

        const sanitizedTopic = titleCompletion.choices[0].message.content.trim().replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const timestamp = Date.now();
        const fileName = `${sanitizedTopic}_${timestamp}.pptx`;
        const filePath = path.join(uploadsDir, fileName);

        return new Promise((resolve, reject) => {
            ppt.writeFile(filePath)
                .then(() => {
                    console.log(`📄 PowerPoint saved to: ${filePath}`);
                    resolve(filePath);
                })
                .catch((error) => {
                    console.error('Error saving PowerPoint:', error);
                    reject(error);
                });
        });
    }

    /**
     * Get file download URL
     * @param {string} fileName - The file name
     * @returns {string} - Download URL
     */
    getDownloadUrl(fileName) {
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
        return `${baseUrl}/uploads/presentations/${fileName}`;
    }

    /**
     * Clean up old presentation files (older than 24 hours)
     */
    async getImageForSlide(query) {
        try {
            const options = {
                query: `${query} free stock photo`,
                'safe': 'on',
                'tbm': 'isch', // Search images
                'tbs': 'isz:m,itp:photo,ic:color,ift:jpg', // Medium size, photo type, color, jpg
                'no-display': '1'
            };

            const results = await google(options);
            const imageUrl = results[0]?.link;

            if (imageUrl) {
                const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                return `data:${response.headers['content-type']};base64,${Buffer.from(response.data).toString('base64')}`;
            }
        } catch (error) {
            console.error(`Failed to fetch image for query "${query}":`, error);
        }
        return null;
    }

    async cleanupOldFiles() {
        try {
            const uploadsDir = path.join(__dirname, '../../uploads/presentations');
            const files = await fs.readdir(uploadsDir);
            const now = Date.now();
            const oneDayAgo = now - (24 * 60 * 60 * 1000);

            for (const file of files) {
                if (file.endsWith('.pptx')) {
                    const filePath = path.join(uploadsDir, file);
                    const stats = await fs.stat(filePath);
                    if (stats.mtime.getTime() < oneDayAgo) {
                        await fs.unlink(filePath);
                        console.log(`🧹 Cleaned up old presentation: ${file}`);
                    }
                }
            }
        } catch (error) {
            console.warn('Presentation cleanup failed:', error.message);
        }
    }
}

module.exports = new PPTService();

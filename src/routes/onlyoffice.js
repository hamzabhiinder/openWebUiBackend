const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const aiService = require('../services/ai-service');
const router = express.Router();

// OnlyOffice configuration
const ONLYOFFICE_SECRET_KEY = process.env.ONLYOFFICE_SECRET_KEY || "mysecret";
const ONLYOFFICE_SERVER_URL = process.env.ONLYOFFICE_SERVER_URL || "http://localhost:8080";
const BACKEND_URL = process.env.BACKEND_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

// Get server IP (for local network access)
function getServerIP() {
    // Try to get from environment first
    if (process.env.SERVER_IP) {
        return process.env.SERVER_IP;
    }

    // Default to localhost for development
    return "localhost";
}

// API jo frontend ko Config + Token bana kar degi
router.get('/get-config', (req, res) => {
    try {
        const { fileUrl, fileName, fileType } = req.query;

        if (!fileUrl) {
            return res.status(400).json({ error: 'fileUrl is required' });
        }

        // Extract file extension from fileName or fileUrl
        let docType = 'word'; // default
        let docFileType = 'docx'; // default

        if (fileName) {
            const ext = fileName.toLowerCase().split('.').pop();
            if (ext === 'docx' || ext === 'doc') {
                docType = 'word';
                docFileType = ext === 'doc' ? 'doc' : 'docx';
            } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
                docType = 'cell';
                if (ext === 'csv') {
                    docFileType = 'csv';
                } else {
                    docFileType = ext === 'xls' ? 'xls' : 'xlsx';
                }
            } else if (ext === 'pptx' || ext === 'ppt') {
                docType = 'slide';
                docFileType = ext === 'ppt' ? 'ppt' : 'pptx';
            } else if (ext === 'pdf') {
                // PDF can be viewed but editing is limited
                docType = 'word';
                docFileType = 'pdf';
            }
        } else if (fileType) {
            // Use fileType if provided
            if (fileType.includes('word') || fileType.includes('document')) {
                docType = 'word';
            } else if (fileType.includes('spreadsheet') || fileType.includes('excel') || fileType.includes('csv')) {
                docType = 'cell';
            } else if (fileType.includes('presentation') || fileType.includes('powerpoint')) {
                docType = 'slide';
            }
        }

        const serverIP = getServerIP();
        const baseUrl = BACKEND_URL.replace('localhost', serverIP).replace('127.0.0.1', serverIP);

        // 1. Config Object banayein
        const config = {
            "document": {
                "fileType": docFileType,
                "key": fileName.replace(/[^a-zA-Z0-9]/g, ""),
                //"key": "key-" + Date.now() + "-" + Math.random().toString(36).substring(7), // Unique Key har session ke liye
                "title": fileName || "document." + docFileType,
                "url": fileUrl // File ka URL (already full URL from frontend)
                // "url": "https://api.siragpt.com/uploads/documents/cmejn8zhq0000jmlbhqvsfsm8/Salahuddin_Ayyubi_Biography.docx"

            },
            "documentType": docType,
            "editorConfig": {
                "mode": "edit",
                "callbackUrl": `${baseUrl}/api/onlyoffice/track`, // Save handler
                "user": {
                    "id": req.user?.id || "uid-1",
                    "name": req.user?.name || req.user?.email || "User"
                },
                "customization": {
                    "autosave": true,
                    "forcesave": true,
                    "spellcheck": false,
                    "macros": true,
                },
                "plugins": {
                    "autostart": [
                        "asc.{0616AE85-5DBE-4B6B-A0A9-455C4F1503AE}"
                    ]
                }

            }
        };

        // 2. Is Config ka Token generate karein
        const token = jwt.sign(config, ONLYOFFICE_SECRET_KEY);

        // 3. Config ke andar Token add karein
        config.token = token;

        // 4. Frontend ko bhejein
        res.json(config);
    } catch (error) {
        console.error('Error generating OnlyOffice config:', error);
        res.status(500).json({ error: 'Failed to generate OnlyOffice config' });
    }
});

// // Yeh code warning hatayega aur file save karega
// router.post('/track', async (req, res) => {
//     try {
//         const { status, url, key } = req.body;

//         console.log('OnlyOffice track callback:', { status, url, key });

//         // Status 2 ka matlab hai: "User ne file save ki hai, ready to update"
//         // Status 6 ka matlab hai: "Force Save"
//         if (status === 2 || status === 6) {
//             console.log("File save ho rahi hai...");
//             const targetFileName = req.query.filename; 
//             if (!targetFileName) {
//                 console.error("Filename not provided in callback query");
//                 return res.json({ "error": 0 });
//             }

//             try {
//                 // OnlyOffice se nayi file download karein
//                 const response = await axios({
//                     method: 'get',
//                     url: url,
//                     responseType: 'stream',
//                     timeout: 30000 // 30 seconds timeout
//                 });

//                 // Extract original file URL from the callback URL
//                 // OnlyOffice provides a temporary URL, we need to map it back to original
//                 // For now, we'll extract the path from the original request if available
//                 const uploadsDir = path.join(__dirname, '../../uploads');



//                 // Create uploads directory if it doesn't exist
//                 if (!fs.existsSync(uploadsDir)) {
//                     fs.mkdirSync(uploadsDir, { recursive: true });
//                 }

//                 // Try to extract filename from the original file URL stored in key
//                 // In a production system, you'd store a mapping of key -> original file path
//                 // For now, we'll save with a timestamp
//                 const timestamp = Date.now();
//                 const urlPath = new URL(url).pathname;
//                 let fileName = path.basename(urlPath);

//                 // If we can't get filename from URL, use key-based naming
//                 if (!fileName || fileName === '') {
//                     fileName = `document-${key}-${timestamp}.docx`;
//                 } else {
//                     // Preserve original extension but add timestamp to avoid overwrites
//                     const ext = path.extname(fileName);
//                     const nameWithoutExt = path.basename(fileName, ext);
//                     fileName = `${nameWithoutExt}-${timestamp}${ext}`;
//                 }

//                 // Save to uploads directory
//                 const filePath = path.join(uploadsDir, fileName);
//                 const writer = fs.createWriteStream(filePath);

//                 response.data.pipe(writer);

//                 writer.on('finish', () => {
//                     console.log(`SUCCESS: File saved to ${filePath}`);
//                     // TODO: Here you could:
//                     // 1. Update the database with the new file
//                     // 2. Map the key back to original file and replace it
//                     // 3. Trigger a webhook or notification
//                     // 4. Update file metadata in database
//                 });

//                 writer.on('error', (err) => {
//                     console.error("Write Error:", err);
//                 });

//             } catch (error) {
//                 console.error("Download Error:", error.message);
//                 // Don't fail the request, just log the error
//             }
//         }

//         // OnlyOffice ko response dena ZAROORI hai, warna wo warning dikhata rahega
//         res.json({ "error": 0 });
//     } catch (error) {
//         console.error('Error in OnlyOffice track callback:', error);
//         // Always return success to OnlyOffice
//         res.json({ "error": 0 });
//     }
// });

router.post('/track', async (req, res) => {
    try {
        const { status, url } = req.body; // status 2 matlab save ready, status 6 matlab force save
        const targetFileName = req.query.filename; // Humne callback URL se filename pakra

        console.log('OnlyOffice Status:', status, 'File:', targetFileName);

        if ((status === 2 || status === 6) && url) {
            console.log("Saving changes to original file...");

            try {
                // 1. OnlyOffice ke server se nayi edited file download karein
                const response = await axios({
                    method: 'get',
                    url: url,
                    responseType: 'stream'
                });

                // 2. Original file ka path set karein
                // Yaad rahe: Aapki file agar 'uploads/documents' mein hai to wahi path dein
                const filePath = path.join(__dirname, '../../uploads/documents', targetFileName);

                // Check karein ke folder majood hai
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                // 3. Purani file par Nayi file OVERWRITE (replace) karein
                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);

                writer.on('finish', () => {
                    console.log(`✅ SUCCESS: File updated and overwritten at: ${filePath}`);
                });

                writer.on('error', (err) => {
                    console.error("Write Error:", err);
                });

            } catch (error) {
                console.error("Download Error:", error.message);
            }
        }

        // OnlyOffice ko "no error" response bhejna zaroori hai
        res.json({ "error": 0 });
    } catch (error) {
        console.error('Track error:', error);
        res.json({ "error": 0 });
    }
});

// Endpoint for editing document text using AI
router.post(
    '/edit-text',
    [
        body('selectedText').optional().isString(),
        body('editRequest').trim().notEmpty().withMessage('Edit request is required'),
        body('provider').optional().isString(),
        body('model').optional().isString(),
    ],
    authenticateToken,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { selectedText, editRequest, provider = 'OpenAI', model = 'gpt-4o' } = req.body;
            const userId = req.user.id;

            // Handle case when no specific text is selected (document context mode)
            const isDocumentContextMode = selectedText === '[DOCUMENT_CONTEXT]' || !selectedText || selectedText.trim().length === 0;

            console.log('📝 Document text edit request:', {
                userId,
                selectedTextLength: isDocumentContextMode ? 0 : selectedText.length,
                editRequest,
                model,
                mode: isDocumentContextMode ? 'DOCUMENT_CONTEXT' : 'SELECTED_TEXT'
            });


            // Build prompt based on mode
            const textContext = isDocumentContextMode
                ? "The user is working with a document and wants to edit it based on their request. No specific text was selected, so provide the text that should be added or modified."
                : `SELECTED TEXT TO MODIFY:\n"${selectedText}"`;

            const prompt = isDocumentContextMode
                ? `You are editing a Word document based on the user's request. ${textContext}

USER'S REQUEST: ${editRequest}

UNDERSTANDING USER INTENT:
Carefully analyze the user's request to understand their intent and what they want. Adapt your response intelligently based on the context and purpose. Understand the user's needs deeply and provide appropriate, high-quality content that matches their request.

CRITICAL INSTRUCTIONS:
1. Return ONLY the text that should be added or modified
2. Do NOT recreate the entire document
3. Do NOT include explanations, instructions, or context
4. Do NOT use markdown formatting (no **bold**, no code blocks, no quotes)
5. Do NOT add prefixes like "Here's the updated text:" or "Modified version:"
6. Return ONLY the text content

MATH EQUATIONS AND FORMULAS:
- For math equations, use proper LaTeX format that Word/OnlyOffice can render
- Inline equations: Use $...$ format, e.g., $E = mc^2$ or $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$
- Display equations: Use $$...$$ format for centered equations, e.g., $$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$
- Common symbols: Use LaTeX notation: \\alpha, \\beta, \\gamma, \\pi, \\theta, \\sum, \\int, \\frac{a}{b}, \\sqrt{x}, etc.
- Examples:
  * Quadratic formula: $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$
  * Einstein's equation: $E = mc^2$
  * Integral: $$\\int_{a}^{b} f(x) dx$$
  * Summation: $\\sum_{i=1}^{n} x_i$
  * Fractions: $\\frac{a}{b}$, $\\frac{numerator}{denominator}$
  * Square root: $\\sqrt{x}$, $\\sqrt[n]{x}$
  * Greek letters: $\\alpha, \\beta, \\gamma, \\pi, \\theta, \\Delta, \\Omega$
  * Subscripts/Superscripts: $x_1, y^2, a_i^j$
  * Matrix: $\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$
- IMPORTANT: Always use double backslashes (\\\\) for LaTeX commands in the response
- Word/OnlyOffice will automatically convert LaTeX to proper math equations

Return ONLY the text, nothing else.`
                : `You are editing a specific selected portion of text from a Word document. The user has selected text and wants you to modify it based on their request.

${textContext}

USER'S REQUEST: ${editRequest}

UNDERSTANDING USER INTENT:
Carefully analyze the user's request to understand their intent and what they want. Adapt your response intelligently based on the context and purpose of the text. Understand the user's needs deeply and provide appropriate, high-quality content that matches their request.

CRITICAL INSTRUCTIONS FOR ALL REQUESTS:
1. Return ONLY the modified/replacement text that should replace the selected text
2. Do NOT recreate the entire document - only modify the selected portion 
3. Do NOT use markdown formatting (no **bold**, no code blocks, no quotes)
4. Do NOT add prefixes like "Here's the updated text:" or "Modified version:"
5. Return ONLY the text that should replace the selected text above
6. Understand user's intent deeply and provide appropriate, high-quality content

MATH EQUATIONS AND FORMULAS:
- For math equations, use proper LaTeX format that Word/OnlyOffice can render
- Inline equations: Use $...$ format, e.g., $E = mc^2$ or $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$
- Display equations: Use $$...$$ format for centered equations, e.g., $$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$
- Common symbols: Use LaTeX notation with double backslashes: \\\\alpha, \\\\beta, \\\\gamma, \\\\pi, \\\\theta, \\\\sum, \\\\int, \\\\frac{a}{b}, \\\\sqrt{x}, etc.
- Examples:
  * Quadratic formula: $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$
  * Einstein's equation: $E = mc^2$
  * Integral: $$\\int_{a}^{b} f(x) dx$$
  * Summation: $\\sum_{i=1}^{n} x_i = x_1 + x_2 + ... + x_n$
  * Fractions: $\\frac{a}{b}$, $\\frac{numerator}{denominator}$, $\\frac{d}{dx}f(x)$
  * Square root: $\\sqrt{x}$, $\\sqrt[n]{x}$, $\\sqrt{a^2 + b^2}$
  * Greek letters: $\\alpha, \\beta, \\gamma, \\pi, \\theta, \\Delta, \\Omega, \\lambda, \\mu, \\sigma$
  * Subscripts/Superscripts: $x_1, y^2, a_i^j, H_2O, CO_2$
  * Matrix: $\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$
  * Derivatives: $\\frac{d}{dx}f(x)$, $\\frac{\\partial f}{\\partial x}$
  * Limits: $\\lim_{x \\to \\infty} f(x)$
- IMPORTANT: Always use double backslashes (\\\\) for LaTeX commands so Word/OnlyOffice can properly render them
- Word/OnlyOffice will automatically convert LaTeX notation to proper math equations
- If user asks for math equations, formulas, or mathematical expressions, always format them using LaTeX

IMPORTANT: Understand the user's intent deeply and provide appropriate, high-quality content. Adapt intelligently to their needs - if they want expansion, expand significantly; if they want summarization, make it concise; if they want math equations, use proper LaTeX format; if they want translation, translate accurately. Always maintain the context and purpose of the text.

Return ONLY the replacement text, nothing else.`;

            // Use AI service to generate updated text
            const messages = [
                {
                    role: 'user',
                    content: prompt
                }
            ];

            // Generate response using OpenAI directly (non-streaming)
            let updatedText = '';
            try {
                const OpenAI = require('openai');

                // Get API key based on provider
                let apiKey = process.env.OPENAI_API_KEY;
                let baseURL = undefined;

                if (provider === 'Gemini') {
                    apiKey = process.env.GEMINI_API_KEY;
                    baseURL = "https://generativelanguage.googleapis.com/v1beta/openai/";
                } else if (provider === 'OpenRouter'  ) {
                    apiKey = process.env.OPENROUTER_API_KEY;
                    baseURL = "https://openrouter.ai/api/v1";
                }

                const openai = new OpenAI({
                    apiKey: apiKey,
                    baseURL: baseURL
                });

                // Map model name if needed
                let modelName = model;
                if (provider === 'Gemini') {
                    // Map common model names to Gemini models
                    if (model.includes('gemini')) {
                        modelName = model;
                    } else {
                        modelName = 'gemini-2.0-flash-exp'; // Default Gemini model
                    }
                } else if (provider === 'OpenRouter') {
                    modelName = model;
                }
                const completion = await openai.chat.completions.create({
                    model: modelName,
                    messages: messages,
                    stream: false // Non-streaming for this use case
                });

                updatedText = completion.choices[0]?.message?.content || '';

                if (!updatedText) {
                    throw new Error('No response from AI');
                }

            } catch (aiError) {
                console.error('AI generation error:', aiError);
                return res.status(500).json({
                    error: 'Failed to generate updated text',
                    details: aiError.message
                });
            }

            // Clean up the response text
            let cleanedText = updatedText.trim();

            // IMPORTANT: Preserve LaTeX math equations before cleanup
            // Store LaTeX equations temporarily
            const latexPlaceholders = {};
            let placeholderIndex = 0;

            // Match and store LaTeX inline equations: $...$
            cleanedText = cleanedText.replace(/\$([^$]+)\$/g, (match) => {
                const placeholder = `__LATEX_INLINE_${placeholderIndex}__`;
                latexPlaceholders[placeholder] = match;
                placeholderIndex++;
                return placeholder;
            });

            // Match and store LaTeX display equations: $$...$$
            cleanedText = cleanedText.replace(/\$\$([^$]+)\$\$/g, (match) => {
                const placeholder = `__LATEX_DISPLAY_${placeholderIndex}__`;
                latexPlaceholders[placeholder] = match;
                placeholderIndex++;
                return placeholder;
            });

            // Remove markdown code blocks (but preserve LaTeX placeholders)
            cleanedText = cleanedText.replace(/```[\s\S]*?```/g, '');

            // Remove markdown formatting (but preserve LaTeX placeholders)
            cleanedText = cleanedText
                .replace(/\*\*([^*]+)\*\*/g, '$1')
                .replace(/\*([^*]+)\*/g, '$1')
                .replace(/`([^`]+)`/g, '$1')
                .trim();

            // Remove quotes if entire response is quoted (but preserve LaTeX placeholders)
            if ((cleanedText.startsWith('"') && cleanedText.endsWith('"')) ||
                (cleanedText.startsWith("'") && cleanedText.endsWith("'"))) {
                cleanedText = cleanedText.slice(1, -1).trim();
            }

            // Remove common prefixes
            cleanedText = cleanedText.replace(/^(?:here'?s?\s+(?:the\s+)?(?:updated|revised|changed|edited|modified)\s+text[:\s]*|(?:updated|revised|changed|edited|modified)\s+text[:\s]*)/i, '').trim();

            // Restore LaTeX equations
            Object.keys(latexPlaceholders).forEach(placeholder => {
                cleanedText = cleanedText.replace(placeholder, latexPlaceholders[placeholder]);
            });

            // No static keyword checks - let AI handle everything intelligently
            // Only truncate if response is unreasonably long (more than 10x original)
            // This prevents errors but allows AI to generate appropriate content length
            if (!isDocumentContextMode && cleanedText.length > selectedText.length * 10) {
                // Only truncate if it's clearly too long (likely an error)
                const firstSentence = cleanedText.match(/^[^.!?]+[.!?]/);
                if (firstSentence) {
                    cleanedText = firstSentence[0].trim();
                } else {
                    cleanedText = cleanedText.split('\n\n')[0] || cleanedText.split('\n')[0] || cleanedText;
                    cleanedText = cleanedText.trim();
                }
            }
            // Otherwise, trust AI to generate appropriate content length

            console.log('✅ Document text edit completed:', {
                originalLength: selectedText.length,
                updatedLength: cleanedText.length
            });

            res.json({
                success: true,
                updatedText: cleanedText,
                originalText: selectedText
            });

        } catch (error) {
            console.error('Error in document text edit:', error);
            res.status(500).json({
                error: 'Failed to edit document text',
                details: error.message
            });
        }
    }
);

module.exports = router;


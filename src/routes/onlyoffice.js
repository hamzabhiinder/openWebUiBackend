const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
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
            } else if (ext === 'xlsx' || ext === 'xls') {
                docType = 'cell';
                docFileType = ext === 'xls' ? 'xls' : 'xlsx';
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
            } else if (fileType.includes('spreadsheet') || fileType.includes('excel')) {
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
                "key": "key-" + Date.now() + "-" + Math.random().toString(36).substring(7), // Unique Key har session ke liye
                "title": fileName || "document." + docFileType,
                "url": fileUrl // File ka URL (already full URL from frontend)
                //"url": "https://api.siragpt.com/uploads/documents/cmejn8zhq0000jmlbhqvsfsm8/Salahuddin_Ayyubi_Biography.docx"

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
                    "forcesave": true
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

// Yeh code warning hatayega aur file save karega
router.post('/track', async (req, res) => {
    try {
        const { status, url, key } = req.body;

        console.log('OnlyOffice track callback:', { status, url, key });

        // Status 2 ka matlab hai: "User ne file save ki hai, ready to update"
        // Status 6 ka matlab hai: "Force Save"
        if (status === 2 || status === 6) {
            console.log("File save ho rahi hai...");

            if (!url) {
                console.error("No URL provided in callback");
                return res.json({ "error": 0 }); // Still return success to OnlyOffice
            }

            try {
                // OnlyOffice se nayi file download karein
                const response = await axios({
                    method: 'get',
                    url: url,
                    responseType: 'stream',
                    timeout: 30000 // 30 seconds timeout
                });

                // Extract original file URL from the callback URL
                // OnlyOffice provides a temporary URL, we need to map it back to original
                // For now, we'll extract the path from the original request if available
                const uploadsDir = path.join(__dirname, '../../uploads');

                // Create uploads directory if it doesn't exist
                if (!fs.existsSync(uploadsDir)) {
                    fs.mkdirSync(uploadsDir, { recursive: true });
                }

                // Try to extract filename from the original file URL stored in key
                // In a production system, you'd store a mapping of key -> original file path
                // For now, we'll save with a timestamp
                const timestamp = Date.now();
                const urlPath = new URL(url).pathname;
                let fileName = path.basename(urlPath);

                // If we can't get filename from URL, use key-based naming
                if (!fileName || fileName === '') {
                    fileName = `document-${key}-${timestamp}.docx`;
                } else {
                    // Preserve original extension but add timestamp to avoid overwrites
                    const ext = path.extname(fileName);
                    const nameWithoutExt = path.basename(fileName, ext);
                    fileName = `${nameWithoutExt}-${timestamp}${ext}`;
                }

                // Save to uploads directory
                const filePath = path.join(uploadsDir, fileName);
                const writer = fs.createWriteStream(filePath);

                response.data.pipe(writer);

                writer.on('finish', () => {
                    console.log(`SUCCESS: File saved to ${filePath}`);
                    // TODO: Here you could:
                    // 1. Update the database with the new file
                    // 2. Map the key back to original file and replace it
                    // 3. Trigger a webhook or notification
                    // 4. Update file metadata in database
                });

                writer.on('error', (err) => {
                    console.error("Write Error:", err);
                });

            } catch (error) {
                console.error("Download Error:", error.message);
                // Don't fail the request, just log the error
            }
        }

        // OnlyOffice ko response dena ZAROORI hai, warna wo warning dikhata rahega
        res.json({ "error": 0 });
    } catch (error) {
        console.error('Error in OnlyOffice track callback:', error);
        // Always return success to OnlyOffice
        res.json({ "error": 0 });
    }
});

module.exports = router;


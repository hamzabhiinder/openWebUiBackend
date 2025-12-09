const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const upload = require('../middleware/upload');
const fileProcessor = require('../services/fileProcessor');
const prisma = require('../config/database');
const fs = require('fs').promises;
const path = require('path');
const OpenAI = require('openai');

const router = express.Router();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Upload files
router.post('/upload', authenticateToken, upload.array('files', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const processedFiles = [];

    for (const file of req.files) {
      try {
        // Process file content
        const result = await fileProcessor.processFile(file);

        // Generate thumbnail for images
        const thumbnailPath = await fileProcessor.generateThumbnail(file.path, file.mimetype);

        // Upload to OpenAI Files API if it's a supported file type
        let openaiFileId = null;
        if (file.mimetype === 'application/pdf' ||
          file.mimetype.startsWith('text/') ||
          file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          file.mimetype === 'application/vnd.ms-powerpoint' ||
          file.mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
          try {
            const fileStream = await fs.readFile(file.path);
            const openaiFile = await openai.files.create({
              file: new File([fileStream], file.originalname, { type: file.mimetype }),
              purpose: 'assistants'
            });
            openaiFileId = openaiFile.id;
          } catch (openaiError) {
            console.error('OpenAI file upload error:', openaiError);
          }
        }

        // Save file record to database
        const fileRecord = await prisma.file.create({
          data: {
            userId: req.user.id,
            filename: file.filename,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
            path: file.path,
            extractedText: result.extractedText,
            openaiFileId: openaiFileId
          }
        });

        processedFiles.push({
          id: fileRecord.id,
          name: file.originalname,
          size: file.size,
          type: file.mimetype,
          url: `/uploads/${req.user.id}/${file.filename}`,
          thumbnailUrl: thumbnailPath ? `/uploads/${req.user.id}/${path.basename(thumbnailPath)}` : null,
          extractedText: result.extractedText,
          openaiFileId: openaiFileId,
          success: result.success,
          error: result.error
        });
      } catch (error) {
        console.error('File processing error:', error);
        processedFiles.push({
          name: file.originalname,
          size: file.size,
          type: file.mimetype,
          success: false,
          error: error.message
        });
      }
    }

    res.json({
      message: 'Files processed successfully',
      files: processedFiles
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'File upload failed' });
  }
});

// Get user files
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    const skip = (page - 1) * limit;

    const where = {
      userId: req.user.id,
      ...(type && { mimeType: { startsWith: type } })
    };

    const [files, total] = await Promise.all([
      prisma.file.findMany({
        where,
        select: {
          id: true,
          filename: true,
          originalName: true,
          mimeType: true,
          size: true,
          createdAt: true
        },
        skip: parseInt(skip),
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
      }),
      prisma.file.count({ where })
    ]);

    const filesWithUrls = files.map(file => ({
      ...file,
      url: `/uploads/${req.user.id}/${file.filename}`
    }));

    res.json({
      files: filesWithUrls,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get files error:', error);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

// Get file details
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({
      ...file,
      url: `/uploads/${req.user.id}/${file.filename}`
    });
  } catch (error) {
    console.error('Get file error:', error);
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

// Get file content
router.get('/:id/content', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // For now, we'll just send back the extracted text.
    // In the future, you might want to read the file from file.path
    // if the content is not stored in the database.
    res.send(file.extractedText || 'No content available.');

  } catch (error) {
    console.error('Get file content error:', error);
    res.status(500).json({ error: 'Failed to fetch file content' });
  }
});

// Delete file
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const file = await prisma.file.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Delete file from filesystem
    try {
      await fs.unlink(file.path);
      // Also try to delete thumbnail if it exists
      const thumbnailPath = file.path + '_thumb.jpg';
      try {
        await fs.unlink(thumbnailPath);
      } catch (e) {
        // Ignore thumbnail deletion errors
      }
    } catch (error) {
      console.error('File deletion error:', error);
    }

    // Delete from database
    await prisma.file.delete({
      where: { id: req.params.id }
    });

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Convert SFDT to DOCX
router.post('/convert-sfdt', authenticateToken, async (req, res) => {
  try {
    const { sfdtData, fileName } = req.body;

    if (!sfdtData) {
      return res.status(400).json({ error: 'SFDT data is required' });
    }

    // Use Syncfusion DocumentEditor service to convert SFDT to DOCX
    const syncfusionServiceUrl = 'https://ej2services.syncfusion.com/production/web-services/api/documenteditor/';
    
    const axios = require('axios');
    const response = await axios.post(
      `${syncfusionServiceUrl}Export`,
      {
        content: sfdtData,
        format: 'Docx'
      },
      {
        responseType: 'arraybuffer',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    // Set response headers for file download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName || 'document.docx'}"`);
    res.send(Buffer.from(response.data));

  } catch (error) {
    console.error('SFDT conversion error:', error);
    res.status(500).json({ error: 'Failed to convert SFDT to DOCX' });
  }
});

// Save document to original path
router.post('/save-document', authenticateToken, async (req, res) => {
  try {
    const { sfdtData, fileName, filePath, originalUrl } = req.body;
    const userId = req.user.id;

    if (!sfdtData) {
      return res.status(400).json({ error: 'SFDT data is required' });
    }

    // Extract filename from URL or use provided fileName
    let targetFilename = fileName;
    let targetPath = null;

    // Try to find existing file from URL
    if (originalUrl) {
      // URL format: /uploads/{userId}/{filename} or http://.../uploads/{userId}/{filename}
      const urlMatch = originalUrl.match(/uploads\/([^\/]+)\/([^\/\?]+)/);
      if (urlMatch) {
        const urlUserId = urlMatch[1];
        const urlFilename = urlMatch[2];
        
        // Verify it's the same user
        if (urlUserId === userId) {
          // Find file in database
          const existingFile = await prisma.file.findFirst({
            where: {
              filename: urlFilename,
              userId: userId
            }
          });

          if (existingFile) {
            targetPath = existingFile.path;
            targetFilename = existingFile.filename;
          } else {
            // File not in DB, construct path from URL
            targetPath = path.join(__dirname, '../../uploads', userId, urlFilename);
            targetFilename = urlFilename;
          }
        }
      }
    }

    // If no path found, use filePath parameter
    if (!targetPath && filePath) {
      targetPath = path.join(__dirname, '../../uploads', filePath);
    }

    // If still no path, create new file
    if (!targetPath) {
      const uploadsDir = path.join(__dirname, '../../uploads', userId);
      await fs.mkdir(uploadsDir, { recursive: true });
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      targetFilename = targetFilename || `document-${uniqueSuffix}.docx`;
      targetPath = path.join(uploadsDir, targetFilename);
    }

    // Ensure directory exists
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Convert SFDT to DOCX using Syncfusion service
    const syncfusionServiceUrl = 'https://ej2services.syncfusion.com/production/web-services/api/documenteditor/';
    const axios = require('axios');
    
    const response = await axios.post(
      `${syncfusionServiceUrl}Export`,
      {
        content: sfdtData,
        format: 'Docx'
      },
      {
        responseType: 'arraybuffer',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    // Save file to path
    await fs.writeFile(targetPath, Buffer.from(response.data));

    // Update or create file record in database
    const fileSize = response.data.length;
    const existingFile = await prisma.file.findFirst({
      where: { 
        filename: targetFilename, 
        userId: userId 
      }
    });

    let fileRecord;
    if (existingFile) {
      // Update existing file
      fileRecord = await prisma.file.update({
        where: { id: existingFile.id },
        data: {
          size: fileSize,
          path: targetPath,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }
      });
    } else {
      // Create new file record
      fileRecord = await prisma.file.create({
        data: {
          userId: userId,
          filename: targetFilename,
          originalName: targetFilename,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: fileSize,
          path: targetPath
        }
      });
    }

    res.json({
      message: `Document saved successfully: ${targetFilename}`,
      file: {
        id: fileRecord.id,
        filename: targetFilename,
        url: `/uploads/${userId}/${targetFilename}`
      }
    });

  } catch (error) {
    console.error('Save document error:', error);
    res.status(500).json({ error: 'Failed to save document: ' + (error.message || 'Unknown error') });
  }
});

module.exports = router;

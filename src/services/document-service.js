const fs = require('fs').promises;
const path = require('path');
const mime = require('mime-types');
const { exec } = require('child_process');
const { Document, Packer, Paragraph, HeadingLevel } = require('docx');
const puppeteer = require('puppeteer');
const PizZip = require('pizzip');
const axios = require('axios');
const XLSX = require('xlsx');

// Extract table data from markdown content
function extractTableData(content) {
    const lines = content.split('\n').filter(line => line.trim());
    
    // First priority: Look for markdown tables
    const tableMatches = content.match(/\|(.+)\|\s*\n\|[-\s|:]+\|\s*\n((?:\|.+\|\s*\n?)+)/g);
    if (tableMatches && tableMatches.length > 0) {
        const tableMatch = tableMatches[0].match(/\|(.+)\|\s*\n\|[-\s|:]+\|\s*\n((?:\|.+\|\s*\n?)+)/);
        if (tableMatch) {
            const headers = tableMatch[1].split('|').map(h => h.trim()).filter(h => h);
            const rows = tableMatch[2].split('\n')
                .filter(row => row.trim() && row.includes('|'))
                .map(row => row.split('|').map(cell => cell.trim()).filter(cell => cell));
            
            return { headers, rows };
        }
    }
    
    // Second priority: Look for derivative examples pattern
    const examples = [];
    let currentRule = '';
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip empty lines and intro text
        if (!line || line.includes('Here are') || line.includes('Let me know')) {
            continue;
        }
        
        // Check for numbered rules (1. **Rule Name**)
        const ruleMatch = line.match(/^\d+\.\s*\*\*([^*]+)\*\*/);
        if (ruleMatch) {
            currentRule = ruleMatch[1].trim();
            continue;
        }
        
        // Check for formula lines
        if (line.includes('Formula:') && currentRule) {
            const formulaText = line.replace('Formula:', '').trim();
            examples.push({ rule: currentRule, formula: formulaText });
            currentRule = '';
        }
    }
    
    if (examples.length >= 2) {
        return {
            headers: ['Rule', 'Formula'],
            rows: examples.map(ex => [ex.rule, ex.formula])
        };
    }
    
    // Third priority: Look for key-value pairs or structured data
    const structuredData = [];
    const keyValuePattern = /^([^:]+):\s*(.+)$/;
    
    for (const line of lines) {
        const match = line.match(keyValuePattern);
        if (match && match[1].length < 50) { // Reasonable key length
            structuredData.push([match[1].trim(), match[2].trim()]);
        }
    }
    
    if (structuredData.length >= 3) {
        return {
            headers: ['Property', 'Value'],
            rows: structuredData
        };
    }
    
    // Fourth priority: If no structured data, create a summary from the content
    const words = content.split(/\s+/).filter(word => word.length > 3);
    const wordFreq = {};
    words.forEach(word => {
        const clean = word.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
        if (clean.length > 3) {
            wordFreq[clean] = (wordFreq[clean] || 0) + 1;
        }
    });
    
    const topWords = Object.entries(wordFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => [word, count.toString()]);
    
    if (topWords.length > 0) {
        return {
            headers: ['Term', 'Frequency'],
            rows: topWords
        };
    }
    
    return null;
}

async function createCsv(filePath, content) {
    const tableData = extractTableData(content);
    
    if (!tableData) {
        // If no table data, create a simple CSV with content summary
        const lines = content.split('\n').filter(line => line.trim());
        const csvContent = ['Section,Content'];
        
        lines.forEach((line, index) => {
            if (line.trim()) {
                const cleanLine = line.replace(/"/g, '""');
                csvContent.push(`"Line ${index + 1}","${cleanLine}"`);
            }
        });
        
        await fs.writeFile(filePath, csvContent.join('\n'));
        return;
    }
    
    // Create CSV with table data
    const csvRows = [
        tableData.headers.map(h => `"${h.replace(/"/g, '""')}"`).join(','),
        ...tableData.rows.map(row => 
            row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')
        )
    ];
    
    await fs.writeFile(filePath, csvRows.join('\n'));
}

async function createXlsx(filePath, content) {
    const tableData = extractTableData(content);
    
    if (!tableData) {
        // If no table data, create a simple Excel with content breakdown
        const lines = content.split('\n').filter(line => line.trim());
        const worksheetData = [
            ['Section', 'Content'],
            ...lines.map((line, index) => [`Line ${index + 1}`, line.trim()])
        ];
        
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(worksheetData);
        
        // Auto-size columns
        const colWidths = [
            { wch: 15 }, // Section column
            { wch: 80 }  // Content column
        ];
        ws['!cols'] = colWidths;
        
        XLSX.utils.book_append_sheet(wb, ws, 'Content');
        await XLSX.writeFile(wb, filePath);
        return;
    }
    
    // Create Excel with table data
    const worksheetData = [tableData.headers, ...tableData.rows];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(worksheetData);
    
    // Auto-size columns based on content
    const colWidths = tableData.headers.map((header, colIndex) => {
        const maxLength = Math.max(
            header.length,
            ...tableData.rows.map(row => (row[colIndex] || '').length)
        );
        return { wch: Math.min(maxLength + 2, 50) };
    });
    ws['!cols'] = colWidths;
    
    // Style headers
    const headerRange = XLSX.utils.decode_range(ws['!ref']);
    for (let col = headerRange.s.c; col <= headerRange.e.c; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: 0, c: col });
        if (ws[cellAddress]) {
            ws[cellAddress].s = {
                font: { bold: true },
                fill: { fgColor: { rgb: '4472C4' } },
                alignment: { horizontal: 'center' }
            };
        }
    }
    
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    await XLSX.writeFile(wb, filePath);
}

async function createDocx(filePath, content) {
    // --- Step 1: Extract and save base64 images ---
    const tempDir = path.join(__dirname, '../../uploads/temp');
    await fs.mkdir(tempDir, { recursive: true });

    // const imageFiles = [];
    // let imageCounter = 0;

    // Extract all images (base64 and URLs) and save them as files synchronously
    // const allImageMatches = Array.from(content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g));

    // for (const match of allImageMatches) {
    //     try {
    //         const [fullMatch, alt, imageSource] = match;
    //         let imagePath;
    //         let imageName;

    //         // Check if it's a base64 image
    //         if (imageSource.startsWith('data:image/')) {
    //             const urlMatches = imageSource.match(/^data:image\/([^;]+);base64,(.+)$/);
    //             if (urlMatches) {
    //                 const ext = urlMatches[1];
    //                 const base64Data = urlMatches[2];
    //                 imageName = `chart_image_${imageCounter++}.${ext}`;
    //                 imagePath = path.join(tempDir, imageName);

    //                 // Save the base64 image file
    //                 const buffer = Buffer.from(base64Data, 'base64');
    //                 await fs.writeFile(imagePath, buffer);

    //                 imageFiles.push({ original: fullMatch, path: imagePath, alt });
    //                 console.log(`Saved base64 chart image: ${imageName}`);
    //             }
    //         }
    //         // Check if it's a URL (http, https, or absolute file path)
    //         else if (imageSource.startsWith('http://') || imageSource.startsWith('https://') || imageSource.startsWith('file://') || path.isAbsolute(imageSource)) {
    //             try {
    //                 // Determine file extension from URL or default to png
    //                 let ext = 'png';
    //                 const urlExt = imageSource.split('.').pop()?.split('?')[0];
    //                 if (urlExt && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(urlExt.toLowerCase())) {
    //                     ext = urlExt.toLowerCase();
    //                 }

    //                 imageName = `chart_image_${imageCounter++}.${ext}`;
    //                 imagePath = path.join(tempDir, imageName);

    //                 // Download the image from URL
    //                 if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
    //                     const response = await axios.get(imageSource, { responseType: 'arraybuffer' });
    //                     await fs.writeFile(imagePath, response.data);
    //                     console.log(`Downloaded URL chart image: ${imageName}`);
    //                 }
    //                 // Copy local file
    //                 else {
    //                     const localPath = imageSource.replace('file://', '');
    //                     const imageData = await fs.readFile(localPath);
    //                     await fs.writeFile(imagePath, imageData);
    //                     console.log(`Copied local chart image: ${imageName}`);
    //                 }

    //                 imageFiles.push({ original: fullMatch, path: imagePath, alt });
    //             } catch (downloadErr) {
    //                 console.error(`Failed to download/copy image from ${imageSource}:`, downloadErr);
    //                 // Keep original if download fails
    //                 continue;
    //             }
    //         }
    //     } catch (err) {
    //         console.error('Error processing image:', err);
    //     }
    // }

    // Replace all processed images with local file paths
    let cleanedContent = content;
    // for (const img of imageFiles) {
    //     cleanedContent = cleanedContent.replace(img.original, `![${img.alt}](${img.path})`);
    // }

    // --- Step 2: Semantic Table Parsing & Normalization ---
    // Highly improved normalization of markdown tables (including uneven columns etc.)
    function normalizeMarkdownTables(md) {
        const lines = md.split('\n');
        let result = [];
        let insideTable = false;
        let tableLines = [];

        function isTableLine(line) {
            // Only match as table if at least two pipes, not within codeblock
            return /^\s*\|.*\|/.test(line) && (line.match(/\|/g) || []).length >= 2;
        }

        function flushTable() {
            if (tableLines.length) {
                // Normalize table lines
                const cells = tableLines.map(line =>
                    line
                        .replace(/^\s*\|/, '')
                        .replace(/\|\s*$/, '')
                        .split('|')
                        .map(cell => cell.trim())
                );
                // Fix column count in all rows for a proper table
                const colCount = Math.max(...cells.map(row => row.length));
                const full = cells.map(row => {
                    if (row.length < colCount) return [...row, ...Array(colCount - row.length).fill('')];
                    return row.slice(0, colCount);
                });
                // Add header (assume always first row)
                result.push('');
                result.push('| ' + full[0].join(' | ') + ' |');
                for (let i = 1; i < full.length; i++) {
                    result.push('| ' + full[i].join(' | ') + ' |');
                }
                result.push('');
            }
            tableLines = [];
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (isTableLine(line)) {
                tableLines.push(line);
                insideTable = true;
            } else {
                if (insideTable) {
                    flushTable();
                    insideTable = false;
                }
                result.push(line);
            }
        }
        if (insideTable) {
            flushTable();
        }
        return result.join('\n');
    }

    cleanedContent = normalizeMarkdownTables(cleanedContent);

    // --- Step 3: Write Markdown to temp file for Pandoc ---
    const tempMarkdownPath = filePath + '.md';
    await fs.writeFile(tempMarkdownPath, cleanedContent);

    // --- Step 4: Create reference doc for Calibri font and nice base styles ---
    const referenceDoc = new Document({
        sections: [{
            children: [new Paragraph({ text: "Reference Document", heading: HeadingLevel.HEADING_1 })]
        }],
        styles: {
            default: {
                document: {
                    run: { font: "Calibri", size: 22 },
                    paragraph: { spacing: { line: 276, before: 10, after: 10 } }
                }
            }
        }
    });
    const referenceDocPath = path.join(__dirname, '../../uploads/temp', 'reference.docx');
    await fs.mkdir(path.dirname(referenceDocPath), { recursive: true });
    const referenceBuffer = await Packer.toBuffer(referenceDoc);
    await fs.writeFile(referenceDocPath, referenceBuffer);

    // --- Step 5: Pandoc Convert (with grid_tables and image extraction enabled) ---
    const pandocCommand = `pandoc "${tempMarkdownPath}" -f markdown+pipe_tables+grid_tables -t docx --extract-media="${tempDir}" --mathjax --reference-doc="${referenceDocPath}" -o "${filePath}"`;
    console.log(`Executing Pandoc command: ${pandocCommand}`);

    await new Promise((resolve, reject) => {
        exec(pandocCommand, { maxBuffer: 15 * 1024 * 1024 }, async (error, stdout, stderr) => {
            // Clean up temporary files
            try {
                await fs.unlink(tempMarkdownPath);
                // Clean up saved image files
                for (const imageFile of imageFiles) {
                    try {
                        await fs.unlink(imageFile.path);
                    } catch (unlinkErr) {
                        console.error("Image file could not be deleted:", unlinkErr);
                    }
                }
            } catch (unlinkErr) {
                console.error("Temporary markdown file could not be deleted:", unlinkErr);
            }
            if (error) {
                console.error(`Pandoc command execution error: ${error.message}`);
                console.error(`Pandoc stderr: ${stderr}`);
                return reject(error);
            }
            if (stderr) {
                // Pandoc sometimes emits warnings to stderr even on success
                console.warn(`Pandoc stderr (warnings): ${stderr}`);
            }
            console.log('Pandoc successfully created the Word document with tables.');
            resolve(stdout);
        });
    });

    // --- Step 6: Modify All Table Styles in XML for Beautiful Styling ---
    const docxBuffer = await fs.readFile(filePath);
    const zip = new PizZip(docxBuffer);
    let documentXml = zip.file('word/document.xml').asText();

    // Enhance table, header, cell and border styles in the document XML
    // Inject: borders, cell margin, vertical/horizontal alignment for best look
    documentXml = documentXml.replace(
        /<w:tblPr>/g,
        `<w:tblPr>
            <w:tblBorders>
                <w:top w:val="single" w:sz="12" w:space="0" w:color="000000"/>
                <w:left w:val="single" w:sz="12" w:space="0" w:color="000000"/>
                <w:bottom w:val="single" w:sz="12" w:space="0" w:color="000000"/>
                <w:right w:val="single" w:sz="12" w:space="0" w:color="000000"/>
                <w:insideH w:val="single" w:sz="10" w:space="0" w:color="000000"/>
                <w:insideV w:val="single" w:sz="10" w:space="0" w:color="000000"/>
            </w:tblBorders>
            <w:tblCellMar>
                <w:top w:w="120" w:type="dxa"/>
                <w:left w:w="120" w:type="dxa"/>
                <w:bottom w:w="120" w:type="dxa"/>
                <w:right w:w="120" w:type="dxa"/>
            </w:tblCellMar>
            <w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>
        `
    );

    // Add blue background and bold formatting for table headers
    // (apply blue background to the first row of each table)
    documentXml = documentXml.replace(
        /(<w:tr>)(\s*<w:tc>)/g,
        (match, p1, p2, offset, string) => {
            // Only apply to header row (first w:tr after a w:tbl element)
            const slice = string.substring(Math.max(0, offset - 250), offset);
            if (slice.includes('<w:tbl>')) {
                // Insert cell shading for all <w:tc> in this <w:tr>
                return p1 + p2.replace(
                    '<w:tc>',
                    `<w:tc>
                        <w:tcPr>
                            <w:shd w:val="clear" w:color="auto" w:fill="4472C4"/>
                            <w:vAlign w:val="center"/>
                        </w:tcPr>`
                );
            }
            return match;
        }
    );

    // Make header row text bold and white
    documentXml = documentXml.replace(
        /(<w:tr>[\s\S]*?<w:tbl>[\s\S]*?<w:tc>[\s\S]*?<w:t>)/g,
        (match) => {
            // Check if this is a header row
            const slice = match.substring(Math.max(0, match.length - 500));
            if (slice.includes('<w:tbl>')) {
                // Add bold formatting to text runs in header cells
                return match.replace(/<w:r>/g, '<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>');
            }
            return match;
        }
    );

    // For all cell props, ensure some horizontal/vertical margin and fixed height for aesthetics
    documentXml = documentXml.replace(
        /<w:tcPr>/g,
        `<w:tcPr>
            <w:tcMar>
                <w:top w:w="80" w:type="dxa"/>
                <w:left w:w="80" w:type="dxa"/>
                <w:bottom w:w="80" w:type="dxa"/>
                <w:right w:w="80" w:type="dxa"/>
            </w:tcMar>
            <w:vAlign w:val="center"/>
        `
    );

    // Write back modified docx with all style updates
    zip.file('word/document.xml', documentXml);
    const modifiedBuffer = zip.generate({ type: 'nodebuffer' });
    await fs.writeFile(filePath, modifiedBuffer);
}

async function createPdf(filePath, content) {
    const { marked } = await import('marked');
    const htmlContent = marked.parse(content);
    const fullHtml = `
        <html>
            <head>
                <meta charset="UTF-8">
                <title>Generated Document</title>
                <script>
                    window.MathJax = {
                        tex: {
                            inlineMath: [['$', '$'], ['\\(', '\\)']]
                        },
                        svg: {
                            fontCache: 'global'
                        }
                    };
                </script>
                <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
                <style>
                    body { font-family: 'Helvetica', 'Arial', sans-serif; margin: 40px; line-height: 1.6; font-size: 12pt; }
                    table { border-collapse: collapse; width: 100%; margin-bottom: 1em; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #f2f2f2; }
                    pre, code { background-color: #f8f8f8; padding: 2px 5px; border-radius: 4px; font-family: 'Courier New', Courier, monospace; }
                    pre { padding: 10px; display: block; white-space: pre-wrap; }
                    h1, h2, h3 { border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; margin-top: 24px; margin-bottom: 16px; }
                </style>
            </head>
            <body>
                ${htmlContent}
            </body>
        </html>
    `;

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
    await page.evaluate(async () => {
        await window.MathJax.startup.promise;
    });
    await page.pdf({
        path: filePath,
        format: 'A4',
        printBackground: true,
        margin: { top: '40px', right: '40px', bottom: '40px', left: '40px' }
    });
    await browser.close();
}

async function createDocument(userId, filename, content) {
    const uploadsDir = path.join(__dirname, '../../uploads/documents', userId);
    await fs.mkdir(uploadsDir, { recursive: true });
    const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filePath = path.join(uploadsDir, safeFilename);

    const extension = path.extname(safeFilename).toLowerCase();

    console.log(`Creating document with extension: ${extension}`);

    if (extension === '.docx') {
        await createDocx(filePath, content);
    } else if (extension === '.pdf') {
        await createPdf(filePath, content);
    } else if (extension === '.csv') {
        await createCsv(filePath, content);
    } else if (extension === '.xlsx') {
        await createXlsx(filePath, content);
    } else {
        await fs.writeFile(filePath, content);
    }

    return { filePath, safeFilename };
}

module.exports = {
    createDocument,
    extractTableData,
};

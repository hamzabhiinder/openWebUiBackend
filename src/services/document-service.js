const fs = require('fs').promises;
const path = require('path');
const mime = require('mime-types');
const { exec } = require('child_process');
const { Document, Packer, Paragraph, HeadingLevel } = require('docx');
const puppeteer = require('puppeteer');
const PizZip = require('pizzip');
const axios = require('axios');
const ExcelJS = require('exceljs');


async function createDocx(filePath, content) {
    // --- Step 1: Extract and save base64 images ---
    const tempDir = path.join(__dirname, '../../uploads/temp');
    await fs.mkdir(tempDir, { recursive: true });

    // NOTE: Image extraction is currently disabled, but the cleanup path expects `imageFiles`.
    // Keep this defined to avoid runtime ReferenceError.
    const imageFiles = [];

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

function tryParseJson(content) {
    try {
        return JSON.parse(content);
    } catch {
        return null;
    }
}

function parseCsvLike(content) {
    const trimmed = (content || '').trim();
    if (!trimmed) return null;

    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return null;

    // ✅ CHANGE: Added Pipe '|' as a priority delimiter
    let delimiter = null;
    if (lines.some(l => l.includes('|'))) delimiter = '|';
    else if (lines.some(l => l.includes('\t'))) delimiter = '\t';
    else if (lines.some(l => l.includes(','))) delimiter = ',';

    if (!delimiter) return null;

    const rows = lines.map(line => {
        let text = line.trim();
        // Agar Pipe hai aur outer borders hain, unhe clean karo
        if (delimiter === '|') {
            if (text.startsWith('|')) text = text.substring(1);
            if (text.endsWith('|')) text = text.substring(0, text.length - 1);
        }
        return text.split(delimiter).map(v => v.trim());
    });

    // Remove separator row (like ---|---) if it exists in CSV parsing mode
    if (delimiter === '|' && rows.length > 1) {
        const isSeparator = rows[1].every(cell => /^-+$/.test(cell) || cell === '');
        if (isSeparator) rows.splice(1, 1);
    }

    const colCount = Math.max(...rows.map(r => r.length));
    // Agar 1 hi column bana, to iska matlab parsing fail hui, null return karo taake fallback chale
    if (colCount < 2) return null;

    const normalized = rows.map(r => (r.length < colCount ? [...r, ...Array(colCount - r.length).fill('')] : r.slice(0, colCount)));
    return normalized;
}

// Function to clean markdown formatting (bold, italics) from Excel cells
function cleanCellText(text) {
    if (!text) return "";
    // Remove bold (** or __), italics (* or _), and code ticks (`)
    return text.replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/\*/g, '')
        .replace(/_/g, '')
        .replace(/`/g, '')
        .trim();
}

// ✅ NEW: Robust Table Extraction using 'marked' library
async function extractMarkdownTables(md) {

    const { marked } = await import('marked');

    // Ensure GFM (GitHub Flavored Markdown) is enabled for Table support
    if (typeof marked.use === 'function') {
        marked.use({ gfm: true });
    }

    // Lexer markdown ko tokens mein convert kar deta hai (Table detection automatic hoti hai)
    const tokens = marked.lexer(md || "");
    const tables = [];

    tokens.forEach(token => {
        if (token.type === 'table') {
            const tableData = [];

            // 1. Headers extract karein
            const headers = token.header.map(cell => {
                // Cell token object ho sakta hai ya direct text
                return cleanCellText(cell.text || cell.tokens?.map(t => t.text).join('') || String(cell));
            });
            tableData.push(headers);

            // 2. Rows extract karein
            token.rows.forEach(row => {
                const rowData = row.map(cell => {
                    return cleanCellText(cell.text || cell.tokens?.map(t => t.text).join('') || String(cell));
                });
                tableData.push(rowData);
            });

            if (tableData.length > 0) {
                tables.push(tableData);
            }
        }
    });

    return tables;
}

function sanitizeSheetName(name) {
    const cleaned = (name || 'Sheet1')
        .replace(/[\\/?*\[\]:]/g, ' ')
        .trim();
    return cleaned.slice(0, 31) || 'Sheet1';
}

function styleAsTable(worksheet, rowCount, colCount) {
    if (rowCount <= 0 || colCount <= 0) return;

    // Style header row
    const header = worksheet.getRow(1);
    header.font = {
        bold: true,
        color: { argb: 'FFFFFFFF' },
        size: 12
    };
    header.alignment = {
        vertical: 'middle',
        horizontal: 'center',
        wrapText: true
    };
    header.height = 25;

    header.eachCell(cell => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4472C4' }
        };
        cell.border = {
            top: { style: 'thin', color: { argb: 'FF000000' } },
            left: { style: 'thin', color: { argb: 'FF000000' } },
            bottom: { style: 'medium', color: { argb: 'FF000000' } },
            right: { style: 'thin', color: { argb: 'FF000000' } },
        };
    });

    // Detect column types for proper formatting (numbers, currency, etc.)
    const columnTypes = [];
    for (let c = 1; c <= colCount; c++) {
        const headerValue = worksheet.getRow(1).getCell(c).value?.toString().toLowerCase() || '';
        let colType = 'text';

        // Detect numeric/currency columns
        if (headerValue.includes('price') || headerValue.includes('cost') || headerValue.includes('value') ||
            headerValue.includes('total') || headerValue.includes('amount') || headerValue.includes('revenue')) {
            colType = 'currency';
        } else if (headerValue.includes('quantity') || headerValue.includes('qty') || headerValue.includes('count') ||
            headerValue.includes('id') || headerValue.includes('number')) {
            colType = 'number';
        }
        columnTypes.push(colType);
    }

    // Style data rows with alternating row colors for better readability
    for (let r = 2; r <= rowCount; r++) {
        const row = worksheet.getRow(r);
        row.height = 20;

        // Alternate row colors for better readability
        const isEvenRow = r % 2 === 0;
        const rowColor = isEvenRow ? 'FFF2F2F2' : 'FFFFFFFF';

        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            const colType = columnTypes[colNumber - 1] || 'text';
            const cellValue = cell.value;

            // Apply formatting based on column type
            if (colType === 'currency') {
                // Try to parse as number and format as currency
                const numValue = typeof cellValue === 'string' ? parseFloat(cellValue.replace(/[^0-9.-]/g, '')) : cellValue;
                if (!isNaN(numValue) && numValue !== null) {
                    cell.value = numValue;
                    cell.numFmt = '$#,##0.00';
                    cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
                } else {
                    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
                }
            } else if (colType === 'number') {
                // Try to parse as number
                const numValue = typeof cellValue === 'string' ? parseFloat(cellValue.replace(/[^0-9.-]/g, '')) : cellValue;
                if (!isNaN(numValue) && numValue !== null) {
                    cell.value = numValue;
                    cell.numFmt = '#,##0';
                    cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
                } else {
                    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
                }
            } else {
                cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
            }

            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: rowColor }
            };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FF000000' } },
                left: { style: 'thin', color: { argb: 'FF000000' } },
                bottom: { style: 'thin', color: { argb: 'FF000000' } },
                right: { style: 'thin', color: { argb: 'FF000000' } },
            };
        });
    }

    // Column autosize with better calculation
    for (let c = 1; c <= colCount; c++) {
        let maxLen = 10;
        for (let r = 1; r <= rowCount; r++) {
            const v = worksheet.getRow(r).getCell(c).value;
            const s = v == null ? '' : String(v);
            maxLen = Math.max(maxLen, Math.min(60, s.length + 3));
        }
        worksheet.getColumn(c).width = maxLen;
    }

    // Freeze header row for better navigation
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
}

async function createXlsx(filePath, content) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'OpenWebUI';
    workbook.created = new Date();

    const json = tryParseJson(content);
    if (json && Array.isArray(json)) {
        const worksheet = workbook.addWorksheet('Sheet1');
        const keys = Array.from(new Set(json.flatMap(obj => (obj && typeof obj === 'object' && !Array.isArray(obj)) ? Object.keys(obj) : [])));
        worksheet.addRow(keys);
        for (const item of json) {
            const row = keys.map(k => {
                const val = item?.[k];
                return val == null ? '' : (typeof val === 'object' ? JSON.stringify(val) : val);
            });
            worksheet.addRow(row);
        }
        styleAsTable(worksheet, worksheet.rowCount, keys.length || 1);
        await workbook.xlsx.writeFile(filePath);
        return;
    }

    if (json && typeof json === 'object' && Array.isArray(json.sheets)) {
        for (const [idx, sheet] of json.sheets.entries()) {
            const name = sanitizeSheetName(sheet?.name || `Sheet${idx + 1}`);
            const worksheet = workbook.addWorksheet(name);
            const data = sheet?.data;

            if (Array.isArray(data) && data.length && Array.isArray(data[0])) {
                for (const r of data) worksheet.addRow(r);
                styleAsTable(worksheet, worksheet.rowCount, (data[0] || []).length || 1);
            } else if (Array.isArray(data) && data.length && typeof data[0] === 'object') {
                const keys = Array.from(new Set(data.flatMap(obj => Object.keys(obj || {}))));
                worksheet.addRow(keys);
                for (const item of data) worksheet.addRow(keys.map(k => item?.[k] ?? ''));
                styleAsTable(worksheet, worksheet.rowCount, keys.length || 1);
            } else {
                worksheet.addRow(['Content']);
                worksheet.addRow([typeof data === 'string' ? data : JSON.stringify(data ?? '')]);
                styleAsTable(worksheet, worksheet.rowCount, 1);
            }
        }
        await workbook.xlsx.writeFile(filePath);
        return;
    }

    const csvRows = parseCsvLike(content);
    if (csvRows) {
        const worksheet = workbook.addWorksheet('Sheet1');
        for (const r of csvRows) worksheet.addRow(r);
        styleAsTable(worksheet, worksheet.rowCount, (csvRows[0] || []).length || 1);
        await workbook.xlsx.writeFile(filePath);
        return;
    }

    const tables = await extractMarkdownTables(content);
    if (tables.length > 0) {
        tables.forEach((table, idx) => {
            const worksheet = workbook.addWorksheet(`Table${idx + 1}`);
            for (const r of table) worksheet.addRow(r);
            styleAsTable(worksheet, worksheet.rowCount, (table[0] || []).length || 1);
        });
        await workbook.xlsx.writeFile(filePath);
        return;
    }

    const worksheet = workbook.addWorksheet('Sheet1');
    worksheet.addRow(['Content']);
    const lines = (content || '').split(/\r?\n/);
    for (const line of lines) {
        worksheet.addRow([line]);
    }
    styleAsTable(worksheet, worksheet.rowCount, 1);
    await workbook.xlsx.writeFile(filePath);
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

    if (extension === '.docx') {
        await createDocx(filePath, content);
    } else if (extension === '.pdf') {
        await createPdf(filePath, content);
    } else if (extension === '.xlsx') {
        await createXlsx(filePath, content);
    } else {
        await fs.writeFile(filePath, content);
    }

    return { filePath, safeFilename };
}

module.exports = {
    createDocument,
};

const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const getPathnameFromUrlOrPath = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    // Handles absolute URLs like http://localhost:5000/uploads/...
    return new URL(value).pathname;
  } catch {
    // Handles already-relative paths like /uploads/...
    return value;
  }
};

const normalizeSlashes = (p) => (p || '').replace(/\\/g, '/');

router.post('/apply-range', authenticateToken, async (req, res) => {
  try {
    const { url, sheetName, range, values, mode } = req.body || {};

    if (!url || !range || !Array.isArray(values)) {
      return res.status(400).json({ error: 'url, range, and values[][] are required' });
    }

    const pathname = getPathnameFromUrlOrPath(url);
    if (!pathname) {
      return res.status(400).json({ error: 'Invalid url' });
    }

    const normalizedPathname = normalizeSlashes(pathname);
    if (!normalizedPathname.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'Only /uploads/* files are supported' });
    }

    const rel = normalizedPathname.slice('/uploads/'.length); // e.g. documents/{userId}/file.xlsx
    const expectedPrefix = `documents/${req.user.id}/`;
    if (!normalizeSlashes(rel).startsWith(expectedPrefix)) {
      return res.status(403).json({ error: 'You can only modify your own documents' });
    }

    const uploadsRoot = path.resolve(__dirname, '../../uploads');
    const absPath = path.resolve(uploadsRoot, rel);
    if (!absPath.startsWith(uploadsRoot + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (path.extname(absPath).toLowerCase() !== '.xlsx') {
      return res.status(400).json({ error: 'Only .xlsx files are supported' });
    }

    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    const wb = XLSX.readFile(absPath, { cellDates: true });
    const targetSheetName =
      sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
    const ws = wb.Sheets[targetSheetName];
    if (!ws) {
      return res.status(404).json({ error: `Sheet not found: ${sheetName || ''}`.trim() });
    }

    const normalizedRange = (range || '').trim().split(' ')[0];
    const rangeNoSheet = normalizedRange.includes('!')
      ? normalizedRange.split('!').slice(1).join('!')
      : normalizedRange;
    const startA1 = rangeNoSheet.split(':')[0] || 'A1';

    XLSX.utils.sheet_add_aoa(ws, values, { origin: startA1 });

    let resultAbsPath = absPath;
    let resultRel = rel;
    const writeMode = (mode || 'overwrite').toString();

    if (writeMode === 'new') {
      const dir = path.dirname(absPath);
      const ext = path.extname(absPath);
      const base = path.basename(absPath, ext);
      const newName = `${base}-edited-${Date.now()}${ext}`;
      resultAbsPath = path.join(dir, newName);
      resultRel = normalizeSlashes(path.join(path.dirname(rel), newName));
    }

    XLSX.writeFile(wb, resultAbsPath);

    return res.json({
      ok: true,
      url: `/uploads/${resultRel}`,
      sheetName: targetSheetName,
      range: rangeNoSheet,
      mode: writeMode,
    });
  } catch (error) {
    console.error('Excel apply-range error:', error);
    return res.status(500).json({ error: 'Failed to apply Excel changes' });
  }
});

module.exports = router;

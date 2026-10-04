import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';

const DEFAULT_GDRIVE_FOLDER_ID = '1d9k5SpBXItTqVYF2z3_6ZsKo5w4p8Tmn';

interface GDriveEntry {
  id: string;
  title: string;
  href: string;
  kind: 'folder' | 'spreadsheet' | 'file';
  lastModified: string;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseEmbeddedFolderHtml(html: string): GDriveEntry[] {
  const entries: GDriveEntry[] = [];
  const entryRegex = /<div class="flip-entry" id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([\s\S]*?)<\/div><\/a><\/div><div class="flip-entry-last-modified"><div>([\s\S]*?)<\/div><\/div>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(html)) !== null) {
    const id = match[1].trim();
    const href = match[2].trim();
    const title = decodeHtmlEntities(match[3].trim());
    const lastModified = decodeHtmlEntities(match[4].trim());
    let kind: 'folder' | 'spreadsheet' | 'file' = 'file';
    if (href.includes('/drive/folders/')) {
      kind = 'folder';
    } else if (href.includes('/spreadsheets/d/')) {
      kind = 'spreadsheet';
    }
    entries.push({ id, title, href, kind, lastModified });
  }
  return entries;
}

async function createServer() {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';
  const port = process.env.PORT || 3000;

  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // List files in a public Google Drive folder
  app.get('/api/gdrive/folder', async (req, res) => {
    const rawFolder = String(req.query.folderId || DEFAULT_GDRIVE_FOLDER_ID).trim();
    const folderIdMatch = rawFolder.match(/folders\/([a-zA-Z0-9_-]+)/);
    const folderId = folderIdMatch ? folderIdMatch[1] : rawFolder.replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_GDRIVE_FOLDER_ID;

    try {
      const url = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) {
        res.status(response.status).json({ error: `Failed to fetch Google Drive folder (${response.status})` });
        return;
      }
      const html = await response.text();
      const folderTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
      const folderTitle = folderTitleMatch ? decodeHtmlEntities(folderTitleMatch[1].trim()) : 'Google Drive Folder';
      const files = parseEmbeddedFolderHtml(html);

      res.json({
        folderId,
        folderTitle,
        folderUrl: `https://drive.google.com/drive/folders/${folderId}?usp=sharing`,
        files
      });
    } catch (err: any) {
      console.error('Error fetching Google Drive folder:', err);
      res.status(500).json({ error: err?.message || 'Failed to read Google Drive folder' });
    }
  });

  // Download a file or spreadsheet from Google Drive as binary Excel/ArrayBuffer
  app.get('/api/gdrive/file/:fileId', async (req, res) => {
    const fileId = String(req.params.fileId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const kind = String(req.query.kind || 'file');
    if (!fileId) {
      res.status(400).json({ error: 'Missing fileId' });
      return;
    }

    const uaHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    };

    try {
      let downloadUrl =
        kind === 'spreadsheet'
          ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/export?format=xlsx`
          : `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

      let response = await fetch(downloadUrl, { headers: uaHeaders, redirect: 'follow' });
      const contentType = response.headers.get('content-type') || '';

      // If Google Drive returns an HTML confirmation page or if file is actually a Google Sheet
      if (contentType.includes('text/html')) {
        const confirmUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
        const retryRes = await fetch(confirmUrl, { headers: uaHeaders, redirect: 'follow' });
        const retryType = retryRes.headers.get('content-type') || '';
        if (retryRes.ok && !retryType.includes('text/html')) {
          response = retryRes;
        } else {
          const sheetExportUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/export?format=xlsx`;
          const sheetRes = await fetch(sheetExportUrl, { headers: uaHeaders, redirect: 'follow' });
          if (sheetRes.ok) {
            response = sheetRes;
          }
        }
      }

      if (!response.ok) {
        res.status(response.status).json({ error: `Failed to download Drive file (${response.status})` });
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(buffer.length));
      res.send(buffer);
    } catch (err: any) {
      console.error('Error downloading Google Drive file:', err);
      res.status(500).json({ error: err?.message || 'Failed to download Google Drive file' });
    }
  });

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

createServer();


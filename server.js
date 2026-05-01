require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const sharp = require('sharp');

const app = express();

// CONFIG
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST;
const API_URL = process.env.API_URL;

const MEDIA_DIR = path.join(__dirname, 'media');
const THUMB_DIR = path.join(MEDIA_DIR, '.thumbs');

fs.mkdirSync(THUMB_DIR, { recursive: true });

app.use(cors({ origin: '*' }));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1d' }));
app.use('/thumbs', express.static(THUMB_DIR, { maxAge: '7d' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Allowed extensions ──────────────────────────────────────────────────────
const allowedExt = ['jpg', 'jpeg', 'png'];

// ── Thumbnail generation ─────────────────────────────────────────────────────
async function generateThumb(filePath, filename) {
    const thumbPath = path.join(THUMB_DIR, filename + '.jpg');
    if (fs.existsSync(thumbPath)) return thumbPath;
    try {
        await sharp(filePath)
            .resize(300, 200, { fit: 'cover' })
            .jpeg({ quality: 75 })
            .toFile(thumbPath);
        return thumbPath;
    } catch {
        return null;
    }
}

async function warmThumbs(subFolder = '') {
    const targetDir = subFolder ? path.resolve(MEDIA_DIR, subFolder) : MEDIA_DIR;
    if (!targetDir.startsWith(MEDIA_DIR)) return;
    try {
        const entries = await fs.promises.readdir(targetDir);
        const prefix = subFolder ? subFolder.replace(/\//g, '_') + '_' : '';
        // generate all thumbs in parallel
        await Promise.all(
            entries
                .filter(e => !e.startsWith('.') && allowedExt.includes(path.extname(e).toLowerCase().replace('.', '')))
                .map(e => generateThumb(path.join(targetDir, e), prefix + e).catch(() => {}))
        );
    } catch { /* ignore */ }
}
warmThumbs().then(() => console.log('✅ Thumbnails warmed'));

// ── In-memory cache (2s TTL) ─────────────────────────────────────────────────
const fileCache = new Map(); // key → { data, expiresAt }

function invalidateCache(folder = '') {
    fileCache.delete(folder || '__root__');
}

// Watch for file changes → invalidate root cache
try {
    fs.watch(MEDIA_DIR, { recursive: false }, () => invalidateCache(''));
} catch { /* fs.watch not available on this platform */ }

// ── Async file list ───────────────────────────────────────────────────────────
async function getFiles(subFolder = '') {
    const cacheKey = subFolder || '__root__';
    const cached = fileCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    const targetDir = subFolder
        ? path.resolve(MEDIA_DIR, subFolder)
        : MEDIA_DIR;

    if (!targetDir.startsWith(MEDIA_DIR)) return [];

    let entries;
    try {
        entries = await fs.promises.readdir(targetDir);
    } catch {
        return [];
    }

    const stats = await Promise.all(
        entries.map(async entry => {
            try {
                const stat = await fs.promises.stat(path.join(targetDir, entry));
                return { entry, stat };
            } catch {
                return null;
            }
        })
    );

    const result = [];

    for (const item of stats) {
        if (!item) continue;
        const { entry, stat } = item;
        if (entry.startsWith('.')) continue;

        if (stat.isDirectory()) {
            const folderPath = subFolder ? `${subFolder}/${entry}` : entry;
            result.push({
                id: 'folder-' + folderPath,
                name: entry,
                type: 'folder',
                folder: folderPath,
                mtime: stat.mtimeMs,
            });
            // warm subfolder thumbs in background
            warmThumbs(folderPath).catch(() => {});
        } else {
            const ext = path.extname(entry).toLowerCase().replace('.', '');
            if (!allowedExt.includes(ext)) continue;

            const relativePath = subFolder
                ? `${subFolder}/${encodeURIComponent(entry)}`
                : encodeURIComponent(entry);

            const prefix = subFolder ? subFolder.replace(/\//g, '_') + '_' : '';
            const thumbKey = prefix + entry;
            const thumbExists = fs.existsSync(path.join(THUMB_DIR, thumbKey + '.jpg'));

            if (!thumbExists) {
                // generate in background, don't block response
                generateThumb(path.join(targetDir, entry), thumbKey).catch(() => {});
            }

            result.push({
                id: entry + '-' + stat.mtimeMs,
                name: entry,
                type: 'image',
                url: `/media/${relativePath}`,
                thumb_url: thumbExists ? `/thumbs/${encodeURIComponent(thumbKey)}.jpg` : null,
                size: stat.size,
                time_added: new Date(stat.mtime).toLocaleString(),
                mtime: stat.mtimeMs,
            });
        }
    }

    const data = result
        .sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return b.mtime - a.mtime;
        })
        .map(({ mtime, ...rest }) => rest);

    fileCache.set(cacheKey, { data, expiresAt: Date.now() + 2000 });
    return data;
}

// ── REST endpoint ─────────────────────────────────────────────────────────────
app.get('/files', async (req, res) => {
    const folder = req.query.folder || '';
    const data = await getFiles(folder);
    res.json({ status: 'success', path: folder, data });
});

// ── SSE endpoint ──────────────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const folder = req.query.folder || '';
    let lastHash = '';

    const sendData = async () => {
        const data = await getFiles(folder);
        const hash = JSON.stringify(data);
        if (hash !== lastHash) {
            lastHash = hash;
            res.write(`data: ${JSON.stringify({ status: 'success', path: folder, data })}\n\n`);
        }
    };

    sendData();
    // Poll every 3 seconds (down from 1s); fs.watch handles instant invalidation
    const interval = setInterval(sendData, 3000);

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

// ── Upload endpoint ───────────────────────────────────────────────────────────
const axios = require('axios');
const FormData = require('form-data');

app.post('/start-upload', async (req, res) => {
    const { kode_transaksi, files } = req.body || {};

    for (const fileName of files) {
        const filePath = path.join(MEDIA_DIR, fileName);
        if (!fs.existsSync(filePath)) continue;
        await uploadToWebB(filePath, kode_transaksi, fileName);
    }

    res.json({ status: 'done' });
});

async function uploadToWebB(filePath, kode_transaksi, fileName) {
    const form = new FormData();
    form.append('kode_transaksi', kode_transaksi);
    form.append('file_name', fileName);
    form.append('file', fs.createReadStream(filePath));

    try {
        const response = await axios.post(API_URL + '/api/upload-photo', form, {
            headers: form.getHeaders(),
        });
        console.log('✅ Uploaded:', fileName, response.data);
    } catch (err) {
        console.error('❌ Upload failed:', fileName);
        if (err.response) {
            console.error('STATUS:', err.response.status);
            console.error('DATA:', err.response.data);
        } else {
            console.error(err.message);
        }
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running at http://${HOST}:${PORT}`);
});

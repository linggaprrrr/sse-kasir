require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();

// 🔥 CONFIG
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST; 
const API_URL = process.env.API_URL;


const MEDIA_DIR = path.join(__dirname, 'media');

// 🔥 CORS (important) all can access
app.use(cors({
    origin: '*'
}));

// 🔥 Serve media files
app.use('/media', express.static(MEDIA_DIR));

/**
 * Get file list (similar to your PHP logic)
 */
const allowedExt = ['jpg', 'jpeg', 'png'];

function getFiles() {
    if (!fs.existsSync(MEDIA_DIR)) return [];

    const files = fs.readdirSync(MEDIA_DIR);

    return files
        .filter(file => {
            // ❌ remove hidden/system files
            if (file.startsWith('.')) return false;

            const ext = path.extname(file).toLowerCase().replace('.', '');
            return allowedExt.includes(ext);
        })
        .map(file => {
            const fullPath = path.join(MEDIA_DIR, file);
            const stat = fs.statSync(fullPath);

            return {
                id: file + '-' + stat.mtimeMs,
                name: file,
                type: 'image',
                url: `http://${HOST}:${PORT}/media/${encodeURIComponent(file)}`,
                size: stat.size,
                time_added: new Date(stat.mtime).toLocaleString(),
                mtime: stat.mtimeMs
            };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .map(({ mtime, ...rest }) => rest);
}

/**
 * Normal API (optional)
 */
app.get('/files', (req, res) => {
    res.json({
        status: 'success',
        data: getFiles()
    });
});


/**
 * Upload photo API 
 */


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/start-upload', async (req, res) => {
    const { kode_transaksi, files } = req.body;

    console.log(req.body); // debug

    for (const fileName of files) {
        const filePath = path.join(MEDIA_DIR, fileName);

        if (!fs.existsSync(filePath)) {
            console.log('❌ File not found:', fileName);
            continue;
        }

        await uploadToWebB(filePath, kode_transaksi, fileName);
    }

    res.json({ status: 'done' });
});


const axios = require('axios');
const FormData = require('form-data');



async function uploadToWebB(filePath, kode_transaksi, fileName) {
    const form = new FormData();

    form.append('kode_transaksi', kode_transaksi);
    form.append('file_name', fileName);
    form.append('file', fs.createReadStream(filePath)); 

    try {
        const response = await axios.post(
            API_URL + '/api/upload-photo',
            form,
            {
                headers: form.getHeaders(),
            }
        );

        console.log('✅ Uploaded:', fileName, response.data);
    } catch (err) {
        console.error('❌ Upload failed:', fileName);

        if (err.response) {
            console.error('STATUS:', err.response.status);
            console.error('DATA:', err.response.data); // 🔥 penting
        } else {
            console.error(err.message);
        }
    }
}


/**
 * SSE endpoint
 */
app.get('/stream', (req, res) => {
    // 🔥 Required headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    let lastHash = '';

    const sendData = () => {
        const data = getFiles();
        const hash = JSON.stringify(data);

        if (hash !== lastHash) {
            lastHash = hash;

            res.write(`data: ${JSON.stringify({
                status: 'success',
                data
            })}\n\n`);
        }
    };

    // send immediately once
    sendData();

    const interval = setInterval(sendData, 1000);

    // clean up when client disconnects
    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

// 🔥 Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running at http://${HOST}:${PORT}`);
});
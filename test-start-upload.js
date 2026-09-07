// Runnable check: /start-upload must find files inside subfolders, not just the media root.
// Usage: node test-start-upload.js
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');

const MOCK_PORT = 39181, APP_PORT = 39180;
const received = [];

const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
        received.push((body.match(/name="file_name"\r?\n\r?\n(.*)/) || [])[1]);
        res.end(JSON.stringify({ status: 'success' }));
    });
}).listen(MOCK_PORT);

const app = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: APP_PORT, API_URL: `http://127.0.0.1:${MOCK_PORT}` },
    stdio: 'ignore',
});

const post = (body) => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ port: APP_PORT, path: '/start-upload', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
        r => { let b = ''; r.on('data', c => (b += c)); r.on('end', () => resolve(JSON.parse(b))); });
    req.end(data);
});

// uploads run in the background now, so wait for the mock to see them
const waitFor = async (fn, ms = 3000) => {
    for (let waited = 0; waited < ms; waited += 50) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
};

(async () => {
    await new Promise(r => setTimeout(r, 1500));

    const inFolder = await post({ kode_transaksi: 'TEST1', files: [
        { name: '92ed3a19-c5d7-40a1-b3ed-26299967aa9f_thumb.jpg', path: 'jam 15.00/92ed3a19-c5d7-40a1-b3ed-26299967aa9f_thumb.jpg' },
    ]});
    assert.deepStrictEqual(inFolder.failed, [], 'file inside a subfolder must upload');
    assert.ok(await waitFor(() => received.length === 1), 'upload must run after the response');
    assert.strictEqual(received[0], '92ed3a19-c5d7-40a1-b3ed-26299967aa9f_thumb.jpg', 'must send basename as file_name');

    const atRoot = await post({ kode_transaksi: 'TEST2', files: ['Atlantis_IMG_2471.JPG'] });
    assert.deepStrictEqual(atRoot.failed, [], 'bare root name must still work');

    // POS renames duplicates before registering them; the file must be stored under that name
    const renamed = await post({ kode_transaksi: 'TEST4', files: [
        { name: 'Atlantis_IMG_2471_2.JPG', path: 'Atlantis_IMG_2471.JPG' },
    ]});
    assert.deepStrictEqual(renamed.failed, [], 'renamed duplicate must upload');
    assert.ok(await waitFor(() => received.at(-1) === 'Atlantis_IMG_2471_2.JPG'), 'must store under the name POS registered');

    const escape = await post({ kode_transaksi: 'TEST3', files: [{ name: 'x', path: '../../../etc/hosts' }] });
    assert.deepStrictEqual(escape.failed, ['../../../etc/hosts'], 'must refuse paths outside media dir');
    assert.strictEqual(escape.status, 'partial', 'missing files must be reported, not silently skipped');
    assert.strictEqual(atRoot.status, 'accepted', 'the POS must not wait for the uploads to finish');

    console.log('✅ all checks passed');
})().catch(e => { console.error('❌', e.message); process.exitCode = 1; })
   .finally(() => { app.kill(); mock.close(); });

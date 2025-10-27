// Node.js built-in modules
const fs = require('fs').promises;
const path = require('path');
const { URLSearchParams } = require('url');

// Installed npm packages
const axios = require('axios');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const sqlite3 = require('sqlite3').verbose();

// Load environment variables
require('dotenv').config();
const DOCUWARE_BASE = process.env.DW_PLATFORM_URL;
const DOCUWARE_USERNAME = process.env.DW_USERNAME;
const DOCUWARE_PASSWORD = process.env.DW_PASSWORD;
const DOCUWARE_ORGANIZATION_NAME = process.env.DW_ORGANIZATION_NAME;
const SQLITE_DB_PATH = path.resolve(__dirname, process.env.SQLITE_DB_NAME);
const LOOP_PAUSE = parseInt(process.env.LOOP_PAUSE_MS || '0', 10);

// Axios Client with Cookie Management
const cookieJar = new CookieJar();
const axiosClient = wrapper(axios.create({ jar: cookieJar, maxRedirects: 5, timeout: 60000 }));

// forces Node.js to trust the HTTPS certificate from DocuWare
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Error & Helper
class SessionExpiredError extends Error { constructor(message) { super(message); this.name = "SessionExpiredError"; } }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- DocuWare Login ---
async function getDocuwareSession() {
    process.stdout.write("Attempting DocuWare login... ");
    const loginUrl = `${DOCUWARE_BASE}/Account/Logon`;
    const payload = new URLSearchParams({
        userName: DOCUWARE_USERNAME, password: DOCUWARE_PASSWORD,
        organization: DOCUWARE_ORGANIZATION_NAME, rememberMe: 'false'
    });
    try {
        await axiosClient.post(loginUrl, payload, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/xml', 'X-Requested-With': 'XMLHttpRequest' }
        });
        await axiosClient.get(`${DOCUWARE_BASE}/FileCabinets`, { headers: { 'Accept': 'application/json' }, timeout: 15000 });
        process.stdout.write("Success.\n");
        return true;
    } catch (err) {
        process.stdout.write(`FAILED (${err?.response?.status ? `HTTP ${err.response.status}` : err.message})\n`);
        return false;
    }
}
// --- DocuWare Logoff ---
async function logoffDocuware() {
    if (cookieJar.getCookiesSync(DOCUWARE_BASE).length === 0) return;
    console.log("\nLogging off DocuWare...");
    const logoffUrl = `${DOCUWARE_BASE}/Account/Logoff`;
    try {
        await axiosClient.get(logoffUrl, { timeout: 10000, headers: { 'Accept': 'application/xml', 'X-Requested-With': 'XMLHttpRequest' } });
        console.log("Logoff successful.");
    } catch (error) {
        console.warn(`WARNING: Logoff failed: ${error.message}`);
    }
}
// --- Upload to DocuWare ---
// 1. Read the File
// 2. Prepare Index Data
// 3. Prepare Form Data
// 4. Perform Upload (Timeout for waiting on DocuWare's response, necessary for large files)
// 5. Return the DocuWare-ID on success
async function uploadToDocuware(fileCabinetGuid, filePath, indexData) {
    const uploadUrl = `${DOCUWARE_BASE}/FileCabinets/${fileCabinetGuid}/Documents`;
    let fileContent;

    try {
        fileContent = await fs.readFile(filePath);

        const fileName = path.basename(filePath);
        const fieldsToSend = Object.entries(indexData)
            .filter(([key]) => !['obj_id', 'archive_guid', 'path', 'docuware_id', 'docuware_timestamp'].includes(key.toLowerCase()))
            .map(([key, value]) => ({
                FieldName: key,
                Item: String(value ?? ''),
                ItemElementName: 'String'
             }));

        fieldsToSend.push({ FieldName: 'obj_id', Item: String(indexData.obj_id), ItemElementName: 'String' });
        const documentData = { Fields: fieldsToSend };

        const form = new FormData();
        form.append('document', JSON.stringify(documentData), { contentType: 'application/json' });
        form.append('file', fileContent, { filename: fileName, contentType: 'application/octet-stream' });

        const response = await axiosClient.post(uploadUrl, form, {
            headers: { ...form.getHeaders(), Accept: 'application/json' },
            timeout: 90000
        });

        return { docId: response.data?.Id || null };

    // --- Error Handling ---
    // 1. Check for Session Timeout
    // 2. Check for File not found
    // 3. Check for HTTP Errors
    // 4. Return other general errors 
    } catch (error) {

        if (error.response?.status === 401) {
            throw new SessionExpiredError(`Session expired during upload for ${filePath}`);
        }
        if (error.code === 'ENOENT') {
            return { error: 'file_not_found', reason: 'File not found' };
        }
        if (error.response) {
            const status = error.response.status;
            let reason = `HTTP ${status}`;
            let code = `http_${status}`;

            if (status === 409) {
                code = 'skipped_duplicate';
                reason = 'HTTP 409 Conflict';
            } else if (status === 413) {
                code = 'too_large';
                reason = 'HTTP 413 Request Entity Too Large';
            }
            return { error: code, reason: reason };
        }
        return { error: 'general', reason: error.message || 'Unknown upload error' };
    }
}
// --- Update Upload-DB ---
// 1. Update DocuWare-ID and timestamp
// 2. Chatch Errors
function updateDbRecord(db, objId, docuwareId, timestamp) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE upload SET docuware_id = ?, docuware_timestamp = ? WHERE obj_id = ?`;
        db.run(sql, [docuwareId, timestamp, objId], function(err) {
            if (err) return reject(new Error(`SQLite update failed for ${objId}: ${err.message}`));
            if (this.changes === 0) console.warn(`\n >> SQLite Warning: obj_id ${objId} not found for update.`);
            resolve();
        });
    });
}
// --- Database Helper Functions ---
// Helper: Connect to SQLite Update-DB
function connectDb() {
    return new Promise((resolve, reject) => {
        const instance = new sqlite3.Database(SQLITE_DB_PATH, sqlite3.OPEN_READWRITE, (err) => {
            if (err) return reject(new Error(`Could not connect to SQLite Update-DB: ${err.message}`));
            console.log('Connected to SQLite Update-DB');
            resolve(instance);
        });
    });
}
// Helper: Get pending upload records
function getPendingRows(db) {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM upload WHERE docuware_id = 0 ORDER BY obj_id", [], (err, rows) => {
            if (err) return reject(new Error(`Failed to query SQLite: ${err.message}`));
            resolve(rows);
        });
    });
}
// Helper: Process a single row (upload, log, and update DB)
async function processRow(db, row) {
    const objId = row.obj_id;
    const indexData = { ...row };
    const uploadResult = await uploadToDocuware(row.archive_guid, row.path, indexData);

    if (uploadResult?.docId) { 
        const nowTimestamp = new Date().toISOString();
        await updateDbRecord(db, objId, uploadResult.docId, nowTimestamp);
        process.stdout.write(`SUCCESS (ID: ${uploadResult.docId})\n`);
    } else if (uploadResult?.error === 'skipped_duplicate') {
        process.stdout.write(`SKIPPED (Duplicate/Conflict)\n`);
    } else {
        const reason = uploadResult?.reason || 'Unknown failure';
        process.stdout.write(`FAILED (${reason})\n`);
        if (reason !== 'File not found') {
            console.error(` >> DETAIL (${objId}): ${reason}`);
        }
    }
}
// Helper: Close the SQLite database connection
function closeDb(db) {
    if (db) {
        db.close((err) => {
            if (err) console.error('Error closing SQLite database.', err.message);
            else console.log('SQLite database connection closed.');
        });
    }
}
// --- Main Upload Function ---
// 1. DocuWare Login
// 2. Connect to SQLite Update-DB
// 3. Get pending upload records
// 4. Upload Loop with Rate Limiting
// 5. On success write DocuWare-ID and timestamp to DB
// 6. Relogin when session expires
// 7. General error handling
// 8. Log off from DocuWare
// 9. Close the Update-DB connection
async function main() {
    let db = null;
    let loginSuccess = false;

    try {
        // 1. DocuWare Login
        loginSuccess = await getDocuwareSession();
        if (!loginSuccess) process.exit(1);

        // 2. Connect to SQLite Update-DB
        db = await connectDb();

        // 3. Get pending upload records
        const rows = await getPendingRows(db);
        const totalPending = rows.length;
        console.log(`Found ${totalPending} records pending upload.`);
        if (totalPending === 0) return; // return springt zu finally

        // 4. Upload Loop with Rate Limiting
        let i = 0;
        while (i < totalPending) {
            const row = rows[i];
            const objId = row.obj_id;
            let currentTry = 1;

            if (LOOP_PAUSE > 0) await sleep(LOOP_PAUSE);
            process.stdout.write(`[${i + 1}/${totalPending}] Uploading ${objId}... `);
        
            try {
                // 5. On success write DocuWare-ID and timestamp to DB
                await processRow(db, row);
                i++;

            } catch (error) {

                // 6. Relogin when session expires
                if (error instanceof SessionExpiredError && currentTry === 1) {
                    process.stdout.write(`FAILED (Session Expired - Retrying login...)\n`);
                    loginSuccess = await getDocuwareSession();
                    
                    if (!loginSuccess) {
                        console.error("Re-login failed.");
                        i = totalPending;
                    } else {
                        console.log(" > Re-login successful. Retrying last upload...");
                        currentTry++;
                    }
                } else {
                    const reason = (error instanceof SessionExpiredError) ? 'Session Expired (Retry Failed)' : error.message;
                    process.stdout.write(`FAILED (${reason})\n`);
                    console.error(`Error processing ${objId}: ${error.message}`);
                    i++;
                }
            }
        }
    } catch (error) {
        // 7. General error handling (für Setup-Fehler)
        console.error(`\nError in main process: ${error.message}`);
    } finally {
        // 8. Log off from DocuWare
        await logoffDocuware();
        // 9. Close the Update-DB connection
        closeDb(db);
        console.log(`\nUpload process finished.`);
    }
}
main();
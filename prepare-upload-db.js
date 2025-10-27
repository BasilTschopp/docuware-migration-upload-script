require('dotenv').config();
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const PG_CONFIG = {
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT, 10),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE
};
const SQLITE_DB_PATH = path.resolve(__dirname, process.env.SQLITE_DB_NAME);

// --- Syncing the upload database ---
// 1. Create the 'upload' table if it does not exist
// 2. Connect to the source DB, fetch data via SQL query with 'AS' mapping
// 3. Write mapped data to the 'upload' DB
// 4. Error handling
// 5. Close database connections
async function prepareDatabase() {
    console.log(`Connecting to SQLite database: ${SQLITE_DB_PATH}...`);
    let db;
    try {
        db = await connectSqlite(SQLITE_DB_PATH);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }

    let pgClient = null;
    const pool = new Pool(PG_CONFIG);

    try {
        // 1. Create the 'upload' table if it does not exist
        await ensureSqliteTable(db);

        // 2. Connect to the source DB, fetch data via SQL query with 'AS' mapping
        pgClient = await pool.connect();
        console.log('Successfully connected to PostgreSQL.');
        const rows = await fetchSourceData(pgClient);

        // 3. Write mapped data to the 'upload' DB
        if (rows.length > 0) {
            await writeToSqlite(db, rows);
        } else {
            console.log("No new records found in source DB. Nothing to write.");
        }
    // 4. Error handling
    } catch (error) {
        console.error('An error occurred during database preparation:', error.message);
        // Versuch, bei einem Fehler ein Rollback durchzuführen
        try { 
            await new Promise((resolve, reject) => {
                db.run("ROLLBACK;", (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            console.log("SQLite transaction rolled back.");
        } catch (rollbackError) {
            console.error("Failed to rollback transaction:", rollbackError.message);
        }
    // 5. Close database connections
    } finally {
        if (pgClient) {
            pgClient.release();
            console.log('PostgreSQL client released.');
        }
        await pool.end();
        console.log('PostgreSQL pool closed.');

        if (db) {
            db.close((err) => {
                if (err) { console.error('Error closing SQLite database.', err.message); }
                else { console.log('SQLite database connection closed.'); }
            });
        }
    }
}
// --- Helper Functions ---
// Helper: Connect to SQLite
function connectSqlite(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                reject(new Error(`FATAL: Could not connect to SQLite database. ${err.message}`));
            } else {
                console.log('Connected to SQLite database.');
                resolve(db);
            }
        });
    });
}
// Helper: Create/Alter SQLite Table
function ensureSqliteTable(db) {
    const createTableSql = `
        CREATE TABLE IF NOT EXISTS upload (
            obj_id TEXT PRIMARY KEY,
            archive_guid TEXT,
            x TEXT,
            y TEXT,
            docuware_id INTEGER DEFAULT 0,
            docuware_timestamp TEXT DEFAULT NULL -- Timestamp column
        )
    `;
    const alterTableSql = `ALTER TABLE upload ADD COLUMN docuware_timestamp TEXT DEFAULT NULL`;

    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(createTableSql, (err) => {
                if (err) return reject(new Error(`Failed to create table: ${err.message}`));
                console.log("SQLite table 'upload' ensured.");
            
                db.run(alterTableSql, () => {
                    console.log("Column 'docuware_timestamp' ensured in table 'upload'.");
                    resolve();
                });
            });
        });
    });
}
// Helper: Fetch Data from PostgreSQL
async function fetchSourceData(pgClient) {
    const sqlQuery = `
        SELECT
            COALESCE(obj_id, '') AS obj_id,
            CASE
                WHEN obj_content ILIKE '%.msg' THEN 'XY' -- Email archive
                ELSE '92af59b3-2c61-4bed-9236-de9852959a09' -- Document archive
            END AS archive_guid,

            REPLACE(REPLACE(REPLACE(c_x, '[', ''), '"', ''), ']', '') AS X,
            REPLACE(REPLACE(REPLACE(c_y, '[', ''), '"', ''), ']', '') AS Y,

            CASE
              WHEN obj_content LIKE 'fs:docs%' THEN REPLACE(obj_content, 'fs:docs/', $2)
              WHEN obj_content LIKE 'fs:d%'   THEN REPLACE(obj_content, 'fs:d/', $3)
              ELSE 'Error'
            END AS path

          FROM table
          WHERE obj_content IS NOT NULL
            AND obj_profile = 'cq_doc_wagen'
            AND obj_created >= $1
          ORDER BY obj_id;
        `;

    const queryParams = [
        process.env.SQL_FILTER_CREATED_DATE,
        process.env.CQ_PATH_PREFIX_DOCS,
        process.env.CQ_PATH_PREFIX_D
    ];

    console.log('Executing PostgreSQL query...');
    const result = await pgClient.query(sqlQuery, queryParams);
    console.log(`Found ${result.rows.length} records to process.`);
    return result.rows;
}
// Helper: Write mapped data to the 'upload' DB
function writeToSqlite(db, rows) {
    const insertSql = `
        INSERT INTO upload (
            obj_id, archive_guid, path, docuware_id, docuware_timestamp
        ) VALUES (
            ?, ?, ?
            COALESCE((SELECT docuware_id FROM upload WHERE obj_id = ?), 0),
            COALESCE((SELECT docuware_timestamp FROM upload WHERE obj_id = ?), NULL)
        )
    `;

    return new Promise((resolve, reject) => {
        let processedCount = 0;
        const totalRows = rows.length;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION;", (err) => { if (err) return reject(err); });

            const stmt = db.prepare(insertSql, (err) => { if (err) return reject(err); });
            
            for (const row of rows) {
                if (row.path === 'Error') {
                    console.warn(`Skipping obj_id ${row.obj_id} due to invalid path mapping.`);
                    continue;
                }

                stmt.run(
                    row.obj_id, row.archive_guid, row.x, row.y
                , (err) => {
                    if (err) console.error(`Failed to insert ${row.obj_id}: ${err.message}`);
                });
                
                processedCount++;
                if (processedCount % 100 === 0) {
                    console.log(`Processed ${processedCount}/${totalRows} records...`);
                }
            }          
            stmt.finalize((err) => {
                if (err) return reject(new Error(`Failed to finalize statement: ${err.message}`));
                
                db.run("COMMIT;", (err) => {
                    if (err) return reject(new Error(`Failed to commit transaction: ${err.message}`));
                    
                    console.log(`Finished processing ${processedCount} records into SQLite.`);
                    resolve();
                });
            });
        });
    });
}
prepareDatabase();
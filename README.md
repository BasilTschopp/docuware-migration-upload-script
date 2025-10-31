
## Purpose
Write file paths and index data for documents from a SQL query, 
map them to a staging table, and then upload the documents with their
index data via REST API to the DocuWare Document Management System.

## Required libraries
npm install dotenv pg sqlite3 axios form-data tough-cookie axios-cookiejar-support

## ENV
An .env file with the following constants is required.

#### Souce-DB
PG_HOST=<br>
PG_PORT=<br>
PG_USER=<br>
PG_PASSWORD=<br>
PG_DATABASE=<br>

#### Upload-DB
SQLITE_DB_NAME=migration.db

#### DocuWare-DB
DW_PLATFORM_URL=.../DocuWare/Platform<br>
DW_USERNAME<br>
DW_PASSWORD=<br>
DW_ORGANIZATION_NAME=<br>

#### The start timestamp for the SQL filter (Format: YYYY-MM-DD HH:MM:SS)
SQL_FILTER_CREATED_DATE=

#### Special case when documents are located in different main paths
CQ_PATH_PREFIX_DOCS=
CQ_PATH_PREFIX_D=

#### Pause in milliseconds between each row for rate limiting
LOP_PAUSE_MS=500

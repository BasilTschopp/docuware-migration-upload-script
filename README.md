
## Purpose
Write file paths and index data for documents from a SQL query with mapping to a staging table, 
then upload the documents with their index data via REST API.

## Required libraries
npm install dotenv pg sqlite3 axios form-data tough-cookie axios-cookiejar-support

## ENV
An .env file with the following constants is required.

#### Souce-DB
PG_HOST=
PG_PORT=
PG_USER=
PG_PASSWORD=
PG_DATABASE=

#### Upload-DB
SQLITE_DB_NAME=migration.db

#### DocuWare-DB
DW_PLATFORM_URL=XY/DocuWare/Platform
DW_USERNAME
DW_PASSWORD=
DW_ORGANIZATION_NAME=

#### The start timestamp for the SQL filter (Format: YYYY-MM-DD HH:MM:SS)
SQL_FILTER_CREATED_DATE=

#### The destination paths for the 'fs:docs/' and 'fs:d/' prefixe
CQ_PATH_PREFIX_DOCS=
CQ_PATH_PREFIX_D=

#### Pause in milliseconds between each row for rate limiting
LOP_PAUSE_MS=500
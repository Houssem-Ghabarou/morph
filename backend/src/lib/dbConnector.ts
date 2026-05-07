import { Pool as PgPool } from 'pg';

export type ConnectionType = 'postgresql' | 'mysql' | 'mongodb';

export interface ConnectionConfig {
  type: ConnectionType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

export interface DiscoveredColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface DiscoveredTable {
  tableName: string;
  rowCount: number;
  columns: DiscoveredColumn[];
  sampleRows: Record<string, unknown>[];
}

// ─── PostgreSQL helpers ───────────────────────────────────────────────────────

function pgPool(config: ConnectionConfig) {
  return new PgPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
    max: 2,
  });
}

async function pgTest(config: ConnectionConfig): Promise<void> {
  const pool = pgPool(config);
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
    await pool.end();
  }
}

async function pgDiscover(config: ConnectionConfig): Promise<DiscoveredTable[]> {
  const pool = pgPool(config);
  const client = await pool.connect();
  try {
    const tablesRes = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const tables: DiscoveredTable[] = [];
    for (const row of tablesRes.rows) {
      const tableName = row.table_name as string;

      const colsRes = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      const countRes = await client.query(`SELECT COUNT(*) AS n FROM "${tableName}"`);
      const rowCount = parseInt(countRes.rows[0].n, 10);

      const sampleRes = await client.query(`SELECT * FROM "${tableName}" LIMIT 3`);

      tables.push({
        tableName,
        rowCount,
        columns: colsRes.rows.map((c) => ({
          name: c.column_name as string,
          type: c.data_type as string,
          nullable: c.is_nullable === 'YES',
        })),
        sampleRows: sampleRes.rows,
      });
    }

    return tables;
  } finally {
    client.release();
    await pool.end();
  }
}

async function pgImportTable(
  config: ConnectionConfig,
  tableName: string,
  limit = 50000
): Promise<{ columns: DiscoveredColumn[]; rows: Record<string, unknown>[] }> {
  const pool = pgPool(config);
  const client = await pool.connect();
  try {
    const colsRes = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [tableName]);

    const rowsRes = await client.query(`SELECT * FROM "${tableName}" LIMIT $1`, [limit]);

    return {
      columns: colsRes.rows.map((c) => ({
        name: c.column_name as string,
        type: c.data_type as string,
        nullable: c.is_nullable === 'YES',
      })),
      rows: rowsRes.rows,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

// ─── MySQL helpers ────────────────────────────────────────────────────────────

async function getMysqlConn(config: ConnectionConfig) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl ? {} : undefined,
    connectTimeout: 8000,
  });
}

async function mysqlTest(config: ConnectionConfig): Promise<void> {
  const conn = await getMysqlConn(config);
  try {
    await conn.ping();
  } finally {
    await conn.end();
  }
}

async function mysqlDiscover(config: ConnectionConfig): Promise<DiscoveredTable[]> {
  const conn = await getMysqlConn(config);
  try {
    const [tableRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT TABLE_NAME AS table_name, IFNULL(TABLE_ROWS, 0) AS row_count
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [config.database]
    );

    const tables: DiscoveredTable[] = [];
    for (const row of tableRows) {
      const tableName = row.table_name as string;

      const [colRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
        `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
                IS_NULLABLE AS is_nullable
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [config.database, tableName]
      );

      const [sampleRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
        `SELECT * FROM \`${tableName}\` LIMIT 3`
      );

      tables.push({
        tableName,
        rowCount: Number(row.row_count),
        columns: colRows.map((c) => ({
          name: c.column_name as string,
          type: c.data_type as string,
          nullable: c.is_nullable === 'YES',
        })),
        sampleRows: sampleRows as Record<string, unknown>[],
      });
    }

    return tables;
  } finally {
    await conn.end();
  }
}

async function mysqlImportTable(
  config: ConnectionConfig,
  tableName: string,
  limit = 50000
): Promise<{ columns: DiscoveredColumn[]; rows: Record<string, unknown>[] }> {
  const conn = await getMysqlConn(config);
  try {
    const [colRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
              IS_NULLABLE AS is_nullable
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [config.database, tableName]
    );

    const [rows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT * FROM \`${tableName}\` LIMIT ?`,
      [limit]
    );

    return {
      columns: colRows.map((c) => ({
        name: c.column_name as string,
        type: c.data_type as string,
        nullable: c.is_nullable === 'YES',
      })),
      rows: rows as Record<string, unknown>[],
    };
  } finally {
    await conn.end();
  }
}

// ─── MongoDB helpers ──────────────────────────────────────────────────────────

function mongoUri(config: ConnectionConfig): string {
  // If username is provided, use authenticated URI; otherwise open (no auth)
  if (config.username) {
    const user = encodeURIComponent(config.username);
    const pass = encodeURIComponent(config.password);
    return `mongodb://${user}:${pass}@${config.host}:${config.port}/${config.database}?authSource=admin`;
  }
  return `mongodb://${config.host}:${config.port}/${config.database}`;
}

async function getMongoClient(config: ConnectionConfig) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MongoClient } = require('mongodb') as typeof import('mongodb');
  const client = new MongoClient(mongoUri(config), {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    tls: config.ssl,
  });
  await client.connect();
  return client;
}

// Infer a PG-compatible type from a sample of MongoDB field values
function inferMongoFieldType(samples: unknown[]): string {
  const nonNull = samples.filter((v) => v !== null && v !== undefined);
  if (nonNull.length === 0) return 'TEXT';

  // Check if all values are integers
  if (nonNull.every((v) => typeof v === 'number' && Number.isInteger(v))) return 'INTEGER';
  if (nonNull.every((v) => typeof v === 'number')) return 'NUMERIC';
  if (nonNull.every((v) => typeof v === 'boolean')) return 'BOOLEAN';
  if (nonNull.every((v) => v instanceof Date)) return 'TIMESTAMP';

  // Check for date strings
  if (nonNull.every((v) => typeof v === 'string' && !isNaN(Date.parse(v as string)) &&
    /^\d{4}-\d{2}-\d{2}/.test(v as string))) return 'DATE';

  return 'TEXT';
}

async function mongoTest(config: ConnectionConfig): Promise<void> {
  const client = await getMongoClient(config);
  try {
    await client.db(config.database).command({ ping: 1 });
  } finally {
    await client.close();
  }
}

async function mongoDiscover(config: ConnectionConfig): Promise<DiscoveredTable[]> {
  const client = await getMongoClient(config);
  try {
    const db = client.db(config.database);
    const collections = await db.listCollections().toArray();

    const tables: DiscoveredTable[] = [];
    for (const col of collections) {
      const coll = db.collection(col.name);
      const rowCount = await coll.estimatedDocumentCount();
      const sampleDocs = await coll.find({}).limit(5).toArray();

      // Build column list from union of fields across sample docs
      const fieldNames = new Set<string>();
      for (const doc of sampleDocs) {
        for (const key of Object.keys(doc)) {
          if (key !== '_id') fieldNames.add(key);
        }
      }

      const columns: DiscoveredColumn[] = [{ name: '_id', type: 'TEXT', nullable: false }];
      for (const field of fieldNames) {
        const samples = sampleDocs.map((d) => d[field]);
        columns.push({ name: field, type: inferMongoFieldType(samples), nullable: true });
      }

      tables.push({
        tableName: col.name,
        rowCount,
        columns,
        sampleRows: sampleDocs.map((d) => {
          const row: Record<string, unknown> = { _id: String(d._id) };
          for (const k of fieldNames) row[k] = d[k] ?? null;
          return row;
        }),
      });
    }

    return tables;
  } finally {
    await client.close();
  }
}

async function mongoImportTable(
  config: ConnectionConfig,
  collectionName: string,
  limit = 50000
): Promise<{ columns: DiscoveredColumn[]; rows: Record<string, unknown>[] }> {
  const client = await getMongoClient(config);
  try {
    const db = client.db(config.database);
    const coll = db.collection(collectionName);
    const docs = await coll.find({}).limit(limit).toArray();

    const fieldNames = new Set<string>();
    for (const doc of docs.slice(0, 20)) {
      for (const key of Object.keys(doc)) {
        if (key !== '_id') fieldNames.add(key);
      }
    }

    const columns: DiscoveredColumn[] = [{ name: '_id', type: 'TEXT', nullable: false }];
    for (const field of fieldNames) {
      const samples = docs.slice(0, 20).map((d) => d[field]);
      columns.push({ name: field, type: inferMongoFieldType(samples), nullable: true });
    }

    const rows = docs.map((d) => {
      const row: Record<string, unknown> = { _id: String(d._id) };
      for (const k of fieldNames) row[k] = d[k] ?? null;
      return row;
    });

    return { columns, rows };
  } finally {
    await client.close();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function testConnection(config: ConnectionConfig): Promise<void> {
  if (config.type === 'postgresql') return pgTest(config);
  if (config.type === 'mysql') return mysqlTest(config);
  if (config.type === 'mongodb') return mongoTest(config);
  throw new Error(`Unsupported connection type: ${config.type}`);
}

export async function discoverSchemas(config: ConnectionConfig): Promise<DiscoveredTable[]> {
  if (config.type === 'postgresql') return pgDiscover(config);
  if (config.type === 'mysql') return mysqlDiscover(config);
  if (config.type === 'mongodb') return mongoDiscover(config);
  throw new Error(`Unsupported connection type: ${config.type}`);
}

export async function importTableData(
  config: ConnectionConfig,
  tableName: string,
  limit = 50000
): Promise<{ columns: DiscoveredColumn[]; rows: Record<string, unknown>[] }> {
  if (config.type === 'postgresql') return pgImportTable(config, tableName, limit);
  if (config.type === 'mysql') return mysqlImportTable(config, tableName, limit);
  if (config.type === 'mongodb') return mongoImportTable(config, tableName, limit);
  throw new Error(`Unsupported connection type: ${config.type}`);
}

// Map external DB types to our supported PG types
export function mapTypeToPg(externalType: string): string {
  const t = externalType.toLowerCase();
  if (['int', 'integer', 'int4', 'int8', 'bigint', 'smallint', 'tinyint', 'mediumint'].includes(t)) return 'INTEGER';
  if (['float', 'double', 'decimal', 'numeric', 'real', 'float4', 'float8', 'money'].includes(t)) return 'NUMERIC';
  if (['bool', 'boolean', 'bit'].includes(t)) return 'BOOLEAN';
  if (['date'].includes(t)) return 'DATE';
  if (['datetime', 'timestamp', 'timestamptz', 'timestamp without time zone', 'timestamp with time zone'].includes(t)) return 'TIMESTAMP';
  return 'TEXT';
}

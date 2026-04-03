export interface Column {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableSchema {
  tableName: string;
  columns: Column[];
}

export interface ChatRequest {
  message: string;
  sessionId: number;
}

export interface Relation {
  from: string; // table that has the FK (actual DB name)
  to: string;   // table being referenced (actual DB name)
  on: string;   // FK column name
}

export interface AnalysisCard {
  title: string;
  sql: string;
  rows: Record<string, unknown>[];
  columns: string[];
  chartType: 'bar' | 'stat' | 'table';
}

export interface ChatResponse {
  sql: string;
  message: string;
  schema: TableSchema | null;
  action: 'create' | 'alter' | 'insert' | 'select' | 'unknown' | 'prefill' | 'query' | 'create_many' | 'analyze';
  alreadyExisted?: boolean;
  sessionName?: string;
  suggestion?: string;
  values?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
  columns?: string[];
  chartType?: 'bar' | 'stat' | 'table';
  schemas?: TableSchema[];
  relations?: Relation[];
  analyses?: AnalysisCard[];
}

export interface Session {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SessionDetail extends Session {
  messages: Array<{ id: number; role: 'user' | 'system'; text: string; warning: boolean }>;
  sessionTables: Array<{ table_name: string; pos_x: number; pos_y: number }>;
  relations: Relation[];
}

export interface ApiError {
  error: string;
  details?: string;
}

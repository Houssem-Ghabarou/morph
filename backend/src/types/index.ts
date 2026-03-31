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

export interface ChatResponse {
  sql: string;
  message: string;
  schema: TableSchema | null;
  action: 'create' | 'alter' | 'insert' | 'select' | 'unknown';
  alreadyExisted?: boolean;
  sessionName?: string;
  suggestion?: string;
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
}

export interface ApiError {
  error: string;
  details?: string;
}

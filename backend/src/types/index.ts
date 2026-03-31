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
}

export interface ChatResponse {
  sql: string;
  schema: TableSchema | null;
  action: 'create' | 'alter' | 'insert' | 'select' | 'unknown';
}

export interface ApiError {
  error: string;
  details?: string;
}

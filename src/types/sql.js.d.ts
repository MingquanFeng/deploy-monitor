declare module "sql.js" {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  interface Database {
    run(sql: string, params?: (string | number | null)[]): void;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  interface Statement {
    bind(params?: (string | number | null)[]): boolean;
    step(): boolean;
    getAsObject(params?: Record<string, unknown>): Record<string, unknown>;
    get(params?: (string | number | null)[]): unknown[];
    free(): void;
    reset(): void;
  }

  interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
  export { Database, Statement, QueryExecResult, SqlJsStatic };
}

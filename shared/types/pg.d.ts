declare module 'pg' {
  import type { PostgresPool } from 'kysely';

  type PoolConfig = { readonly connectionString: string; readonly max: number; readonly connectionTimeoutMillis?: number };

  interface Pool extends PostgresPool {
    on(event: 'error', listener: (error: Error) => void): this;
  }

  const pg: { readonly Pool: new (config: PoolConfig) => Pool };
  export default pg;
}

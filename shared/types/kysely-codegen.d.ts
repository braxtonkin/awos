declare module 'kysely-bun-sqlite' {
  import type { Dialect } from 'kysely';

  export type BunSqliteDialect = Dialect;
}

declare module '@libsql/kysely-libsql' {
  import type { Dialect } from 'kysely';

  export type LibsqlDialect = Dialect;
}

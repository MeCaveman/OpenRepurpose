export interface Migration {
  readonly id: string;
  readonly sql: string;
}

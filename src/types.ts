export type CascadeDeleteOptions = {
  /**
   * Which collections to observe for cascade delete.
   *
   * - `true`: observe all collections.
   * - Record: map of collection slug → `true` to enable, `false`/omitted to skip.
   */
  collections: true | Partial<Record<string, boolean>>
}

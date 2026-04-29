# CLAUDE.md: payload-cascade-delete

Context and guidelines for AI-assisted development on this project.

---

## What this project is

`payload-cascade-delete` is a **Payload CMS v3 plugin** that automates cascade deletes through Payload's own lifecycle (hooks, transactions, access control) instead of relying on database-level `ON DELETE CASCADE` rules.

The core problem it solves: when you delete a parent document in Payload, child documents that hold a required relationship to it become orphaned. Database-level cascades would silently remove them without firing any Payload hooks, which breaks side effects like file cleanup, search indexing, audit trails, and other plugins.

---

## Domain concepts

### Parent collection

The collection **being deleted**. When a parent document is removed, children must follow.

Example: `appointments` is the parent; it has no relationship field pointing elsewhere.

### Child collection

A collection whose documents hold a **required single relationship** to the parent. When the parent is deleted, all child documents that reference it must also be deleted.

Example: `appointment_slots` is a child; it has a field `{ name: 'appointment', type: 'relationship', relationTo: 'appointments', required: true }`.

### Cascade entry

The internal data structure that represents one child-to-parent relationship:

```typescript
type CascadeEntry = {
  collection: string  // child collection slug
  on: string          // field name on the child that holds the parent reference
}
```

### Cascade map

Built at startup (config time). Maps each **parent** slug to the list of cascade entries that should be executed when that parent is deleted.

```
parentSlug -> CascadeEntry[]
```

### Active collection

A collection that the plugin has been configured to scan. Controlled by the `collections` option. Only active collections are scanned for qualifying fields.

---

## Field qualification rules

A relationship field on a child collection qualifies for cascade registration **only if all of the following are true**:

| Condition | Reason |
|---|---|
| `field.type === 'relationship'` | Must be a relationship field |
| `field.required === true` | Optional relationships do not imply parent ownership |
| `field.hasMany !== true` | 1-N relationships are not yet supported (see TODOs) |
| `!Array.isArray(field.relationTo)` | Polymorphic relationships are not yet supported (see TODOs) |

Only **top-level** fields are scanned. Nested fields inside `group`, `tab`, `array`, or `blocks` are not traversed (see TODOs).

---

## Plugin lifecycle

```
buildConfig() is called
  Payload validates the incoming config
  Plugins execute (our plugin runs here)
    cascadeDelete(options)(incomingConfig)
      1. Reads collections option to determine which are active
      2. Iterates active collections, finds qualifying fields
      3. Builds cascadeMap (parentSlug -> CascadeEntry[])
      4. Maps over ALL collections, injecting beforeDelete hook where cascadeMap has entries
      5. Returns modified config
  Payload merges defaults
  Payload sanitizes and initializes

Later, when payload.delete({ collection: 'appointments', id, req }) is called:
  Payload starts transaction (if not already in one)
  beforeDelete hooks fire, including the cascade hook injected by this plugin
    Hook throws if req.transactionID is missing
    For each CascadeEntry: payload.delete({ collection, where: { [on]: { equals: id } }, req })
    Throws on any error; Payload rolls back the transaction
  The parent document is deleted
  afterDelete hooks fire
  Transaction commits
```

---

## Architecture

```
src/
  types.ts         CascadeDeleteOptions (exported for consumers to use in their own type annotations)
  index.ts         all plugin logic:
                     isRelationshipField()               type guard
                     getRequiredSingleRelationFields()   field filter
                     buildCascadeHook()                  creates the beforeDelete hook closure
                     cascadeDelete()                     the plugin itself (exported)

tests/
  plugin.test.ts   pure unit tests, no Payload instance or database required
                   covers: config transformation and hook behaviour
```

The plugin is intentionally **a single source file** (`src/index.ts`). There is no runtime code beyond the hook itself. Do not split this into multiple files unless the complexity genuinely demands it.

---

## Key design decisions

### Why scan fields on the child, not the parent?

The relationship field (`relationTo: 'appointments'`) lives on the **child** collection, not the parent. The parent (`appointments`) has no knowledge of who references it. So we scan children to discover which parents need hooks.

### Why inject the hook on the parent, not the child?

The cascade delete must run when the **parent** is deleted, before it disappears. That is a `beforeDelete` hook on the parent collection.

### Why one hook per parent (not one per cascade entry)?

Grouping all cascade entries for a given parent into a single hook minimises the hook array length and makes the execution model predictable. A parent with three child collections gets exactly one extra hook.

### Why throw on missing transactionID?

A cascade delete that runs without a transaction is dangerous: if child deletes succeed but the parent delete later fails (or vice versa), the database is left in a partially-deleted state with no way to recover. Refusing to proceed without a transaction is the safest default.

### Why not support hasMany: true?

A `hasMany` relationship on a child document means that document holds **an array of parent references**, not a single one. Deleting all children whose array contains the deleted parent ID is logically correct in some cases, but carries a high risk of accidental mass-deletes if the data model is misunderstood. This case requires explicit opt-in design and is left as a TODO.

---

## TODOs (known gaps)

These are tracked in the source with `// TODO:` comments:

1. **`hasMany: true` support**: cascade-delete children that reference the parent in a many-to-many array field. Needs a clear API design to avoid accidental mass-deletes.
2. **Polymorphic relationship support** (`relationTo: string[]`): when a child field can reference multiple parent collections, determine how to safely cascade.
3. **Nested field traversal**: scan fields inside `group`, `tab`, `array`, and `blocks` field types (recursive traversal of the field tree).

When implementing a TODO, write tests first. All existing tests must continue to pass.

---

## Testing approach

Tests are in `tests/plugin.test.ts` using **Vitest**. They are pure unit tests:

- No database required
- No running Payload instance required
- The Payload `Config` type is used as a structural type, not a live object

Two test categories:

1. **Config transformation**: verify that the plugin produces the correct modified config (hooks injected on correct collections, not on others, existing hooks preserved, etc.)
2. **Hook behaviour**: extract the injected hook and call it directly with a mocked `req`/`payload`, verifying it calls `payload.delete()` with the right args, throws on missing transaction, and throws on delete errors.

Helper pattern:

```typescript
function getCascadeHook(config, parentSlug) {
  // returns the last beforeDelete hook; the cascade hook is always appended last
}
```

---

## Commands

```bash
npm test            # run all tests (vitest run)
npm run test:watch  # watch mode
npm run lint        # TypeScript type check (tsc --noEmit)
npm run build       # compile src/ to dist/ (types + JS via SWC)
npm run clean       # remove dist/
```

---

## Publishing

The package targets npm as `payload-cascade-delete`.

- `"type": "module"`: ESM only
- `"exports"` maps `.` to `dist/index.js` with types
- `"files": ["dist"]`: only compiled output is published
- `prepublishOnly` runs `clean && build` automatically

To publish a new version:

```bash
npm version patch   # or minor / major
npm publish
```

---

## Payload version compatibility

| Plugin version | Payload version |
|---|---|
| `0.x` | `^3.0.0` |

When Payload releases a major version, check for breaking changes in:

- `CollectionBeforeDeleteHook` signature
- `payload.delete()` return type (specifically `errors`)
- `req.transactionID` availability
- `Plugin` type signature (`(incomingConfig: Config): Config`)

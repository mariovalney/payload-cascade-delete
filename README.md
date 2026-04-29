# payload-cascade-delete

A [Payload CMS](https://payloadcms.com) plugin that implements **lifecycle-safe cascade deletes** for collection relationships.

## Motivation

Database-level `ON DELETE CASCADE` rules are opaque and bypass Payload's hook system entirely. This means:

- `beforeDelete` / `afterDelete` hooks on child documents are never fired.
- Access control is not enforced for the deleted children.
- Audit trails, search index cleanup, and any other hook-driven side effects are silently skipped.

`payload-cascade-delete` solves this by inspecting your collection relationship fields at startup and automatically injecting `beforeDelete` hooks into every **parent** collection. Each hook runs inside the existing transaction, so any failure rolls back the entire operation — no orphaned documents, no partial deletes.

## Installation

```bash
npm install payload-cascade-delete
# or
yarn add payload-cascade-delete
# or
pnpm add payload-cascade-delete
```

## Usage

### Watch specific collections

```typescript
// payload.config.ts
import { cascadeDelete } from 'payload-cascade-delete'

export default buildConfig({
  plugins: [
    cascadeDelete({
      collections: {
        appointment_slots: true,
      },
    }),
  ],
  // ...
})
```

### Watch all collections

```typescript
plugins: [
  cascadeDelete({ collections: true }),
],
```

## How it works

At config time the plugin:

1. Iterates over every **active** collection (controlled by the `collections` option).
2. Finds fields of `type: "relationship"` that are **`required: true`** and **not** `hasMany`.
3. For each such field, registers the collection that owns the field (`relationTo`) as a **parent**.
4. Injects a single `beforeDelete` hook into each parent collection.

At delete time, when a parent document is deleted, the injected hook:

1. Asserts that a transaction is present — if not, throws immediately to prevent partial deletes.
2. Calls `payload.delete()` for every child collection with a `where` filter matching the parent ID on the relationship field name.
3. Throws on any delete error, letting Payload roll back the transaction automatically.

### Example

Given these collections:

```typescript
// appointments collection
{
  slug: 'appointments',
  fields: [{ name: 'title', type: 'text' }],
}

// appointment_slots collection
{
  slug: 'appointment_slots',
  fields: [
    {
      name: 'appointment',  // field name used as the where-filter key
      type: 'relationship',
      relationTo: 'appointments',
      required: true,       // required → cascade is registered
    },
  ],
}
```

With `cascadeDelete({ collections: { appointment_slots: true } })`, deleting an `appointments` document will automatically delete all `appointment_slots` where `appointment === <deletedId>`.

## Configuration

| Option | Type | Description |
|---|---|---|
| `collections` | `true \| Record<string, boolean>` | `true` = watch all collections. Object = map of slug → `true`/`false`. |

## Limitations & future work

- **`hasMany: true`** fields are intentionally skipped. Cascade-deleting across 1-N relations requires additional design to avoid accidental mass-deletes when a document is shared across multiple parents. This is tracked as a TODO in the source.
- **Polymorphic relationships** (`relationTo: string[]`) are skipped because the parent identity is ambiguous at field-scan time.
- **Nested fields** (inside groups, tabs, or arrays) are not yet traversed. Only top-level fields are considered.

## Composability

The plugin **appends** its `beforeDelete` hook to any hooks already defined on the collection. Existing hooks are never removed or reordered.

## License

MIT

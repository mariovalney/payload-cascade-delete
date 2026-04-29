# [Draft] Payload Cascade Delete

> **This plugin is an AI-generated draft.**
> The content / code has not yet been reviewed by a human and may contain inaccuracies or incomplete features / information and bugs.

A [Payload CMS v3](https://payloadcms.com) plugin that implements **lifecycle-safe cascade deletes** driven by your collection relationship fields, with no database-level rules and no bypassed hooks.

## Table of contents

- [Why not `ON DELETE CASCADE`?](#why-not-on-delete-cascade)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Configuration reference](#configuration-reference)
- [Full example](#full-example)
- [TypeScript types](#typescript-types)
- [Important: transactions](#important-transactions)
- [Limitations & roadmap](#limitations--roadmap)
- [Composability](#composability)
- [Contributing](#contributing)
- [License](#license)

---

## Why not `ON DELETE CASCADE`?

Database-level cascade rules (`ON DELETE CASCADE`) delete child rows **directly in the database**, completely bypassing Payload's application layer. This silently skips:

| What gets skipped | Why it matters |
|---|---|
| `beforeDelete` / `afterDelete` hooks on children | Side effects (e.g. file cleanup, search index) never run |
| Payload access control | Children are deleted regardless of permissions |
| Audit logs / activity feeds | No record that child documents were removed |
| Other plugins that hook into deletes | They are never notified |

`payload-cascade-delete` fixes this by inspecting your relationship fields at startup and injecting `beforeDelete` hooks so every delete flows through Payload's normal lifecycle, inside a transaction, with rollback on any failure.

---

## Requirements

- **Payload CMS** `^3.0.0`
- A **database adapter that supports transactions** (e.g. `@payloadcms/db-mongodb`, `@payloadcms/db-postgres`). The plugin refuses to run without an active transaction to guarantee atomicity.
- **Node.js** `>=18`

---

## Installation

```bash
npm install payload-cascade-delete
# or
yarn add payload-cascade-delete
# or
pnpm add payload-cascade-delete
```

`payload` itself is a peer dependency and is **not** bundled with this plugin.

---

## Quick start

```typescript
// payload.config.ts
import { buildConfig } from 'payload'
import { cascadeDelete } from 'payload-cascade-delete'

export default buildConfig({
  plugins: [
    // Watch every collection
    cascadeDelete({ collections: true }),
  ],
  collections: [
    // ...
  ],
})
```

Or target only specific collections:

```typescript
cascadeDelete({
  collections: {
    appointment_slots: true,   // watched
    audit_logs: false,         // ignored (same as omitting)
  },
}),
```

---

## How it works

### At startup (config time)

The plugin reads your Payload config and, for every **active** collection, looks for fields that satisfy **all** of:

1. `type: "relationship"`
2. `required: true`
3. `hasMany` is **not** `true`
4. `relationTo` is a **single** collection slug (not an array)

For each such field the child collection registers a cascade against the parent collection named in `relationTo`. The plugin then injects a single `beforeDelete` hook into every parent that has at least one registered cascade.

### At delete time

When a parent document is deleted through Payload (REST, GraphQL, Local API, or Admin UI), the injected hook runs **before** the document is removed:

1. Checks that `req.transactionID` is set. Aborts with an error if it is missing.
2. For each registered child collection, calls `payload.delete()` with a `where` filter that matches the parent's ID on the relationship field name.
3. If any child delete returns errors, throws immediately so Payload's transaction layer rolls back all changes automatically.

---

## Configuration reference

```typescript
cascadeDelete(options: CascadeDeleteOptions)
```

| Option | Type | Required | Description |
|---|---|---|---|
| `collections` | `true` | Yes | Watch **all** collections |
| `collections` | `Record<string, boolean>` | Yes | Watch only collections mapped to `true` |

### `collections: true`

Every collection in your Payload config is scanned for qualifying relationship fields. New collections added later are automatically included.

```typescript
cascadeDelete({ collections: true })
```

### `collections: Record<string, boolean>`

Opt in per slug. Useful when you want precise control or are adding cascade support incrementally.

```typescript
cascadeDelete({
  collections: {
    appointment_slots: true,
    order_items: true,
    comments: true,
  },
})
```

---

## Full example

```typescript
// collections/Appointments.ts
import type { CollectionConfig } from 'payload'

export const Appointments: CollectionConfig = {
  slug: 'appointments',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'date',  type: 'date', required: true },
  ],
}
```

```typescript
// collections/AppointmentSlots.ts
import type { CollectionConfig } from 'payload'

export const AppointmentSlots: CollectionConfig = {
  slug: 'appointment_slots',
  fields: [
    {
      name: 'appointment',       // used as the where-filter key
      type: 'relationship',
      relationTo: 'appointments',
      required: true,            // required = cascade is registered
    },
    { name: 'startTime', type: 'date', required: true },
    { name: 'endTime',   type: 'date', required: true },
  ],
}
```

```typescript
// payload.config.ts
import { buildConfig } from 'payload'
import { cascadeDelete } from 'payload-cascade-delete'
import { Appointments } from './collections/Appointments'
import { AppointmentSlots } from './collections/AppointmentSlots'

export default buildConfig({
  collections: [Appointments, AppointmentSlots],
  plugins: [
    cascadeDelete({
      collections: {
        appointment_slots: true,
      },
    }),
  ],
})
```

**Result:** deleting an `appointments` document will first delete all `appointment_slots` where `appointment === <id>`, inside the same transaction. If any slot fails to delete, the entire operation is rolled back and the appointment is preserved.

---

## TypeScript types

```typescript
import type { CascadeDeleteOptions } from 'payload-cascade-delete'
```

```typescript
type CascadeDeleteOptions = {
  /**
   * Which collections to observe for cascade delete.
   *
   * - `true`: observe all collections.
   * - Record: map of collection slug to `true` to enable, `false` or omitted to skip.
   */
  collections: true | Partial<Record<string, boolean>>
}
```

---

## Important: transactions

This plugin **requires** Payload to run deletes inside a transaction. Payload wraps Local API `delete` calls in a transaction automatically when using a supported database adapter.

If you call `payload.delete()` manually and pass a `req` without a transaction, the plugin will throw:

```
[CascadeDelete] No transaction found. Aborting to prevent partial deletes.
```

To fix this, ensure you start a transaction before calling delete:

```typescript
const req = await createLocalReq({}, payload)
req.transactionID = await payload.db.beginTransaction()

await payload.delete({ collection: 'appointments', id, req })
```

> When deleting through the REST API, GraphQL, or the Admin UI, Payload handles transactions automatically. The manual case above only applies to custom scripts.

---

## Limitations & roadmap

### `hasMany: true` (1-N): not yet supported

When a relationship field uses `hasMany: true`, a single child document can reference **multiple** parents. Cascade-deleting on this kind of field could unintentionally delete documents that are still referenced by other parents. This case needs extra design and is tracked as a TODO in the source.

### Polymorphic relationships (`relationTo: string[]`): not yet supported

When `relationTo` is an array, the parent could be any one of several collections. The cascade direction is ambiguous and is not yet handled.

### Nested fields: not yet supported

Fields inside `group`, `tab`, `array`, or `blocks` are not currently scanned. Only top-level fields on a collection are considered.

---

## Composability

The plugin **appends** its hook to any `beforeDelete` hooks already defined on the collection. It never overwrites or reorders existing hooks.

```typescript
// Both hooks will run: existing first, cascade second
{
  slug: 'appointments',
  hooks: {
    beforeDelete: [yourExistingHook],  // preserved
  },
}
```

Multiple plugins and collections can be combined freely.

---

## Contributing

```bash
git clone https://github.com/mariovalney/payload-cascade-delete
cd payload-cascade-delete
npm install
npm test          # run unit tests
npm run lint      # type check
npm run build     # compile to dist/
```

Tests live in `tests/plugin.test.ts` and use [Vitest](https://vitest.dev). They are pure unit tests with no database or running Payload instance required.

---

## License

MIT

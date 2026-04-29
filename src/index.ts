import type {
  CollectionBeforeDeleteHook,
  CollectionSlug,
  Config,
  Field,
  Plugin,
  RelationshipField,
} from 'payload'

import type { CascadeDeleteOptions } from './types.js'

type CascadeEntry = {
  /** Slug of the child collection whose documents should be cascade-deleted */
  collection: string
  /** Field name on the child collection that holds the reference to the parent */
  on: string
}

function isRelationshipField(field: Field): field is RelationshipField {
  return field.type === 'relationship'
}

/**
 * Returns top-level required, single-relation fields from a field list.
 *
 * Skipped cases (documented as TODO for future support):
 *   - hasMany: true  → 1-N relationships need extra care to avoid unintended mass-deletes
 *   - relationTo: string[]  → polymorphic relations have ambiguous parent identity
 *   - nested fields (inside groups, tabs, arrays) → not yet traversed
 */
function getRequiredSingleRelationFields(fields: Field[]): RelationshipField[] {
  return fields.filter((field): field is RelationshipField => {
    if (!isRelationshipField(field)) return false
    if (!field.required) return false

    // TODO: implement cascade support for hasMany: true (1-N relationships)
    if (field.hasMany === true) return false

    // TODO: implement cascade support for polymorphic (multi-collection) relationships
    if (Array.isArray(field.relationTo)) return false

    return true
  })
}

function buildCascadeHook(cascades: CascadeEntry[]): CollectionBeforeDeleteHook {
  return async ({ req, id }) => {
    const { payload, transactionID } = req

    if (!transactionID) {
      throw new Error(
        '[CascadeDelete] No transaction found. Aborting to prevent partial deletes.',
      )
    }

    for (const { collection, on } of cascades) {
      const { errors } = await payload.delete({
        collection: collection as CollectionSlug,
        where: { [on]: { equals: id } },
        req,
      })

      if (errors && errors.length > 0) {
        throw new Error(
          errors[0]?.message ?? '[CascadeDelete] Error during cascade delete.',
        )
      }
    }
  }
}

export const cascadeDelete =
  (options: CascadeDeleteOptions): Plugin =>
  (incomingConfig: Config): Config => {
    const { collections: collectionsOption } = options

    const isActive = (slug: string): boolean => {
      if (collectionsOption === true) return true
      return collectionsOption[slug] === true
    }

    // Build a map: parentCollectionSlug → CascadeEntry[]
    // Each active child collection contributes entries for the parent(s) it points at.
    const cascadeMap = new Map<string, CascadeEntry[]>()

    for (const collection of incomingConfig.collections ?? []) {
      if (!isActive(collection.slug)) continue

      const relFields = getRequiredSingleRelationFields(collection.fields)

      for (const field of relFields) {
        const parentSlug = field.relationTo as string
        const entry: CascadeEntry = { collection: collection.slug, on: field.name }
        const existing = cascadeMap.get(parentSlug) ?? []
        cascadeMap.set(parentSlug, [...existing, entry])
      }
    }

    if (cascadeMap.size === 0) {
      return incomingConfig
    }

    return {
      ...incomingConfig,
      collections: (incomingConfig.collections ?? []).map((collection) => {
        const cascades = cascadeMap.get(collection.slug)
        if (!cascades || cascades.length === 0) return collection

        return {
          ...collection,
          hooks: {
            ...collection.hooks,
            // Append the cascade hook — existing beforeDelete hooks are preserved.
            beforeDelete: [
              ...(collection.hooks?.beforeDelete ?? []),
              buildCascadeHook(cascades),
            ],
          },
        }
      }),
    }
  }

export type { CascadeDeleteOptions } from './types.js'

import type { CollectionBeforeDeleteHook, Config } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { cascadeDelete } from '../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** Builds the minimal Config shape the plugin needs */
function makeConfig(overrides: DeepPartial<Config> = {}): Config {
  return {
    collections: [],
    ...overrides,
  } as unknown as Config
}

function makeReq(transactionID?: string) {
  return {
    transactionID,
    payload: {
      delete: vi.fn().mockResolvedValue({ docs: [], errors: [] }),
    },
  }
}

/** Extracts the cascade hook injected by the plugin for a given parent slug */
function getCascadeHook(config: Config, parentSlug: string): CollectionBeforeDeleteHook {
  const parent = config.collections?.find((c) => c.slug === parentSlug)
  const hooks = parent?.hooks?.beforeDelete ?? []
  if (hooks.length === 0) throw new Error(`No beforeDelete hook found on '${parentSlug}'`)
  return hooks[hooks.length - 1]!
}

// ---------------------------------------------------------------------------
// Config transformation tests
// ---------------------------------------------------------------------------

describe('cascadeDelete plugin: config transformation', () => {
  it('returns config unchanged when cascadeMap is empty', () => {
    const config = makeConfig({
      collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
    })
    const result = cascadeDelete({ collections: { posts: false } })(config)
    expect(result.collections).toEqual(config.collections)
  })

  it('adds a beforeDelete hook to the parent collection', () => {
    const config = makeConfig({
      collections: [
        { slug: 'appointments', fields: [] },
        {
          slug: 'appointment_slots',
          fields: [
            {
              name: 'appointment',
              type: 'relationship',
              relationTo: 'appointments',
              required: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const parent = result.collections?.find((c) => c.slug === 'appointments')
    expect(parent?.hooks?.beforeDelete).toHaveLength(1)
  })

  it('does NOT add a hook when the relationship field is not required', () => {
    const config = makeConfig({
      collections: [
        { slug: 'authors', fields: [] },
        {
          slug: 'posts',
          fields: [
            {
              name: 'author',
              type: 'relationship',
              relationTo: 'authors',
              // required omitted; this is an optional relationship
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const parent = result.collections?.find((c) => c.slug === 'authors')
    expect(parent?.hooks?.beforeDelete ?? []).toHaveLength(0)
  })

  it('does NOT add a hook when hasMany is true (1-N, not yet supported)', () => {
    const config = makeConfig({
      collections: [
        { slug: 'categories', fields: [] },
        {
          slug: 'posts',
          fields: [
            {
              name: 'categories',
              type: 'relationship',
              relationTo: 'categories',
              required: true,
              hasMany: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const parent = result.collections?.find((c) => c.slug === 'categories')
    expect(parent?.hooks?.beforeDelete ?? []).toHaveLength(0)
  })

  it('does NOT add a hook for polymorphic relationships (relationTo is array)', () => {
    const config = makeConfig({
      collections: [
        { slug: 'pages', fields: [] },
        {
          slug: 'blocks',
          fields: [
            {
              name: 'page',
              type: 'relationship',
              relationTo: ['pages', 'posts'],
              required: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const parent = result.collections?.find((c) => c.slug === 'pages')
    expect(parent?.hooks?.beforeDelete ?? []).toHaveLength(0)
  })

  it('skips a collection when listed as false in the config map', () => {
    const config = makeConfig({
      collections: [
        { slug: 'events', fields: [] },
        {
          slug: 'tickets',
          fields: [
            {
              name: 'event',
              type: 'relationship',
              relationTo: 'events',
              required: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: { tickets: false } })(config)
    const parent = result.collections?.find((c) => c.slug === 'events')
    expect(parent?.hooks?.beforeDelete ?? []).toHaveLength(0)
  })

  it('only activates collections listed as true in the config map', () => {
    const config = makeConfig({
      collections: [
        { slug: 'events', fields: [] },
        { slug: 'venues', fields: [] },
        {
          slug: 'tickets',
          fields: [
            { name: 'event', type: 'relationship', relationTo: 'events', required: true },
          ],
        },
        {
          slug: 'bookings',
          fields: [
            { name: 'venue', type: 'relationship', relationTo: 'venues', required: true },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: { tickets: true } })(config)

    const events = result.collections?.find((c) => c.slug === 'events')
    const venues = result.collections?.find((c) => c.slug === 'venues')
    expect(events?.hooks?.beforeDelete).toHaveLength(1)
    expect(venues?.hooks?.beforeDelete ?? []).toHaveLength(0)
  })

  it('appends the cascade hook without removing existing beforeDelete hooks', () => {
    const existingHook: CollectionBeforeDeleteHook = vi.fn()

    const config = makeConfig({
      collections: [
        {
          slug: 'appointments',
          fields: [],
          hooks: { beforeDelete: [existingHook] },
        },
        {
          slug: 'appointment_slots',
          fields: [
            {
              name: 'appointment',
              type: 'relationship',
              relationTo: 'appointments',
              required: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const parent = result.collections?.find((c) => c.slug === 'appointments')
    expect(parent?.hooks?.beforeDelete).toHaveLength(2)
    expect(parent?.hooks?.beforeDelete?.[0]).toBe(existingHook)
  })

  it('adds one hook per parent even when multiple children reference it', () => {
    const config = makeConfig({
      collections: [
        { slug: 'users', fields: [] },
        {
          slug: 'posts',
          fields: [{ name: 'author', type: 'relationship', relationTo: 'users', required: true }],
        },
        {
          slug: 'comments',
          fields: [{ name: 'author', type: 'relationship', relationTo: 'users', required: true }],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const users = result.collections?.find((c) => c.slug === 'users')
    // A single hook handles all cascades for the parent
    expect(users?.hooks?.beforeDelete).toHaveLength(1)
  })

  it('does not add hooks to child collections themselves', () => {
    const config = makeConfig({
      collections: [
        { slug: 'appointments', fields: [] },
        {
          slug: 'appointment_slots',
          fields: [
            {
              name: 'appointment',
              type: 'relationship',
              relationTo: 'appointments',
              required: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const child = result.collections?.find((c) => c.slug === 'appointment_slots')
    expect(child?.hooks?.beforeDelete ?? []).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Hook behaviour tests
// ---------------------------------------------------------------------------

describe('cascadeDelete plugin: hook behaviour', () => {
  it('throws when req.transactionID is missing', async () => {
    const config = makeConfig({
      collections: [
        { slug: 'appointments', fields: [] },
        {
          slug: 'appointment_slots',
          fields: [
            {
              name: 'appointment',
              type: 'relationship',
              relationTo: 'appointments',
              required: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const hook = getCascadeHook(result, 'appointments')
    const req = makeReq(/* no transactionID */)

    await expect(
      hook({ req: req as never, id: '123', collection: undefined as never }),
    ).rejects.toThrow('[CascadeDelete] No transaction found')
  })

  it('calls payload.delete with the correct collection and where filter', async () => {
    const config = makeConfig({
      collections: [
        { slug: 'appointments', fields: [] },
        {
          slug: 'appointment_slots',
          fields: [
            {
              name: 'appointment',
              type: 'relationship',
              relationTo: 'appointments',
              required: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const hook = getCascadeHook(result, 'appointments')
    const req = makeReq('tx-abc')

    await hook({ req: req as never, id: 'appt-1', collection: undefined as never })

    expect(req.payload.delete).toHaveBeenCalledOnce()
    expect(req.payload.delete).toHaveBeenCalledWith({
      collection: 'appointment_slots',
      where: { appointment: { equals: 'appt-1' } },
      req,
    })
  })

  it('handles multiple child collections with a single hook call per cascade', async () => {
    const config = makeConfig({
      collections: [
        { slug: 'users', fields: [] },
        {
          slug: 'posts',
          fields: [{ name: 'author', type: 'relationship', relationTo: 'users', required: true }],
        },
        {
          slug: 'comments',
          fields: [{ name: 'author', type: 'relationship', relationTo: 'users', required: true }],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const hook = getCascadeHook(result, 'users')
    const req = makeReq('tx-xyz')

    await hook({ req: req as never, id: 'user-1', collection: undefined as never })

    expect(req.payload.delete).toHaveBeenCalledTimes(2)
    expect(req.payload.delete).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'posts', where: { author: { equals: 'user-1' } } }),
    )
    expect(req.payload.delete).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'comments', where: { author: { equals: 'user-1' } } }),
    )
  })

  it('throws when payload.delete returns errors', async () => {
    const config = makeConfig({
      collections: [
        { slug: 'appointments', fields: [] },
        {
          slug: 'appointment_slots',
          fields: [
            {
              name: 'appointment',
              type: 'relationship',
              relationTo: 'appointments',
              required: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const hook = getCascadeHook(result, 'appointments')
    const req = makeReq('tx-err')
    req.payload.delete = vi
      .fn()
      .mockResolvedValue({ errors: [{ message: 'Delete failed' }] })

    await expect(
      hook({ req: req as never, id: 'appt-2', collection: undefined as never }),
    ).rejects.toThrow('Delete failed')
  })

  it('throws with a fallback message when delete error has no message', async () => {
    const config = makeConfig({
      collections: [
        { slug: 'appointments', fields: [] },
        {
          slug: 'appointment_slots',
          fields: [
            {
              name: 'appointment',
              type: 'relationship',
              relationTo: 'appointments',
              required: true,
            },
          ],
        },
      ],
    })

    const result = cascadeDelete({ collections: true })(config)
    const hook = getCascadeHook(result, 'appointments')
    const req = makeReq('tx-err2')
    req.payload.delete = vi.fn().mockResolvedValue({ errors: [{}] })

    await expect(
      hook({ req: req as never, id: 'appt-3', collection: undefined as never }),
    ).rejects.toThrow('[CascadeDelete] Error during cascade delete.')
  })
})

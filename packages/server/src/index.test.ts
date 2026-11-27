import { describe, expect, it } from 'vitest'
import { PACKAGE as db } from '../../db/src/index'
import { PACKAGE as react } from '../../react/src/index'
import { PACKAGE } from './index'

describe('workspace', () => {
  it('builds and links all three packages', () => {
    expect([PACKAGE, react, db]).toEqual(['@teovo/server', '@teovo/react', '@teovo/db'])
  })
})

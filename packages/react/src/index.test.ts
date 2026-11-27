import { expect, it } from 'vitest'
import { PACKAGE } from './index'

it('exports its name until the panel lands', () => expect(PACKAGE).toBe('@teovo/react'))
